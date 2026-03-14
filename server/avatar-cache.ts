// avatar-cache.ts — Fetch and cache avatar mesh data from SL
//
// Subscribes to AvatarAppearance messages, tracks attachments,
// downloads mesh assets, and caches parsed geometry per avatar.

import type { Bot } from '../vendor/node-metaverse/Bot.js';
import { Message } from '../vendor/node-metaverse/enums/Message.js';
import { AssetType } from '../vendor/node-metaverse/enums/AssetType.js';
import { SculptType } from '../vendor/node-metaverse/enums/SculptType.js';
import { LLMesh } from '../vendor/node-metaverse/classes/public/LLMesh.js';
import type { LLSubMesh } from '../vendor/node-metaverse/classes/public/interfaces/LLSubMesh.js';
import type { Avatar } from '../vendor/node-metaverse/classes/public/Avatar.js';
import type { GameObject } from '../vendor/node-metaverse/classes/public/GameObject.js';
import type { Subscription } from 'rxjs';

export interface CachedMesh {
  positions: Float32Array;   // flat xyz triples
  indices: Uint16Array;      // triangle indices
  normals: Float32Array;     // flat xyz triples (or empty)
  attachmentPoint?: number;  // AttachmentPoint enum value (for avatar attachments)
}

export interface AvatarMeshBundle {
  uuid: string;
  meshes: CachedMesh[];
  fetchedAt: number;
}

// Flatten LLSubMesh[] from a single LOD level into CachedMesh[]
function submeshesToCached(submeshes: LLSubMesh[]): CachedMesh[] {
  const result: CachedMesh[] = [];
  for (const sm of submeshes) {
    if (sm.noGeometry || !sm.position || !sm.triangleList || sm.position.length === 0) continue;
    const verts = sm.position;
    const posArr = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
      posArr[i * 3]     = verts[i].x;
      posArr[i * 3 + 1] = verts[i].y;
      posArr[i * 3 + 2] = verts[i].z;
    }
    const indices = new Uint16Array(sm.triangleList);

    let normals = new Float32Array(0);
    if (sm.normal && sm.normal.length === verts.length) {
      normals = new Float32Array(verts.length * 3);
      for (let i = 0; i < sm.normal.length; i++) {
        normals[i * 3]     = sm.normal[i].x;
        normals[i * 3 + 1] = sm.normal[i].y;
        normals[i * 3 + 2] = sm.normal[i].z;
      }
    }

    result.push({ positions: posArr, indices, normals });
  }
  return result;
}

export class AvatarCache {
  private cache = new Map<string, AvatarMeshBundle>();
  private pending = new Set<string>();         // mesh UUIDs currently being downloaded
  private meshAssetCache = new Map<string, CachedMesh[]>(); // meshUUID → parsed geometry
  private subscriptions: Subscription[] = [];
  private bot: Bot | null = null;

  attach(bot: Bot): void {
    this.bot = bot;
    this.cache.clear();
    this.pending.clear();
    this.meshAssetCache.clear();
  }

  detach(): void {
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions = [];
    this.bot = null;
  }

  // Scan an avatar's attachments for mesh objects and download/cache them
  async scanAvatar(avatar: Avatar): Promise<void> {
    if (!this.bot) return;
    const uuid = avatar.getKey()?.toString() ?? '';
    if (!uuid) return;

    const attachments = avatar.getAttachments();
    const meshUUIDs: string[] = [];

    const attachPointMap = new Map<string, number>(); // meshUUID → attachmentPoint
    for (const [, obj] of attachments) {
      const md = obj.extraParams?.meshData;
      if (md && md.type === SculptType.Mesh) {
        const meshId = md.meshData.toString();
        if (meshId && meshId !== '00000000-0000-0000-0000-000000000000') {
          meshUUIDs.push(meshId);
          if (obj.attachmentPoint !== undefined) {
            attachPointMap.set(meshId, obj.attachmentPoint);
          }
        }
      }
    }

    if (meshUUIDs.length === 0) return;

    // Download any meshes we haven't seen
    const allMeshes: CachedMesh[] = [];
    for (const mid of meshUUIDs) {
      const cached = this.meshAssetCache.get(mid);
      if (cached) {
        allMeshes.push(...cached);
        continue;
      }
      if (this.pending.has(mid)) continue;

      this.pending.add(mid);
      try {
        const buf = await this.bot.clientCommands.asset.downloadAsset(AssetType.Mesh, mid);
        const mesh = await LLMesh.from(buf);
        // Use lowest LOD for performance
        const lod = mesh.lodLevels['lowest_lod']
          ?? mesh.lodLevels['low_lod']
          ?? mesh.lodLevels['medium_lod']
          ?? mesh.lodLevels['high_lod'];
        if (lod) {
          const parsed = submeshesToCached(lod);
          // Store attachment point on each mesh
          const ap = attachPointMap.get(mid);
          if (ap !== undefined) {
            for (const m of parsed) m.attachmentPoint = ap;
          }
          this.meshAssetCache.set(mid, parsed);
          allMeshes.push(...parsed);
        }
      } catch {
        // Asset download can fail for permissions/missing assets — ignore
      } finally {
        this.pending.delete(mid);
      }
    }

    if (allMeshes.length > 0) {
      this.cache.set(uuid, { uuid, meshes: allMeshes, fetchedAt: Date.now() });
    }
  }

  // Get cached mesh bundle for an avatar, or null
  getMeshBundle(avatarUUID: string): AvatarMeshBundle | null {
    return this.cache.get(avatarUUID) ?? null;
  }

  // Trigger a scan for all visible avatars (call periodically, e.g. every 10s)
  // Also evicts stale entries for avatars no longer in region
  async scanAll(): Promise<void> {
    if (!this.bot) return;
    const region = this.bot.currentRegion;
    if (!region) return;

    // Evict avatar bundles for avatars no longer in region
    const activeUUIDs = new Set<string>();
    for (const [, avatar] of region.agents) {
      const uuid = avatar.getKey()?.toString() ?? '';
      if (uuid) activeUUIDs.add(uuid);
    }
    for (const uuid of this.cache.keys()) {
      if (!activeUUIDs.has(uuid)) this.cache.delete(uuid);
    }
    // Cap mesh asset cache at 500 entries
    if (this.meshAssetCache.size > 500) {
      const keys = [...this.meshAssetCache.keys()];
      for (let i = 0; i < keys.length - 500; i++) {
        this.meshAssetCache.delete(keys[i]);
      }
    }

    for (const [, avatar] of region.agents) {
      const uuid = avatar.getKey()?.toString() ?? '';
      if (this.cache.has(uuid)) continue;
      this.scanAvatar(avatar).catch(() => {});
    }
  }
}
