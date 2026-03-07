// sl-bridge.ts — Wraps Bot: login, movement, events, 4Hz tick loop

import { Bot } from '../vendor/node-metaverse/Bot.js';
import { LoginParameters } from '../vendor/node-metaverse/classes/LoginParameters.js';
import { BotOptionFlags } from '../vendor/node-metaverse/enums/BotOptionFlags.js';
import { ControlFlags } from '../vendor/node-metaverse/enums/ControlFlags.js';
import { UUID } from '../vendor/node-metaverse/classes/UUID.js';
import { Vector3 } from '../vendor/node-metaverse/classes/Vector3.js';
import { ChatType } from '../vendor/node-metaverse/enums/ChatType.js';
import type { ChatEvent } from '../vendor/node-metaverse/events/ChatEvent.js';
import type { InstantMessageEvent } from '../vendor/node-metaverse/events/InstantMessageEvent.js';
import type { FriendRequestEvent } from '../vendor/node-metaverse/events/FriendRequestEvent.js';
import type { FriendOnlineEvent } from '../vendor/node-metaverse/events/FriendOnlineEvent.js';
import type { LureEvent } from '../vendor/node-metaverse/events/LureEvent.js';
import type { DisconnectEvent } from '../vendor/node-metaverse/events/DisconnectEvent.js';
import type { Avatar } from '../vendor/node-metaverse/classes/public/Avatar.js';
import type { GameObject } from '../vendor/node-metaverse/classes/public/GameObject.js';
import type { AvatarData, ObjectData } from './grid-state.js';
import type { Subscription } from 'rxjs';

export interface BridgeCallbacks {
  onChat: (from: string, message: string, chatType: number, fromId: string) => void;
  onIM: (from: string, fromName: string, message: string, isGroup: boolean, groupName?: string) => void;
  onFriendRequest: (from: string, fromName: string, message: string, requestId: string) => void;
  onFriendOnline: (name: string, uuid: string, online: boolean) => void;
  onTeleportOffer: (from: string, fromName: string, message: string, lureEvent: LureEvent) => void;
  onDisconnected: (reason: string) => void;
}

export class SLBridge {
  private bot: Bot | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptions: Subscription[] = [];
  private pendingFriendRequests = new Map<string, FriendRequestEvent>();
  private pendingLures = new Map<string, LureEvent>();
  private _flying = false;

  // Caches to avoid per-tick allocations and redundant work
  private _selfId: string = '';
  private _objectCache: ObjectData[] = [];
  private _objectCacheAge = 0;
  private _terrainCache = new Map<number, number>(); // (y*256+x) → height

  // Position interpolation state
  private _serverPos: { x: number; y: number; z: number } | null = null;
  private _displayPos: { x: number; y: number; z: number } | null = null;
  private _velocity: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private _lastServerUpdate = 0;
  private _lastPosTime = 0;

  async login(firstName: string, lastName: string, password: string, callbacks: BridgeCallbacks): Promise<{ region: string; waterHeight: number }> {
    const params = new LoginParameters();
    params.firstName = firstName;
    params.lastName = lastName;
    params.password = password;
    params.start = 'last';
    params.agreeToTOS = true;
    params.readCritical = true;

    this.bot = new Bot(params, BotOptionFlags.StoreMyAttachmentsOnly);

    await this.bot.login();

    // Establish UDP connection to sim (login only does XMLRPC)
    await this.bot.connectToSim();

    // Wait for event queue
    try {
      await this.bot.waitForEventQueue(10000);
    } catch {
      // Continue even if event queue times out
    }

    // Wait for terrain
    const region = this.bot.currentRegion;
    if (!region.terrainComplete) {
      await new Promise<void>((resolve) => {
        const sub = region.terrainCompleteEvent.subscribe(() => {
          sub.unsubscribe();
          resolve();
        });
        // Timeout after 15s
        setTimeout(() => resolve(), 15000);
      });
    }

    // Cache self ID (avoid toString() every tick)
    this._selfId = this.bot.agent.agentID.toString();


    // Subscribe to events
    this.subscriptions.push(
      this.bot.clientEvents.onNearbyChat.subscribe((e: ChatEvent) => {
        callbacks.onChat(e.fromName, e.message, e.chatType, e.from?.toString() ?? '');
      })
    );

    this.subscriptions.push(
      this.bot.clientEvents.onInstantMessage.subscribe((e: InstantMessageEvent) => {
        callbacks.onIM(e.from?.toString() ?? '', e.fromName, e.message, false);
      })
    );

    this.subscriptions.push(
      this.bot.clientEvents.onFriendRequest.subscribe((e: FriendRequestEvent) => {
        const id = e.from?.toString() ?? '';
        this.pendingFriendRequests.set(id, e);
        callbacks.onFriendRequest(id, e.fromName, e.message, id);
      })
    );

    this.subscriptions.push(
      this.bot.clientEvents.onFriendOnline.subscribe((e: FriendOnlineEvent) => {
        callbacks.onFriendOnline(e.name, e.uuid?.toString() ?? '', e.online);
      })
    );

    this.subscriptions.push(
      this.bot.clientEvents.onLure.subscribe((e: LureEvent) => {
        const id = e.from?.toString() ?? '';
        this.pendingLures.set(id, e);
        callbacks.onTeleportOffer(id, e.fromName, e.lureMessage, e);
      })
    );

    this.subscriptions.push(
      this.bot.clientEvents.onDisconnected.subscribe((e: DisconnectEvent) => {
        callbacks.onDisconnected(e.message);
      })
    );

    return {
      region: region.regionName,
      waterHeight: region.waterHeight,
    };
  }

  // Read raw server position (no interpolation)
  private getRawPosition(): { x: number; y: number; z: number } | null {
    if (!this.bot) return null;
    try {
      const av = this.bot.currentRegion.agents.get(this._selfId);
      if (av) {
        const pos = av.position;
        if (pos.x !== 0 || pos.y !== 0 || pos.z !== 0) {
          return { x: pos.x, y: pos.y, z: pos.z };
        }
      }
      const obj = this.bot.clientCommands.agent.getGameObject();
      return { x: obj.Position.x, y: obj.Position.y, z: obj.Position.z };
    } catch {
      return null;
    }
  }

  // Update interpolation state from server and return smoothed position
  getPosition(): { x: number; y: number; z: number } | null {
    const raw = this.getRawPosition();
    if (!raw) return this._displayPos;

    const now = performance.now();

    if (!this._serverPos) {
      // First position — no interpolation
      this._serverPos = { ...raw };
      this._displayPos = { ...raw };
      this._lastServerUpdate = now;
      this._lastPosTime = now;
      return this._displayPos;
    }

    // Detect if server position changed
    const dx = raw.x - this._serverPos.x;
    const dy = raw.y - this._serverPos.y;
    const dz = raw.z - this._serverPos.z;
    const moved = Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01 || Math.abs(dz) > 0.01;

    if (moved) {
      const dt = (now - this._lastServerUpdate) / 1000;
      if (dt > 0.01) {
        this._velocity = { x: dx / dt, y: dy / dt, z: dz / dt };
      }
      this._serverPos = { ...raw };
      this._lastServerUpdate = now;
    }

    // Interpolate: blend display position toward server position
    if (this._displayPos) {
      const dt = (now - this._lastPosTime) / 1000;
      const LERP_SPEED = 8; // Higher = snappier correction
      const t = Math.min(1, LERP_SPEED * dt);

      // Predict where server pos will be based on velocity
      const predDt = Math.min(0.25, (now - this._lastServerUpdate) / 1000);
      const predX = this._serverPos.x + this._velocity.x * predDt;
      const predY = this._serverPos.y + this._velocity.y * predDt;
      const predZ = this._serverPos.z + this._velocity.z * predDt;

      // Lerp toward predicted position
      this._displayPos.x += (predX - this._displayPos.x) * t;
      this._displayPos.y += (predY - this._displayPos.y) * t;
      this._displayPos.z += (predZ - this._displayPos.z) * t;

      // Snap if very close
      const snapDist = Math.abs(predX - this._displayPos.x) + Math.abs(predY - this._displayPos.y);
      if (snapDist < 0.05) {
        this._displayPos.x = this._serverPos.x;
        this._displayPos.y = this._serverPos.y;
        this._displayPos.z = this._serverPos.z;
        // Decay velocity when stationary
        if (!moved) {
          this._velocity.x *= 0.8;
          this._velocity.y *= 0.8;
          this._velocity.z *= 0.8;
        }
      }
    }

    this._lastPosTime = now;
    return this._displayPos ? { ...this._displayPos } : null;
  }

  getRotation(): { x: number; y: number; z: number; w: number } | null {
    if (!this.bot) return null;
    try {
      const av = this.bot.currentRegion.agents.get(this._selfId);
      if (av) {
        const rot = av.getRotation();
        return { x: rot.x, y: rot.y, z: rot.z, w: rot.w };
      }
      const obj = this.bot.clientCommands.agent.getGameObject();
      return { x: obj.Rotation.x, y: obj.Rotation.y, z: obj.Rotation.z, w: obj.Rotation.w };
    } catch {
      return null;
    }
  }

  getTerrainHeight(x: number, y: number): number {
    if (!this.bot) return 0;
    // Terrain is static per region — cache forever until teleport
    const key = (y & 0xFF) << 8 | (x & 0xFF);
    const cached = this._terrainCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const h = this.bot.currentRegion.getTerrainHeightAtPoint(x, y);
      this._terrainCache.set(key, h);
      return h;
    } catch {
      return 0;
    }
  }

  getWaterHeight(): number {
    if (!this.bot) return 20;
    return this.bot.currentRegion.waterHeight;
  }

  getRegionName(): string {
    if (!this.bot) return '';
    return this.bot.currentRegion.regionName;
  }

  getAvatars(): AvatarData[] {
    if (!this.bot) return [];
    const result: AvatarData[] = [];
    const region = this.bot.currentRegion;

    for (const [uuid, avatar] of region.agents) {
      const pos = avatar.position;
      const rot = avatar.getRotation();
      const yaw = Math.atan2(
        2 * (rot.w * rot.z + rot.x * rot.y),
        1 - 2 * (rot.y * rot.y + rot.z * rot.z)
      );
      result.push({
        uuid,
        firstName: avatar.firstName,
        lastName: avatar.lastName,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        yaw,
        isSelf: uuid === this._selfId,
      });
    }
    return result;
  }

  getObjects(): ObjectData[] {
    if (!this.bot) return [];

    // Objects are mostly static — only refresh every 2 seconds
    const now = performance.now();
    if (now - this._objectCacheAge < 2000 && this._objectCache.length > 0) {
      return this._objectCache;
    }

    try {
      const objs = this.bot.currentRegion.objects.getAllObjects({});
      const result: ObjectData[] = [];
      for (const obj of objs) {
        if (!obj.Position) continue;
        if (obj.ParentID && obj.ParentID !== 0) continue;
        const scale = obj.Scale || { x: 1, y: 1, z: 1 };
        result.push({
          uuid: obj.FullID?.toString() ?? '',
          name: obj.name || '',
          x: obj.Position.x,
          y: obj.Position.y,
          z: obj.Position.z,
          scaleX: scale.x,
          scaleY: scale.y,
          scaleZ: scale.z,
          isTree: obj.PCode === 255 || obj.PCode === 111 || obj.PCode === 95,
        });
      }
      this._objectCache = result;
      this._objectCacheAge = now;
      return result;
    } catch {
      return this._objectCache;
    }
  }

  // Body yaw tracked locally for turning, with smooth animation
  private _bodyYaw = Math.PI / 2; // current display yaw
  private _targetYaw = Math.PI / 2; // target yaw (snapped to 22.5° increments)

  // Movement — body-relative: forward/back/strafe relative to facing direction
  move(dir: string): void {
    if (!this.bot) return;
    const agent = this.bot.agent;

    // Snap to target yaw immediately when moving so direction is correct
    this._bodyYaw = this._targetYaw;

    // Clear previous movement
    agent.clearControlFlag(
      ControlFlags.AGENT_CONTROL_AT_POS | ControlFlags.AGENT_CONTROL_AT_NEG |
      ControlFlags.AGENT_CONTROL_LEFT_POS | ControlFlags.AGENT_CONTROL_LEFT_NEG |
      ControlFlags.AGENT_CONTROL_UP_POS | ControlFlags.AGENT_CONTROL_UP_NEG
    );

    switch (dir) {
      case 'forward':
        this.applyBodyYaw();
        agent.setControlFlag(ControlFlags.AGENT_CONTROL_AT_POS);
        break;
      case 'back':
        this.applyBodyYaw();
        agent.setControlFlag(ControlFlags.AGENT_CONTROL_AT_NEG);
        break;
      case 'strafe_left':
        this.applyBodyYaw();
        agent.setControlFlag(ControlFlags.AGENT_CONTROL_LEFT_POS);
        break;
      case 'strafe_right':
        this.applyBodyYaw();
        agent.setControlFlag(ControlFlags.AGENT_CONTROL_LEFT_NEG);
        break;
      case 'up':
        agent.setControlFlag(ControlFlags.AGENT_CONTROL_UP_POS);
        break;
      case 'down':
        agent.setControlFlag(ControlFlags.AGENT_CONTROL_UP_NEG);
        break;
    }

    agent.sendAgentUpdate();
  }

  // Turn left/right by a fixed increment — sets target, animation is in getBodyYaw()
  turn(direction: 'left' | 'right'): void {
    const TURN_STEP = Math.PI / 8; // 22.5 degrees per press
    if (direction === 'left') {
      this._targetYaw += TURN_STEP;
    } else {
      this._targetYaw -= TURN_STEP;
    }
    // Normalize target to [-PI, PI]
    while (this._targetYaw > Math.PI) this._targetYaw -= 2 * Math.PI;
    while (this._targetYaw < -Math.PI) this._targetYaw += 2 * Math.PI;
  }

  // Returns smoothly interpolated yaw, advancing toward _targetYaw each call
  getBodyYaw(): number {
    if (this._bodyYaw === this._targetYaw) return this._bodyYaw;

    // Compute shortest angular distance
    let diff = this._targetYaw - this._bodyYaw;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;

    // Lerp: cover ~15% of remaining distance per frame (at 15Hz = smooth over ~10-15 frames)
    const LERP_SPEED = 0.15;
    const SNAP_THRESHOLD = 0.005; // ~0.3 degrees

    if (Math.abs(diff) < SNAP_THRESHOLD) {
      this._bodyYaw = this._targetYaw;
    } else {
      this._bodyYaw += diff * LERP_SPEED;
      // Normalize
      while (this._bodyYaw > Math.PI) this._bodyYaw -= 2 * Math.PI;
      while (this._bodyYaw < -Math.PI) this._bodyYaw += 2 * Math.PI;
    }

    // Update SL agent rotation to match current display yaw
    this.applyBodyYaw();
    if (this.bot) {
      this.bot.agent.sendAgentUpdate();
    }

    return this._bodyYaw;
  }

  // Apply current body yaw to the agent's body rotation quaternion
  private applyBodyYaw(): void {
    if (!this.bot) return;
    const agent = this.bot.agent;
    const rot = (agent as any).bodyRotation;
    if (!rot) return;
    // Z-axis rotation quaternion: (0, 0, sin(yaw/2), cos(yaw/2))
    rot.x = 0;
    rot.y = 0;
    rot.z = Math.sin(this._bodyYaw / 2);
    rot.w = Math.cos(this._bodyYaw / 2);
  }

  stop(): void {
    if (!this.bot) return;
    const agent = this.bot.agent;
    agent.clearControlFlag(
      ControlFlags.AGENT_CONTROL_AT_POS | ControlFlags.AGENT_CONTROL_AT_NEG |
      ControlFlags.AGENT_CONTROL_LEFT_POS | ControlFlags.AGENT_CONTROL_LEFT_NEG |
      ControlFlags.AGENT_CONTROL_UP_POS | ControlFlags.AGENT_CONTROL_UP_NEG
    );
    agent.sendAgentUpdate();
  }

  setFlying(enabled: boolean): void {
    if (!this.bot) return;
    this._flying = enabled;
    if (enabled) {
      this.bot.agent.setControlFlag(ControlFlags.AGENT_CONTROL_FLY);
    } else {
      this.bot.agent.clearControlFlag(ControlFlags.AGENT_CONTROL_FLY);
    }
    this.bot.agent.sendAgentUpdate();
  }

  get flying(): boolean {
    return this._flying;
  }

  // Chat
  async say(message: string, channel = 0): Promise<void> {
    if (!this.bot) return;
    if (channel !== 0) {
      await this.bot.clientCommands.comms.nearbyChat(message, ChatType.Normal, channel);
    } else {
      await this.bot.clientCommands.comms.say(message);
    }
  }

  async whisper(message: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.clientCommands.comms.whisper(message);
  }

  async shout(message: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.clientCommands.comms.shout(message);
  }

  // IM
  async sendIM(to: string, message: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.clientCommands.comms.sendInstantMessage(to, message);
  }

  async startTypingIM(to: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.clientCommands.comms.startTypingIM(new UUID(to));
  }

  async stopTypingIM(to: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.clientCommands.comms.stopTypingIM(new UUID(to));
  }

  // Search
  async searchPeople(query: string): Promise<{ name: string; uuid: string }[]> {
    if (!this.bot) return [];
    try {
      const result = await this.bot.clientCommands.grid.avatarName2KeyAndName(query);
      return [{ name: result.avatarName, uuid: result.avatarKey.toString() }];
    } catch {
      return [];
    }
  }

  // Friends
  async sendFriendRequest(to: string, message: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.clientCommands.friends.sendFriendRequest(to, message);
  }

  async acceptFriendRequest(fromUuid: string): Promise<void> {
    const req = this.pendingFriendRequests.get(fromUuid);
    if (!req || !this.bot) return;
    await this.bot.clientCommands.friends.acceptFriendRequest(req);
    this.pendingFriendRequests.delete(fromUuid);
  }

  async declineFriendRequest(fromUuid: string): Promise<void> {
    const req = this.pendingFriendRequests.get(fromUuid);
    if (!req || !this.bot) return;
    await this.bot.clientCommands.friends.rejectFriendRequest(req);
    this.pendingFriendRequests.delete(fromUuid);
  }

  // Teleport
  async teleportToRegion(regionName: string, x = 128, y = 128, z = 30): Promise<void> {
    if (!this.bot) return;
    await this.bot.clientCommands.teleport.teleportTo(
      regionName,
      new Vector3([x, y, z]),
      new Vector3([0, 1, 0])
    );
    // Invalidate caches after teleport (new region = new terrain/objects)
    this._terrainCache.clear();

    this._objectCache = [];
    this._objectCacheAge = 0;
    this._serverPos = null;
    this._displayPos = null;
  }

  async acceptTeleport(fromUuid: string): Promise<void> {
    const lure = this.pendingLures.get(fromUuid);
    if (!lure || !this.bot) return;
    await this.bot.clientCommands.teleport.acceptTeleport(lure);
    this.pendingLures.delete(fromUuid);
  }

  async declineTeleport(fromUuid: string): Promise<void> {
    this.pendingLures.delete(fromUuid);
    // No explicit decline API, just ignore
  }

  async teleportHome(): Promise<void> {
    if (!this.bot) return;
    await (this.bot.clientCommands.teleport as any).teleportHome();
  }

  // Sit / Touch
  async sitOnObject(uuid: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.clientCommands.movement.sitOnObject(new UUID(uuid), Vector3.getZero());
  }

  stand(): void {
    if (!this.bot) return;
    this.bot.clientCommands.movement.stand();
  }

  async touchObject(uuid: string): Promise<void> {
    if (!this.bot) return;
    try {
      const obj = this.bot.currentRegion.objects.getObjectByUUID(new UUID(uuid));
      await this.bot.clientCommands.region.touchObject(obj.ID);
    } catch {
      // Object might not be found
    }
  }

  // Profile
  async getProfile(uuid: string): Promise<{
    displayName: string;
    userName: string;
    bio: string;
    bornOn: string;
  } | null> {
    if (!this.bot) return null;
    try {
      const props = await this.bot.clientCommands.agent.getAvatarProperties(uuid);
      // Try to find avatar name
      const avatar = this.bot.currentRegion.agents.get(uuid);
      const displayName = avatar ? `${avatar.firstName} ${avatar.lastName}` : uuid;
      return {
        displayName,
        userName: displayName,
        bio: props.AboutText || '',
        bornOn: props.BornOn || '',
      };
    } catch {
      return null;
    }
  }

  // Inspect object by UUID
  inspectObject(uuid: string): { name: string; description: string; owner: string; position: string } | null {
    if (!this.bot) return null;
    try {
      const obj = this.bot.currentRegion.objects.getObjectByUUID(new UUID(uuid));
      return {
        name: obj.name || 'Unknown',
        description: obj.description || '',
        owner: obj.ownerID?.toString() ?? '',
        position: obj.Position ? `${obj.Position.x.toFixed(1)}, ${obj.Position.y.toFixed(1)}, ${obj.Position.z.toFixed(1)}` : '',
      };
    } catch {
      return null;
    }
  }

  // Inspect avatar by UUID
  inspectAvatar(uuid: string): { name: string; title: string; position: string } | null {
    if (!this.bot) return null;
    const av = this.bot.currentRegion.agents.get(uuid);
    if (!av) return null;
    const pos = av.position;
    return {
      name: `${av.firstName} ${av.lastName}`,
      title: av.getTitle() || '',
      position: `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`,
    };
  }

  // Friends list from login buddyList
  async getFriendsList(): Promise<{ uuid: string; name: string; online: boolean; rightsGiven: boolean; rightsHas: boolean }[]> {
    if (!this.bot) return [];
    const results: { uuid: string; name: string; online: boolean; rightsGiven: boolean; rightsHas: boolean }[] = [];
    for (const buddy of this.bot.agent.buddyList) {
      let name = buddy.buddyID.toString();
      try {
        const resolved = await this.bot.clientCommands.grid.avatarKey2Name(buddy.buddyID);
        if (!Array.isArray(resolved)) {
          name = resolved.getName();
        }
      } catch { /* keep uuid as name */ }

      const friend = this.bot.clientCommands.friends.getFriend(buddy.buddyID);
      results.push({
        uuid: buddy.buddyID.toString(),
        name,
        online: friend?.online ?? false,
        rightsGiven: buddy.buddyRightsGiven,
        rightsHas: buddy.buddyRightsHas,
      });
    }
    return results;
  }

  // Expose the raw bot for testing
  getBot(): Bot | null {
    return this.bot;
  }

  startTick(callback: () => void, hz = 4): void {
    this.tickTimer = setInterval(callback, 1000 / hz);
  }

  stopTick(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  async close(): Promise<void> {
    this.stopTick();
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    // Clear caches
    this._terrainCache.clear();
    this._objectCache = [];
    this._serverPos = null;
    this._displayPos = null;
    if (this.bot) {
      try {
        await this.bot.close();
      } catch {
        // ignore close errors
      }
      this.bot = null;
    }
  }
}
