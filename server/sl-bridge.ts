// sl-bridge.ts — Wraps Bot: login, movement, events, 4Hz tick loop

import { quatRotateVec3, quatMultiply } from './quat-utils.js';
import { Bot } from '../vendor/node-metaverse/Bot.js';
import { LoginParameters } from '../vendor/node-metaverse/classes/LoginParameters.js';
import { BotOptionFlags } from '../vendor/node-metaverse/enums/BotOptionFlags.js';
import { ControlFlags } from '../vendor/node-metaverse/enums/ControlFlags.js';
import { UUID } from '../vendor/node-metaverse/classes/UUID.js';
import { Vector3 } from '../vendor/node-metaverse/classes/Vector3.js';
import { ChatType } from '../vendor/node-metaverse/enums/ChatType.js';
import { Message } from '../vendor/node-metaverse/enums/Message.js';
import { PacketFlags } from '../vendor/node-metaverse/enums/PacketFlags.js';
import { RetrieveInstantMessagesMessage } from '../vendor/node-metaverse/classes/messages/RetrieveInstantMessages.js';
import { SculptType } from '../vendor/node-metaverse/enums/SculptType.js';
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
import { AvatarCache } from './avatar-cache.js';
import type { AvatarMeshBundle } from './avatar-cache.js';
import { AvatarAppearanceCache } from './avatar-appearance.js';
import type { AvatarAppearanceData, BakedTextureColors } from './avatar-appearance.js';
import { MeshCache } from './mesh-cache.js';

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
  private avatarCache = new AvatarCache();
  private _avatarScanAge = 0;
  private appearanceCache = new AvatarAppearanceCache();
  private meshCache = new MeshCache();
  private _appearanceScanAge = 0;

  // Caches to avoid per-tick allocations and redundant work
  private _selfId: string = '';
  private _objectCache: ObjectData[] = [];
  private _objectCacheAge = 0;
  private _terrainCache = new Map<number, number>(); // (y*256+x) → height
  private _lastRegionName: string = '';
  private _onRegionChange: (() => void) | null = null;

  // Position interpolation state
  private _serverPos: { x: number; y: number; z: number } | null = null;
  private _displayPos: { x: number; y: number; z: number } | null = null;
  private _velocity: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private _lastServerUpdate = 0;
  private _lastPosTime = 0;
  private _activeMove: string | null = null; // current movement direction for dead reckoning
  private _moveStopTime = 0; // when movement stopped (for deceleration ramp)

  async login(firstName: string, lastName: string, password: string, callbacks: BridgeCallbacks): Promise<{ region: string; waterHeight: number }> {
    const params = new LoginParameters();
    params.firstName = firstName;
    params.lastName = lastName;
    params.password = password;
    params.start = 'last';
    params.agreeToTOS = true;
    params.readCritical = true;

    this.bot = new Bot(params, BotOptionFlags.LiteObjectStore);

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
    this._lastRegionName = region.regionName;

    // Attach avatar mesh cache and mesh cache
    this.avatarCache.attach(this.bot);
    this.meshCache.attach(this.bot);

    // Subscribe to AvatarAppearance messages for visual params + baked textures
    try {
      const circuit = this.bot.currentRegion.circuit;
      this.subscriptions.push(
        circuit.subscribeToMessages([Message.AvatarAppearance], (packet: any) => {
          this.appearanceCache.handleAppearanceMessage(packet.message);
          // Trigger baked texture download in background
          const msg = packet.message;
          const uuid = msg.Sender?.ID?.toString();
          if (uuid && this.bot) {
            const data = this.appearanceCache.get(uuid);
            if (data) {
              this.appearanceCache.downloadBakedColors(this.bot, data).catch(() => {});
            }
          }
        })
      );
    } catch { /* Circuit subscription can fail — proceed without appearance data */ }

    // Subscribe to events
    this.subscriptions.push(
      this.bot.clientEvents.onNearbyChat.subscribe((e: ChatEvent) => {
        callbacks.onChat(e.fromName, e.message, e.chatType, e.from?.toString() ?? '');
      })
    );

    this.subscriptions.push(
      this.bot.clientEvents.onInstantMessage.subscribe((e: InstantMessageEvent) => {
        // Skip typing indicators and other empty messages
        if (!e.message || e.message.trim() === '') return;
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
    if (!raw) return this._displayPos ? { ...this._displayPos } : null;

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
      if (dt > 0.05) {
        // Smooth velocity with exponential moving average to avoid spikes
        const newVx = dx / dt, newVy = dy / dt, newVz = dz / dt;
        const blend = 0.3; // blend new velocity (lower = smoother, less jittery)
        this._velocity.x = this._velocity.x * (1 - blend) + newVx * blend;
        this._velocity.y = this._velocity.y * (1 - blend) + newVy * blend;
        this._velocity.z = this._velocity.z * (1 - blend) + newVz * blend;
      }
      this._serverPos = { ...raw };
      this._lastServerUpdate = now;
    }

    if (this._displayPos) {
      const dt = (now - this._lastPosTime) / 1000;

      // Client-side dead reckoning from active movement input
      // SL walk speed ~3.2 m/s, fly speed ~16 m/s
      if (this._activeMove && dt > 0) {
        const moveSpeed = this._flying ? 16 : 3.2;
        const yaw = this._bodyYaw;
        let mx = 0, my = 0, mz = 0;
        switch (this._activeMove) {
          case 'forward':  mx = Math.cos(yaw) * moveSpeed; my = Math.sin(yaw) * moveSpeed; break;
          case 'back':     mx = -Math.cos(yaw) * moveSpeed; my = -Math.sin(yaw) * moveSpeed; break;
          case 'strafe_left':  mx = Math.sin(yaw) * moveSpeed; my = -Math.cos(yaw) * moveSpeed; break;
          case 'strafe_right': mx = -Math.sin(yaw) * moveSpeed; my = Math.cos(yaw) * moveSpeed; break;
          case 'up':       mz = moveSpeed; break;
          case 'down':     mz = -moveSpeed; break;
        }
        // Apply directly to display position (immediate response)
        this._displayPos.x += mx * dt;
        this._displayPos.y += my * dt;
        this._displayPos.z += mz * dt;
      }

      // Lerp toward server position to correct drift.
      //
      // Key insight: when we STOP moving, the server position is BEHIND us because
      // server updates lag by ~100-300ms. If we immediately snap to server position,
      // we bounce backward then forward as server catches up. Instead:
      //
      // - While moving: gentle correction (0.15) — dead reckoning dominates
      // - Just stopped (0-1s): very gentle correction (0.5) — let server catch up
      // - Stopped a while (1s+): moderate correction (3) — converge smoothly
      //
      // This prevents the "bounce back then forward" jank on key release.
      let correctionSpeed: number;
      if (this._activeMove) {
        correctionSpeed = 0.15;
      } else {
        const timeSinceStop = (now - this._moveStopTime) / 1000;
        // Ramp from 0.5 → 3 over 0.8 seconds after stopping
        correctionSpeed = 0.5 + Math.min(1, timeSinceStop / 0.8) * 2.5;
      }
      const t = 1 - Math.exp(-correctionSpeed * dt);
      this._displayPos.x += (this._serverPos.x - this._displayPos.x) * t;
      this._displayPos.y += (this._serverPos.y - this._displayPos.y) * t;
      this._displayPos.z += (this._serverPos.z - this._displayPos.z) * t;

      // Hard snap for teleports (large jumps > 15m)
      const jumpDist = Math.sqrt(
        (this._serverPos.x - this._displayPos.x) ** 2 +
        (this._serverPos.y - this._displayPos.y) ** 2 +
        (this._serverPos.z - this._displayPos.z) ** 2
      );
      if (jumpDist > 15) {
        this._displayPos.x = this._serverPos.x;
        this._displayPos.y = this._serverPos.y;
        this._displayPos.z = this._serverPos.z;
        this._velocity = { x: 0, y: 0, z: 0 };
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

  getSkyColors(): { zenith: [number, number, number]; horizon: [number, number, number]; sunDir: [number, number, number] } | null {
    if (!this.bot) return null;
    try {
      const env = this.bot.currentRegion.environment;
      if (!env?.dayCycle) return null;
      const sky = env.dayCycle;

      // Extract sky colors from EEP/WindLight settings
      // legacyHaze.blueHorizon = horizon color, blueDensity = zenith blue
      // sunlightColor = sun tint, sunRotation = sun direction
      const haze = sky.legacyHaze;
      let zenith: [number, number, number] = [0x1a, 0x1a, 0x2e]; // default dark
      let horizon: [number, number, number] = [0x55, 0x55, 0x66];

      if (haze?.blueDensity) {
        // EEP values are typically 0-1 floats representing HDR color
        const bd = haze.blueDensity;
        zenith = [
          Math.min(255, Math.round((bd.x ?? 0) * 255 * 2)),
          Math.min(255, Math.round((bd.y ?? 0) * 255 * 2)),
          Math.min(255, Math.round((bd.z ?? 0) * 255 * 2)),
        ];
      }
      if (haze?.blueHorizon) {
        const bh = haze.blueHorizon;
        horizon = [
          Math.min(255, Math.round((bh.x ?? 0) * 255 * 2)),
          Math.min(255, Math.round((bh.y ?? 0) * 255 * 2)),
          Math.min(255, Math.round((bh.z ?? 0) * 255 * 2)),
        ];
      }

      // Sun direction from rotation quaternion
      let sunDir: [number, number, number] = [0.3, 0.8, 0.5];
      if (sky.sunRotation) {
        const q = sky.sunRotation;
        // Forward vector (0,0,-1) rotated by quaternion
        const qx = q.x ?? 0, qy = q.y ?? 0, qz = q.z ?? 0, qw = q.w ?? 1;
        sunDir = [
          2 * (qx * qz + qw * qy),
          2 * (qy * qz - qw * qx),
          -(1 - 2 * (qx * qx + qy * qy)),
        ];
      }

      return { zenith, horizon, sunDir };
    } catch {
      return null;
    }
  }

  getCloudParams(): { scrollRateX: number; scrollRateY: number; density1Z: number; density2Z: number; scale: number; shadow: number; colorR: number; colorG: number; colorB: number } | null {
    if (!this.bot) return null;
    try {
      const env = this.bot.currentRegion.environment;
      if (!env?.dayCycle) return null;
      const sky = env.dayCycle;
      return {
        scrollRateX: sky.cloudScrollRate?.x ?? 0.05,
        scrollRateY: sky.cloudScrollRate?.y ?? 0.03,
        density1Z: sky.cloudPosDensity1?.z ?? 0.5,
        density2Z: sky.cloudPosDensity2?.z ?? 0.3,
        scale: sky.cloudScale ?? 0.4,
        shadow: sky.cloudShadow ?? 0.5,
        colorR: Math.round((sky.cloudColor?.x ?? 1) * 255),
        colorG: Math.round((sky.cloudColor?.y ?? 1) * 255),
        colorB: Math.round((sky.cloudColor?.z ?? 1) * 255),
      };
    } catch {
      return null;
    }
  }

  // Set callback for region changes (called when we detect a new region)
  onRegionChange(cb: () => void): void {
    this._onRegionChange = cb;
  }

  // Check if region has changed and invalidate caches if so
  checkRegionCrossing(): void {
    if (!this.bot) return;
    const currentName = this.bot.currentRegion.regionName;
    if (this._lastRegionName && currentName !== this._lastRegionName) {
      // Region changed — invalidate all caches
      this._terrainCache.clear();
      this._objectCache = [];
      this._objectCacheAge = 0;
      this._serverPos = null;
      this._displayPos = null;
      this._onRegionChange?.();
    }
    this._lastRegionName = currentName;
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
      // Extract velocity from the underlying GameObject
      let velX = 0, velY = 0, velZ = 0;
      try {
        const go = (avatar as any).gameObject ?? (avatar as any).GameObject;
        if (go?.Velocity) {
          velX = go.Velocity.x ?? 0;
          velY = go.Velocity.y ?? 0;
          velZ = go.Velocity.z ?? 0;
        }
      } catch { /* no velocity data */ }
      result.push({
        uuid,
        firstName: avatar.firstName,
        lastName: avatar.lastName,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        yaw,
        isSelf: uuid === this._selfId,
        velX, velY, velZ,
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

      const primToObjectData = (
        prim: any,
        worldX: number, worldY: number, worldZ: number,
        worldRotX: number, worldRotY: number, worldRotZ: number, worldRotW: number,
      ): ObjectData => {
        const scale = prim.Scale || { x: 1, y: 1, z: 1 };
        let colorR = 128, colorG = 128, colorB = 128;
        let alpha: number | undefined;
        let fullbright: boolean | undefined;
        let faceColors: [number, number, number, number][] | undefined;
        try {
          const te = prim.TextureEntry;
          if (te?.defaultTexture?.rgba) {
            const rgba = te.defaultTexture.rgba;
            colorR = Math.round((rgba.red ?? rgba.r ?? rgba.x ?? 0.5) * 255);
            colorG = Math.round((rgba.green ?? rgba.g ?? rgba.y ?? 0.5) * 255);
            colorB = Math.round((rgba.blue ?? rgba.b ?? rgba.z ?? 0.5) * 255);
            const a = rgba.alpha ?? rgba.a ?? rgba.w;
            if (a !== undefined && a < 1) alpha = a;
          }
          if (te?.defaultTexture?.fullbright) fullbright = true;
          // Extract per-face colors
          if (te?.faces?.length > 0) {
            faceColors = [];
            for (let fi = 0; fi < te.faces.length; fi++) {
              const face = te.faces[fi];
              if (face?.rgba) {
                const fc = face.rgba;
                faceColors.push([
                  Math.round((fc.red ?? fc.r ?? fc.x ?? 0.5) * 255),
                  Math.round((fc.green ?? fc.g ?? fc.y ?? 0.5) * 255),
                  Math.round((fc.blue ?? fc.b ?? fc.z ?? 0.5) * 255),
                  fc.alpha ?? fc.a ?? fc.w ?? 1,
                ]);
              } else {
                // Inherit from default
                faceColors.push([colorR, colorG, colorB, alpha ?? 1]);
              }
            }
          }
        } catch { /* keep defaults */ }

        // Extract mesh UUID from extraParams
        let meshUUID: string | undefined;
        try {
          const md = prim.extraParams?.meshData;
          if (md && (md.type & 0x05) === 0x05) { // SculptType.Mesh = 5
            const meshId = md.meshData?.toString();
            if (meshId && meshId !== '00000000-0000-0000-0000-000000000000') {
              meshUUID = meshId;
            }
          }
        } catch { /* no mesh data */ }

        // Extract prim shape params
        const profileHollow = prim.ProfileHollow != null ? prim.ProfileHollow / 50000 : undefined;
        const pathBegin = prim.PathBegin != null ? prim.PathBegin / 50000 : undefined;
        const pathEnd = prim.PathEnd != null ? 1 - prim.PathEnd / 50000 : undefined;
        const pathTwist = prim.PathTwist != null ? prim.PathTwist * Math.PI / 18000 : undefined;
        const pathTwistBegin = prim.PathTwistBegin != null ? prim.PathTwistBegin * Math.PI / 18000 : undefined;
        const pathTaperX = prim.PathTaperX != null ? prim.PathTaperX / 100 : undefined;
        const pathTaperY = prim.PathTaperY != null ? prim.PathTaperY / 100 : undefined;

        return {
          uuid: prim.FullID?.toString() ?? '',
          name: prim.name || '',
          x: worldX,
          y: worldY,
          z: worldZ,
          scaleX: scale.x,
          scaleY: scale.y,
          scaleZ: scale.z,
          isTree: prim.PCode === 255 || prim.PCode === 111 || prim.PCode === 95,
          pcode: prim.PCode ?? 9,
          treeSpecies: prim.TreeSpecies ?? -1,
          pathCurve: prim.PathCurve ?? 16,
          profileCurve: prim.ProfileCurve ?? 1,
          rotX: worldRotX, rotY: worldRotY, rotZ: worldRotZ, rotW: worldRotW,
          colorR, colorG, colorB,
          alpha, fullbright,
          faceColors,
          meshUUID,
          profileHollow, pathBegin, pathEnd,
          pathTwist, pathTwistBegin, pathTaperX, pathTaperY,
        };
      };

      for (const obj of objs) {
        if (!obj.Position) continue;
        const rot = obj.Rotation || { x: 0, y: 0, z: 0, w: 1 };
        const rootData = primToObjectData(
          obj, obj.Position.x, obj.Position.y, obj.Position.z,
          rot.x, rot.y, rot.z, rot.w,
        );
        result.push(rootData);

        // Flatten child prims (linkset members) — skip for trees/grass
        if (!rootData.isTree && obj.children && obj.children.length > 0) {
          for (const child of obj.children) {
            if (!child.Position) continue;
            // Child Position/Rotation are LOCAL to the root prim
            const childLocalPos = child.Position;
            const childRot = child.Rotation || { x: 0, y: 0, z: 0, w: 1 };
            // World position = parentPos + parentRot * childLocalPos
            const [wx, wy, wz] = quatRotateVec3(
              rot.x, rot.y, rot.z, rot.w,
              childLocalPos.x, childLocalPos.y, childLocalPos.z,
            );
            // World rotation = parentRot * childRot
            const [crx, cry, crz, crw] = quatMultiply(
              rot.x, rot.y, rot.z, rot.w,
              childRot.x, childRot.y, childRot.z, childRot.w,
            );
            result.push(primToObjectData(
              child,
              obj.Position.x + wx, obj.Position.y + wy, obj.Position.z + wz,
              crx, cry, crz, crw,
            ));
          }
        }
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

    // Only send update if direction changed (avoid spamming clear/set on key repeat)
    if (dir === this._activeMove) return;

    // Clear previous movement
    agent.clearControlFlag(
      ControlFlags.AGENT_CONTROL_AT_POS | ControlFlags.AGENT_CONTROL_AT_NEG |
      ControlFlags.AGENT_CONTROL_LEFT_POS | ControlFlags.AGENT_CONTROL_LEFT_NEG |
      ControlFlags.AGENT_CONTROL_UP_POS | ControlFlags.AGENT_CONTROL_UP_NEG
    );

    this._activeMove = dir;

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
    const TURN_STEP = Math.PI / 16; // 11.25 degrees per press
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

  // Autopilot: fly toward a target avatar
  private _flyToTarget: string | null = null;
  private _flyToArrivalDist = 3; // stop within 3m

  flyToAvatar(uuid: string): void {
    if (!this.bot) return;
    this._flyToTarget = uuid;
    // Enable flying
    this.setFlying(true);
  }

  cancelFlyTo(): void {
    this._flyToTarget = null;
  }

  // Called each tick — returns true while autopilot is active
  tickFlyTo(): boolean {
    if (!this._flyToTarget || !this.bot) return false;

    const target = this.bot.currentRegion.agents.get(this._flyToTarget);
    if (!target) {
      // Avatar left — cancel
      this._flyToTarget = null;
      this.stop();
      return false;
    }

    const myPos = this.getRawPosition();
    if (!myPos) return false;

    const tPos = target.position;
    const dx = tPos.x - myPos.x;
    const dy = tPos.y - myPos.y;
    const dz = tPos.z - myPos.z;
    const horizDist = Math.sqrt(dx * dx + dy * dy);
    const dist3d = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist3d < this._flyToArrivalDist) {
      // Arrived
      this._flyToTarget = null;
      this.stop();
      return false;
    }

    // Turn to face target
    const targetYaw = Math.atan2(dy, dx);
    this._targetYaw = targetYaw;
    this._bodyYaw = targetYaw;
    this.applyBodyYaw();

    // Determine desired altitude: fly above terrain, match target altitude near arrival
    const terrainH = this.getTerrainHeight(Math.floor(myPos.x), Math.floor(myPos.y));
    const minFlyAlt = terrainH + 10; // at least 10m above terrain
    let desiredZ: number;
    if (horizDist < 10) {
      // Close to target — match their altitude
      desiredZ = tPos.z;
    } else {
      // En route — fly above terrain, biased toward target altitude
      desiredZ = Math.max(minFlyAlt, tPos.z);
    }
    const altDz = desiredZ - myPos.z;

    // Move forward + adjust altitude
    const agent = this.bot.agent;
    agent.clearControlFlag(
      ControlFlags.AGENT_CONTROL_AT_POS | ControlFlags.AGENT_CONTROL_AT_NEG |
      ControlFlags.AGENT_CONTROL_LEFT_POS | ControlFlags.AGENT_CONTROL_LEFT_NEG |
      ControlFlags.AGENT_CONTROL_UP_POS | ControlFlags.AGENT_CONTROL_UP_NEG
    );

    agent.setControlFlag(ControlFlags.AGENT_CONTROL_AT_POS);

    // Fly up/down toward desired altitude
    if (altDz > 2) {
      agent.setControlFlag(ControlFlags.AGENT_CONTROL_UP_POS);
    } else if (altDz < -2) {
      agent.setControlFlag(ControlFlags.AGENT_CONTROL_UP_NEG);
    }

    agent.sendAgentUpdate();
    return true;
  }

  stop(): void {
    if (!this.bot) return;
    this._activeMove = null;
    this._moveStopTime = performance.now();
    this._velocity = { x: 0, y: 0, z: 0 };
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
  async retrieveOfflineMessages(): Promise<void> {
    if (!this.bot) return;
    try {
      const agentID = this.bot.agent.agentID;
      const sessionID = this.bot.agent.sessionID;
      if (!agentID || !sessionID) return;
      const msg = new RetrieveInstantMessagesMessage();
      msg.AgentData = { AgentID: agentID, SessionID: sessionID };
      this.bot.currentRegion.circuit.sendMessage(msg, PacketFlags.Reliable);
    } catch { /* Offline message retrieval can fail — not critical */ }
  }

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

  // Avatar mesh data
  getAvatarMeshBundle(uuid: string): AvatarMeshBundle | null {
    return this.avatarCache.getMeshBundle(uuid);
  }

  // Avatar appearance data
  getAvatarAppearance(uuid: string): AvatarAppearanceData | null {
    return this.appearanceCache.get(uuid);
  }

  getAvatarBakedColors(uuid: string): BakedTextureColors | null {
    return this.appearanceCache.getBakedColors(uuid);
  }

  // Scene mesh lookup
  getSceneMesh(uuid: string): import('./avatar-cache.js').CachedMesh[] | null {
    return this.meshCache.getMesh(uuid);
  }

  // Queue scene mesh downloads
  triggerSceneMeshFetch(uuids: string[]): void {
    this.meshCache.triggerFetch(uuids);
  }

  // Periodic avatar mesh scan (call from tick at lower frequency)
  triggerAvatarMeshScan(): void {
    const now = performance.now();
    if (now - this._avatarScanAge < 10000) return; // every 10s
    this._avatarScanAge = now;
    this.avatarCache.scanAll().catch(() => {});
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
    this.avatarCache.detach();
    this.meshCache.detach();
    this.appearanceCache.clear();
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
