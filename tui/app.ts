// app.ts — TUIApp: owns bridge, tick loop, screen state

import type { ISLBridge, WritableTarget } from './types.js';
import type { GridFrame, ChatBubble, RenderMode } from '../server/grid-state.js';
import { projectFrame, projectFirstPerson, diffFrames } from '../server/grid-state.js';
import { computeLayout, type ScreenLayout } from './screen.js';
import {
  enterAltScreen, exitAltScreen, hideCursor, showCursor,
  renderStatusBar, renderSeparator,
  renderChatLines, renderInputLine, renderFpView, renderMinimap,
  renderFpViewBuf, renderFpDeltaBuf, renderMinimapBuf, renderStatusBarBuf,
} from './renderer.js';
import { InputHandler, type Mode } from './input.js';
import { ChatBuffer } from './chat-buffer.js';
import {
  createLoginState, renderLoginScreen, renderLoadingScreen, nextField,
  loginFieldAppend, loginFieldBackspace, type LoginState,
} from './login-screen.js';
import { MenuPanel } from './menu.js';

export interface TUIAppOptions {
  bridge: ISLBridge;
  output: WritableTarget;
  stdin?: NodeJS.ReadStream;
  autoLogin?: { firstName: string; lastName: string; password: string };
  createBridge?: () => ISLBridge;
  onLoginSuccess?: (firstName: string, lastName: string, password: string) => void;
  onLogout?: () => void;
}

export class TUIApp {
  private bridge: ISLBridge;
  private output: WritableTarget;
  private stdin: NodeJS.ReadStream | null;
  private mode: Mode = 'login';
  private prevFrame: GridFrame | null = null;
  private prevFpFrame: GridFrame | null = null;
  private chatBuffer = new ChatBuffer();
  private chatInput = '';
  private layout: ScreenLayout;
  private loginState: LoginState;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private inputHandler: InputHandler;
  private running = false;
  private destroyed = false;
  private regionName = '';
  private loginPending = false;
  private lastStatusStr = '';
  private ditherEnabled = false;
  private ditherPhase = 0;
  private renderMode: RenderMode = 'voxel';
  private chatBubbles = new Map<string, ChatBubble>();
  private menu: MenuPanel;
  private autoLogin?: { firstName: string; lastName: string; password: string };
  private createBridge?: () => ISLBridge;
  private onLoginSuccess?: (firstName: string, lastName: string, password: string) => void;
  private onLogout?: () => void;

  constructor(opts: TUIAppOptions) {
    this.bridge = opts.bridge;
    this.output = opts.output;
    this.stdin = opts.stdin ?? null;
    this.autoLogin = opts.autoLogin;
    this.createBridge = opts.createBridge;
    this.onLoginSuccess = opts.onLoginSuccess;
    this.onLogout = opts.onLogout;
    this.layout = computeLayout(opts.output.columns, opts.output.rows);
    this.loginState = createLoginState();

    this.menu = new MenuPanel({
      sendIM: async (toUuid, message) => { await this.bridge.sendIM(toUuid, message); },
      flyToAvatar: (uuid) => { this.bridge.flyToAvatar(uuid); },
      getProfile: (uuid) => this.bridge.getProfile(uuid),
      getFriendsList: async () => {
        const list = await this.bridge.getFriendsList();
        return list.map(f => ({ uuid: f.uuid, name: f.name, online: f.online }));
      },
      teleportHome: async () => {
        await this.bridge.teleportHome();
        this.prevFrame = null;
        this.prevFpFrame = null;
      },
      teleportRegion: async (region, x, y, z) => {
        try {
          await this.bridge.teleportToRegion(region, x, y, z);
          this.regionName = this.bridge.getRegionName();
          this.prevFrame = null;
          this.prevFpFrame = null;
          this.chatBuffer.addSystem(`Arrived at ${this.regionName}`);
        } catch (err: any) {
          this.chatBuffer.addSystem(`Teleport failed: ${err.message || err}`);
        }
        this.renderChat();
      },
      stand: () => { this.bridge.stand(); },
      closeMenu: () => { this.closeMenu(); },
      systemMessage: (msg) => { this.chatBuffer.addSystem(msg); this.renderChat(); },
    });

    this.inputHandler = new InputHandler({
      onMove: (dir) => this.bridge.move(dir),
      onStop: () => this.bridge.stop(),
      onTurnLeft: () => this.bridge.turn('left'),
      onTurnRight: () => this.bridge.turn('right'),
      onToggleDither: () => {
        this.ditherEnabled = !this.ditherEnabled;
        if (!this.ditherEnabled) this.ditherPhase = 0;
        this.chatBuffer.addSystem(`Dither ${this.ditherEnabled ? 'ON' : 'OFF'}`);
        this.renderChat();
      },
      onToggleRenderMode: () => {
        this.renderMode = this.renderMode === 'voxel' ? 'triangle' : 'voxel';
        this.prevFpFrame = null; // force full redraw
        this.chatBuffer.addSystem(`Render: ${this.renderMode}`);
        this.renderChat();
      },
      onToggleFly: () => {
        this.bridge.setFlying(!this.bridge.flying);
        this.renderStatus();
      },
      onEnterChat: () => {
        this.mode = 'chat-input';
        this.chatInput = '';
        this.inputHandler.setMode('chat-input');
        showCursor(this.output);
        this.renderInputBar();
      },
      onExitChat: () => {
        this.mode = 'grid';
        this.chatInput = '';
        this.inputHandler.setMode('grid');
        hideCursor(this.output);
        this.renderInputBar();
      },
      onChatSubmit: () => {
        if (this.chatInput.trim()) {
          this.handleChatCommand(this.chatInput.trim());
        }
        this.chatInput = '';
        this.mode = 'grid';
        this.inputHandler.setMode('grid');
        hideCursor(this.output);
        this.renderInputBar();
      },
      onChatChar: (ch) => {
        this.chatInput += ch;
        this.renderInputBar();
      },
      onChatBackspace: () => {
        this.chatInput = this.chatInput.slice(0, -1);
        this.renderInputBar();
      },
      onQuit: () => this.destroy(),
      onOpenMenu: () => {
        this.mode = 'menu';
        this.inputHandler.setMode('menu');
        this.menu.open();
        this.renderInputBar();
      },
      onMenuKey: (str, key) => {
        const stayOpen = this.menu.handleKey(str, key);
        if (!stayOpen) {
          this.closeMenu();
        }
        this.renderInputBar();
      },
      onLoginChar: (ch) => {
        loginFieldAppend(this.loginState, ch);
        renderLoginScreen(this.output, this.loginState);
      },
      onLoginBackspace: () => {
        loginFieldBackspace(this.loginState);
        renderLoginScreen(this.output, this.loginState);
      },
      onLoginSubmit: () => this.attemptLogin(),
      onLoginTab: () => {
        nextField(this.loginState);
        renderLoginScreen(this.output, this.loginState);
      },
    });
  }

  async start(): Promise<void> {
    this.running = true;
    enterAltScreen(this.output);

    if (this.stdin) {
      this.inputHandler.start(this.stdin);
    }

    if (this.autoLogin) {
      // Pre-fill fields but don't auto-login — user must press Enter
      this.loginState.firstName = this.autoLogin.firstName;
      this.loginState.lastName = this.autoLogin.lastName;
      this.loginState.password = this.autoLogin.password;
    }
    this.inputHandler.setMode('login');
    renderLoginScreen(this.output, this.loginState);
  }

  private async attemptLogin(): Promise<void> {
    if (this.loginPending) return; // guard against double-login

    const { firstName, lastName, password } = this.loginState;
    if (!firstName || !password) {
      this.loginState.error = 'First name and password required';
      renderLoginScreen(this.output, this.loginState);
      return;
    }

    this.loginPending = true;

    // Show loading screen immediately
    renderLoadingScreen(this.output);

    try {
      const result = await this.bridge.login(
        firstName,
        lastName || 'Resident',
        password,
        {
          onChat: (from, message, chatType, fromId) => {
            this.chatBuffer.add(from, message);
            this.renderChat();
            if (fromId) {
              this.chatBubbles.set(fromId, { message, ts: Date.now() });
            }
          },
          onIM: (from, fromName, message) => {
            this.chatBuffer.add(`[IM] ${fromName}`, message);
            this.menu.addIM(from, fromName, message, false);
            this.renderChat();
          },
          onFriendRequest: (from, fromName, message) => {
            this.chatBuffer.addSystem(`Friend request from ${fromName}: ${message}`);
            this.renderChat();
          },
          onFriendOnline: (name, uuid, online) => {
            this.chatBuffer.addSystem(`${name} is now ${online ? 'online' : 'offline'}`);
            this.renderChat();
          },
          onTeleportOffer: (from, fromName, message) => {
            this.chatBuffer.addSystem(`Teleport offer from ${fromName}: ${message}`);
            this.renderChat();
          },
          onDisconnected: (reason) => {
            this.chatBuffer.addSystem(`Disconnected: ${reason}`);
            this.renderChat();
          },
        }
      );

      this.regionName = result.region;
      this.onLoginSuccess?.(firstName, lastName || 'Resident', password);

      // Region crossing detection
      this.bridge.onRegionChange(() => {
        this.prevFrame = null;
        this.prevFpFrame = null;
        this.regionName = this.bridge.getRegionName();
        this.chatBuffer.addSystem(`Entered region: ${this.regionName}`);
        this.renderChat();
      });

      this.enterGridMode();
    } catch (err: any) {
      this.loginState.error = `Login failed: ${err.message || err}`;
      renderLoginScreen(this.output, this.loginState);
    } finally {
      this.loginPending = false;
    }
  }

  private enterGridMode(): void {
    this.mode = 'grid';
    this.inputHandler.setMode('grid');
    hideCursor(this.output);

    // Full initial render
    this.renderFull();

    // Start tick loop — 15Hz for smooth interpolation
    this.tickInterval = setInterval(() => this.tick(), 66);
  }

  tick(): void {
    if (this.mode === 'login' || this.destroyed) return;

    const pos = this.bridge.getPosition();
    if (!pos) return;

    const avatars = this.bridge.getAvatars();
    const objects = this.bridge.getObjects();
    const waterHeight = this.bridge.getWaterHeight();
    const terrainFn = (x: number, y: number) => this.bridge.getTerrainHeight(x, y);

    // Use body yaw for FP view (tracks turning)
    const selfYaw = this.bridge.getBodyYaw();

    // Region crossing + autopilot + avatar mesh scan
    this.bridge.checkRegionCrossing();
    this.bridge.tickFlyTo();
    this.bridge.triggerAvatarMeshScan();

    // Prune expired chat bubbles (>10s)
    const now = Date.now();
    for (const [uuid, bubble] of this.chatBubbles) {
      if (now - bubble.ts > 10000) this.chatBubbles.delete(uuid);
    }

    // Build avatar name map for FP labels
    const avatarNameMap = new Map<string, string>();
    for (const av of avatars) {
      if (!av.isSelf) {
        avatarNameMap.set(av.uuid, `${av.firstName} ${av.lastName}`.trim());
      }
    }

    // Accumulate all output into a single buffer
    let buf = '';

    // Advance dither phase
    if (this.ditherEnabled) {
      this.ditherPhase += 0.15; // smooth flow speed
    }

    // Main view: first-person perspective (full width, full FP area)
    if (this.layout.fpRows > 0) {
      const fpFrame = projectFirstPerson(
        terrainFn,
        avatars,
        objects,
        { selfX: pos.x, selfY: pos.y, selfZ: pos.z, yaw: selfYaw, waterHeight,
          ditherPhase: this.ditherEnabled ? this.ditherPhase : undefined,
          meshLookup: (uuid: string) => this.bridge.getAvatarMeshBundle(uuid),
          avatarNames: avatarNameMap,
          chatBubbles: this.chatBubbles,
          skyColors: this.bridge.getSkyColors() ?? undefined,
          renderMode: this.renderMode },
        this.layout.fpCols,
        this.layout.fpRows,
      );

      if (this.prevFpFrame) {
        const fpDeltas = diffFrames(this.prevFpFrame, fpFrame);
        if (fpDeltas.length > 0) {
          // Delta render: only changed cells, skipping minimap region
          buf += renderFpDeltaBuf(this.layout, fpDeltas, fpFrame);
        }
      } else {
        // Full render, skipping minimap region
        buf += renderFpViewBuf(this.layout, fpFrame);
      }
      this.prevFpFrame = fpFrame;
    }

    // Minimap overlay (top-right corner) — always rendered on top
    const minimapFrame = projectFrame(
      terrainFn,
      avatars,
      objects,
      {
        cols: this.layout.minimapCols,
        rows: this.layout.minimapRows,
        selfX: pos.x,
        selfY: pos.y,
        selfZ: pos.z,
        waterHeight,
        metersPerCell: 256 / this.layout.minimapCols,
        yaw: selfYaw, // rotate minimap so up = facing direction
      },
      this.bridge.flying,
    );

    if (this.prevFrame) {
      const deltas = diffFrames(this.prevFrame, minimapFrame);
      if (deltas.length > 0) {
        buf += renderMinimapBuf(this.layout, minimapFrame);
      }
    } else {
      buf += renderMinimapBuf(this.layout, minimapFrame);
    }
    this.prevFrame = minimapFrame;

    // Menu overlay (renders over FP view when open)
    if (this.menu.isOpen) {
      buf += this.menu.render(this.layout);
    }

    // Status bar — only update when values change
    const statusStr = this.buildStatusString(pos);
    if (statusStr !== this.lastStatusStr) {
      buf += renderStatusBarBuf(this.layout, this.regionName || this.bridge.getRegionName(), pos, this.bridge.flying);
      this.lastStatusStr = statusStr;
    }

    // Single write for the entire tick
    if (buf) {
      this.output.write(buf);
    }
  }

  private renderFull(): void {
    this.output.write('\x1b[2J'); // clear
    this.renderStatus();
    this.tick(); // renders grid
    renderSeparator(this.output, this.layout);
    this.renderChat();
    this.renderInputBar();
  }

  private buildStatusString(pos: { x: number; y: number; z: number }): string {
    const region = this.regionName || this.bridge.getRegionName();
    return `${region}|${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}|${this.bridge.flying}`;
  }

  private renderStatus(): void {
    const pos = this.bridge.getPosition();
    renderStatusBar(
      this.output,
      this.layout,
      this.regionName || this.bridge.getRegionName(),
      pos,
      this.bridge.flying,
    );
  }

  private renderChat(): void {
    const lines = this.chatBuffer.getVisibleLines(this.layout.chatLines);
    renderChatLines(this.output, this.layout, lines);
  }

  private renderInputBar(): void {
    renderInputLine(this.output, this.layout, this.mode, this.chatInput);
  }

  private closeMenu(): void {
    this.menu.close();
    this.mode = 'grid';
    this.inputHandler.setMode('grid');
    hideCursor(this.output);
    this.prevFpFrame = null; // force full redraw to clear menu artifacts
    this.renderInputBar();
  }

  private async handleChatCommand(text: string): Promise<void> {
    if (text.startsWith('/tp ')) {
      const args = text.slice(4).trim();
      const parts = args.split(/\s+/);
      const region = parts[0];
      const rawX = parts[1] ? parseInt(parts[1]) : 128;
      const rawY = parts[2] ? parseInt(parts[2]) : 128;
      const rawZ = parts[3] ? parseInt(parts[3]) : 30;
      const x = isNaN(rawX) ? 128 : rawX;
      const y = isNaN(rawY) ? 128 : rawY;
      const z = isNaN(rawZ) ? 30 : rawZ;
      this.chatBuffer.addSystem(`Teleporting to ${region}...`);
      this.renderChat();
      try {
        await this.bridge.teleportToRegion(region, x, y, z);
        this.regionName = this.bridge.getRegionName();
        this.prevFrame = null; // force full re-render
        this.prevFpFrame = null;
        this.chatBuffer.addSystem(`Arrived at ${this.regionName}`);
      } catch (err: any) {
        this.chatBuffer.addSystem(`Teleport failed: ${err.message || err}`);
      }
      this.renderChat();
    } else if (text.startsWith('/im ') || text === '/im') {
      const match = text.match(/^\/im\s+(\S+)\s+(.*)/);
      if (match) {
        await this.bridge.sendIM(match[1], match[2]);
        this.menu.addIM(match[1], match[1], match[2], true);
        this.chatBuffer.addSystem(`IM sent to ${match[1]}`);
      } else {
        this.chatBuffer.addSystem('Usage: /im <uuid> <message>');
      }
      this.renderChat();
    } else if (text === '/logout') {
      await this.logout();
      return;
    } else if (text.startsWith('/shout ')) {
      await this.bridge.shout(text.slice(7));
    } else if (text.startsWith('/whisper ')) {
      await this.bridge.whisper(text.slice(9));
    } else {
      await this.bridge.say(text);
    }
  }

  private async logout(): Promise<void> {
    // Stop tick loop
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    // Close current bridge
    try {
      await this.bridge.close();
    } catch {}

    // Create fresh bridge if factory provided
    if (this.createBridge) {
      this.bridge = this.createBridge();
    }

    // Reset state
    this.prevFrame = null;
    this.prevFpFrame = null;
    this.regionName = '';
    this.chatInput = '';
    this.chatBuffer = new ChatBuffer();
    this.chatBubbles = new Map();
    this.loginState = createLoginState();

    // Notify callback (for clearing saved credentials)
    this.onLogout?.();

    // Return to login screen
    this.mode = 'login';
    this.inputHandler.setMode('login');
    showCursor(this.output);
    renderLoginScreen(this.output, this.loginState);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return; // guard against double-destroy
    this.destroyed = true;
    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.stdin) {
      this.inputHandler.stop(this.stdin);
    }
    exitAltScreen(this.output);
    try {
      await this.bridge.close();
    } catch {}
    if (this.stdin) {
      process.exit(0);
    }
  }

  // For testing: inject a keypress
  simulateKey(str: string | undefined, key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean }): void {
    this.inputHandler.handleKey(str, key as any);
  }

  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  handleResize(cols: number, rows: number): void {
    this.layout = computeLayout(cols, rows);
    // Invalidate frames immediately so the next tick doesn't diff against old dimensions
    this.prevFrame = null;
    this.prevFpFrame = null;
    this.lastStatusStr = '';

    // Debounce the full clear+redraw: wait 150ms after last resize event
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.layout = computeLayout(cols, rows);
      this.prevFrame = null;
      this.prevFpFrame = null;
      this.lastStatusStr = '';
      // Full clear + redraw everything including separator, chat, input
      if (this.mode === 'grid' || this.mode === 'chat-input' || this.mode === 'menu') {
        this.renderFull();
      }
    }, 150);
  }

  getMode(): Mode { return this.mode; }
  getChatBuffer(): ChatBuffer { return this.chatBuffer; }
  getLayout(): ScreenLayout { return this.layout; }
  isRunning(): boolean { return this.running; }
  isDestroyed(): boolean { return this.destroyed; }
  isTickActive(): boolean { return this.tickInterval !== null; }
  getRegionName(): string { return this.regionName; }
  getChatInput(): string { return this.chatInput; }
  getPrevFrame(): GridFrame | null { return this.prevFrame; }
  isLoginPending(): boolean { return this.loginPending; }
  getMenu(): MenuPanel { return this.menu; }
}
