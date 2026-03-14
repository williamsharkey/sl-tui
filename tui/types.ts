// types.ts — ISLBridge interface and WritableTarget for TUI

import type { AvatarData, ObjectData } from '../server/grid-state.js';
import type { AvatarMeshBundle, CachedMesh } from '../server/avatar-cache.js';
import type { AvatarAppearanceData, BakedTextureColors } from '../server/avatar-appearance.js';

export interface WritableTarget {
  write(data: string): void;
  columns: number;
  rows: number;
}

export interface BridgeCallbacks {
  onChat: (from: string, message: string, chatType: number, fromId: string) => void;
  onIM: (from: string, fromName: string, message: string, isGroup: boolean, groupName?: string) => void;
  onFriendRequest: (from: string, fromName: string, message: string, requestId: string) => void;
  onFriendOnline: (name: string, uuid: string, online: boolean) => void;
  onTeleportOffer: (from: string, fromName: string, message: string, lureEvent: any) => void;
  onDisconnected: (reason: string) => void;
}

export interface ISLBridge {
  login(firstName: string, lastName: string, password: string, callbacks: BridgeCallbacks): Promise<{ region: string; waterHeight: number }>;
  getPosition(): { x: number; y: number; z: number } | null;
  getRotation(): { x: number; y: number; z: number; w: number } | null;
  getTerrainHeight(x: number, y: number): number;
  getWaterHeight(): number;
  getRegionName(): string;
  getAvatars(): AvatarData[];
  getObjects(): ObjectData[];
  move(dir: string): void;
  turn(direction: 'left' | 'right'): void;
  getBodyYaw(): number;
  stop(): void;
  setFlying(enabled: boolean): void;
  readonly flying: boolean;
  say(message: string, channel?: number): Promise<void>;
  whisper(message: string): Promise<void>;
  shout(message: string): Promise<void>;
  sendIM(to: string, message: string): Promise<void>;
  retrieveOfflineMessages?(): Promise<void>;
  searchPeople(query: string): Promise<{ name: string; uuid: string }[]>;
  sendFriendRequest(to: string, message: string): Promise<void>;
  acceptFriendRequest(fromUuid: string): Promise<void>;
  declineFriendRequest(fromUuid: string): Promise<void>;
  teleportToRegion(regionName: string, x?: number, y?: number, z?: number): Promise<void>;
  acceptTeleport(fromUuid: string): Promise<void>;
  declineTeleport(fromUuid: string): Promise<void>;
  teleportHome(): Promise<void>;
  sitOnObject(uuid: string): Promise<void>;
  stand(): void;
  touchObject(uuid: string): Promise<void>;
  getProfile(uuid: string): Promise<{ displayName: string; userName: string; bio: string; bornOn: string } | null>;
  inspectObject(uuid: string): { name: string; description: string; owner: string; position: string } | null;
  inspectAvatar(uuid: string): { name: string; title: string; position: string } | null;
  getFriendsList(): Promise<{ uuid: string; name: string; online: boolean; rightsGiven: boolean; rightsHas: boolean }[]>;
  flyToAvatar(uuid: string): void;
  cancelFlyTo(): void;
  tickFlyTo(): boolean;
  onRegionChange(cb: () => void): void;
  checkRegionCrossing(): void;
  triggerAvatarMeshScan(): void;
  getSkyColors(): { zenith: [number, number, number]; horizon: [number, number, number]; sunDir: [number, number, number] } | null;
  getAvatarMeshBundle(uuid: string): AvatarMeshBundle | null;
  getAvatarAppearance?(uuid: string): AvatarAppearanceData | null;
  getAvatarBakedColors?(uuid: string): BakedTextureColors | null;
  getSceneMesh?(uuid: string): CachedMesh[] | null;
  triggerSceneMeshFetch?(uuids: string[]): void;
  startTick(callback: () => void, hz?: number): void;
  stopTick(): void;
  close(): Promise<void>;
}
