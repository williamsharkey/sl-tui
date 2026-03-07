// session.ts — Per-user session: owns Bot, grid-state, comms state, ws

import type { WebSocket } from 'ws';
import { SLBridge } from './sl-bridge.js';
import {
  type GridFrame, type ProjectionParams, type CellDelta,
  projectFrame, projectFirstPerson, diffFrames, createEmptyFrame,
} from './grid-state.js';

export class Session {
  readonly id: string;
  private ws: WebSocket;
  private bridge: SLBridge;
  private prevFrame: GridFrame | null = null;
  private prevFpFrame: GridFrame | null = null;
  private cols = 80;
  private rows = 40;
  private fpRows = 8; // 20% of 40
  private metersPerCell = 256 / 80;
  private statusCounter = 0;
  private muted = new Set<string>();
  private imHistory = new Map<string, { from: string; fromName: string; message: string; ts: number }[]>();

  constructor(id: string, ws: WebSocket) {
    this.id = id;
    this.ws = ws;
    this.bridge = new SLBridge();
  }

  send(data: unknown): void {
    if (this.ws.readyState === 1) { // OPEN
      this.ws.send(JSON.stringify(data));
    }
  }

  async handleMessage(raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'login':
        await this.handleLogin(msg);
        break;
      case 'move':
        this.bridge.move(msg.dir);
        break;
      case 'stop':
        this.bridge.stop();
        break;
      case 'fly':
        this.bridge.setFlying(msg.enabled);
        break;
      case 'chat':
        await this.handleChat(msg);
        break;
      case 'turn':
        this.bridge.turn(msg.dir === 'left' ? 'left' : 'right');
        break;
      case 'inspect':
        this.handleInspect(msg);
        break;
      case 'resize':
        this.cols = Math.max(20, Math.min(200, msg.cols || 80));
        this.rows = Math.max(10, Math.min(100, msg.rows || 40));
        this.fpRows = Math.max(3, Math.floor(this.rows * 0.2));
        this.metersPerCell = 256 / this.cols;
        this.prevFrame = null;
        this.prevFpFrame = null;
        break;
      case 'im':
        await this.bridge.sendIM(msg.to, msg.message);
        break;
      case 'search':
        await this.handleSearch(msg);
        break;
      case 'friend':
        await this.handleFriend(msg);
        break;
      case 'tp':
        await this.handleTeleport(msg);
        break;
      case 'profile':
        await this.handleProfile(msg);
        break;
      case 'sit':
        await this.bridge.sitOnObject(msg.target);
        break;
      case 'stand':
        this.bridge.stand();
        break;
      case 'touch':
        await this.bridge.touchObject(msg.target);
        break;
      case 'mute':
        this.muted.add(msg.target);
        break;
      case 'logout':
        await this.close();
        break;
    }
  }

  private async handleLogin(msg: any): Promise<void> {
    try {
      const username = (msg.username || '').trim();
      const password = msg.password || '';
      let firstName: string, lastName: string;

      if (username.includes(' ')) {
        const parts = username.split(' ');
        firstName = parts[0];
        lastName = parts.slice(1).join(' ');
      } else {
        firstName = username;
        lastName = 'Resident';
      }

      const result = await this.bridge.login(firstName, lastName as string, password, {
        onChat: (from, message, chatType, fromId) => {
          if (this.muted.has(fromId)) return;
          this.send({ type: 'chat', from, message, chatType });
        },
        onIM: (from, fromName, message, isGroup, groupName) => {
          if (this.muted.has(from)) return;
          // Store in history
          const history = this.imHistory.get(from) || [];
          history.push({ from, fromName, message, ts: Date.now() });
          this.imHistory.set(from, history);
          this.send({ type: 'im', from, fromName, message, isGroup, groupName });
        },
        onFriendRequest: (from, fromName, message) => {
          this.send({ type: 'friendEvent', event: 'request', name: fromName, uuid: from, message });
        },
        onFriendOnline: (name, uuid, online) => {
          this.send({ type: 'friendEvent', event: online ? 'online' : 'offline', name, uuid });
        },
        onTeleportOffer: (from, fromName, message) => {
          this.send({ type: 'tpOffer', from, fromName, message });
        },
        onDisconnected: (reason) => {
          this.send({ type: 'disconnected', reason });
        },
      });

      this.send({ type: 'connected', region: result.region, waterHeight: result.waterHeight });

      // Send initial full terrain frame
      this.sendFullFrame();

      // Start tick loop
      this.bridge.startTick(() => this.tick(), 4);
    } catch (err: any) {
      this.send({ type: 'error', message: `Login failed: ${err.message || err}` });
    }
  }

  private async handleChat(msg: any): Promise<void> {
    const text: string = msg.message || '';
    if (text.startsWith('/shout ')) {
      await this.bridge.shout(text.slice(7));
    } else if (text.startsWith('/whisper ')) {
      await this.bridge.whisper(text.slice(9));
    } else if (text.startsWith('/me ')) {
      await this.bridge.say(text); // SL handles /me natively
    } else {
      // Check for channel: /42 hello
      const chanMatch = text.match(/^\/(\d+)\s+(.+)/);
      if (chanMatch) {
        await this.bridge.say(chanMatch[2], parseInt(chanMatch[1]));
      } else {
        await this.bridge.say(text);
      }
    }
  }

  private handleInspect(msg: any): void {
    const { col, row } = msg;
    if (this.prevFrame) {
      const idx = row * this.cols + col;
      const cell = this.prevFrame.cells[idx];
      if (cell?.oid) {
        // Try avatar first, then object
        const avInfo = this.bridge.inspectAvatar(cell.oid);
        if (avInfo) {
          this.send({ type: 'tooltip', col, row, lines: [avInfo.name, avInfo.title, avInfo.position], uuid: cell.oid, kind: 'avatar' });
          return;
        }
        const objInfo = this.bridge.inspectObject(cell.oid);
        if (objInfo) {
          this.send({ type: 'tooltip', col, row, lines: [objInfo.name, objInfo.description, objInfo.position], uuid: cell.oid, kind: 'object' });
          return;
        }
      }
    }
    this.send({ type: 'tooltip', col, row, lines: [] });
  }

  private async handleSearch(msg: any): Promise<void> {
    const results = await this.bridge.searchPeople(msg.query);
    this.send({ type: 'searchResult', results });
  }

  private async handleFriend(msg: any): Promise<void> {
    switch (msg.action) {
      case 'request':
        await this.bridge.sendFriendRequest(msg.target, 'Would you like to be friends?');
        break;
      case 'accept':
        await this.bridge.acceptFriendRequest(msg.target);
        break;
      case 'decline':
        await this.bridge.declineFriendRequest(msg.target);
        break;
    }
  }

  private async handleTeleport(msg: any): Promise<void> {
    switch (msg.action) {
      case 'region':
        await this.bridge.teleportToRegion(msg.region, msg.pos?.[0], msg.pos?.[1], msg.pos?.[2]);
        break;
      case 'accept':
        await this.bridge.acceptTeleport(msg.target);
        break;
      case 'decline':
        await this.bridge.declineTeleport(msg.target);
        break;
      case 'home':
        await this.bridge.teleportHome();
        break;
    }
  }

  private async handleProfile(msg: any): Promise<void> {
    const profile = await this.bridge.getProfile(msg.target);
    if (profile) {
      this.send({ type: 'profile', uuid: msg.target, ...profile });
    }
  }

  private sendFullFrame(): void {
    const pos = this.bridge.getPosition();
    if (!pos) return;

    const params: ProjectionParams = {
      cols: this.cols,
      rows: this.rows,
      selfX: pos.x,
      selfY: pos.y,
      selfZ: pos.z,
      waterHeight: this.bridge.getWaterHeight(),
      metersPerCell: this.metersPerCell,
      yaw: this.bridge.getBodyYaw(),
    };

    const frame = projectFrame(
      (x, y) => this.bridge.getTerrainHeight(x, y),
      this.bridge.getAvatars(),
      this.bridge.getObjects(),
      params,
      this.bridge.flying,
    );

    // Send full grid
    const grid = frame.cells.map(c => [c.char, c.fg, c.oid || '']);
    this.send({ type: 'terrain', grid, cols: this.cols, rows: this.rows });
    this.prevFrame = frame;
  }

  private tick(): void {
    const pos = this.bridge.getPosition();
    if (!pos) return;

    const avatars = this.bridge.getAvatars();
    const objects = this.bridge.getObjects();
    const waterHeight = this.bridge.getWaterHeight();
    const terrainFn = (x: number, y: number) => this.bridge.getTerrainHeight(x, y);

    const params: ProjectionParams = {
      cols: this.cols,
      rows: this.rows,
      selfX: pos.x,
      selfY: pos.y,
      selfZ: pos.z,
      waterHeight,
      metersPerCell: this.metersPerCell,
      yaw: this.bridge.getBodyYaw(),
    };

    const frame = projectFrame(
      terrainFn,
      avatars,
      objects,
      params,
      this.bridge.flying,
    );

    if (this.prevFrame) {
      const deltas = diffFrames(this.prevFrame, frame);
      if (deltas.length > 0) {
        this.send({ type: 'delta', cells: deltas });
      }
    } else {
      const grid = frame.cells.map(c => [c.char, c.fg, c.oid || '']);
      this.send({ type: 'terrain', grid, cols: this.cols, rows: this.rows });
    }
    this.prevFrame = frame;

    // First-person view (main view for web client)
    const selfYaw = this.bridge.getBodyYaw();
    const fpFrame = projectFirstPerson(
      terrainFn, avatars, objects,
      { selfX: pos.x, selfY: pos.y, selfZ: pos.z, yaw: selfYaw, waterHeight },
      this.cols, this.fpRows,
    );

    if (this.prevFpFrame) {
      const fpDeltas = diffFrames(this.prevFpFrame, fpFrame);
      if (fpDeltas.length > 0) {
        this.send({ type: 'fpDelta', cells: fpDeltas });
      }
    } else {
      const fpGrid = fpFrame.cells.map(c => [c.char, c.fg, '']);
      this.send({ type: 'fpTerrain', grid: fpGrid, cols: this.cols, rows: this.fpRows });
    }
    this.prevFpFrame = fpFrame;

    // Status at 1Hz (every 4th tick)
    this.statusCounter++;
    if (this.statusCounter >= 4) {
      this.statusCounter = 0;
      this.send({
        type: 'status',
        pos: [pos.x, pos.y, pos.z],
        flying: this.bridge.flying,
        region: this.bridge.getRegionName(),
      });
    }
  }

  async close(): Promise<void> {
    await this.bridge.close();
  }
}
