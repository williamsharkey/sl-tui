// mesh-cache.ts — Download and cache mesh prim geometry from SL
//
// Generalized from avatar-cache.ts pattern. Downloads mesh assets
// for scene objects (not avatar attachments) and caches parsed geometry.

import type { Bot } from '../vendor/node-metaverse/Bot.js';
import { AssetType } from '../vendor/node-metaverse/enums/AssetType.js';
import { LLMesh } from '../vendor/node-metaverse/classes/public/LLMesh.js';
import type { LLSubMesh } from '../vendor/node-metaverse/classes/public/interfaces/LLSubMesh.js';
import type { CachedMesh } from './avatar-cache.js';

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

export class MeshCache {
  private cache = new Map<string, CachedMesh[]>();
  private pending = new Set<string>();
  private bot: Bot | null = null;
  private maxConcurrent = 3;
  private activeDownloads = 0;

  attach(bot: Bot): void {
    this.bot = bot;
    this.cache.clear();
    this.pending.clear();
    this.activeDownloads = 0;
  }

  detach(): void {
    this.bot = null;
  }

  get size(): number { return this.cache.size; }

  getMesh(uuid: string): CachedMesh[] | null {
    return this.cache.get(uuid) ?? null;
  }

  /** Evict oldest entries if cache exceeds limit */
  prune(maxEntries = 1000): void {
    if (this.cache.size <= maxEntries) return;
    const keys = [...this.cache.keys()];
    for (let i = 0; i < keys.length - maxEntries; i++) {
      this.cache.delete(keys[i]);
    }
  }

  /**
   * Queue mesh UUIDs for async download. Non-blocking — fetches happen
   * in the background, max `maxConcurrent` at a time per call.
   */
  triggerFetch(uuids: string[]): void {
    if (!this.bot) return;

    for (const uuid of uuids) {
      if (this.cache.has(uuid) || this.pending.has(uuid)) continue;
      if (this.activeDownloads >= this.maxConcurrent) break;

      this.pending.add(uuid);
      this.activeDownloads++;
      this.fetchMesh(uuid).finally(() => {
        this.activeDownloads--;
        this.pending.delete(uuid);
      });
    }
  }

  private async fetchMesh(uuid: string): Promise<void> {
    if (!this.bot) return;
    try {
      const buf = await this.bot.clientCommands.asset.downloadAsset(AssetType.Mesh, uuid);
      const mesh = await LLMesh.from(buf);
      // Use lowest LOD for performance
      const lod = mesh.lodLevels['lowest_lod']
        ?? mesh.lodLevels['low_lod']
        ?? mesh.lodLevels['medium_lod']
        ?? mesh.lodLevels['high_lod'];
      if (lod) {
        const parsed = submeshesToCached(lod);
        if (parsed.length > 0) {
          this.cache.set(uuid, parsed);
          this.prune();
        }
      }
    } catch {
      // Asset download can fail for permissions/missing assets — ignore
      // Cache empty to avoid retrying
      this.cache.set(uuid, []);
    }
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
    this.activeDownloads = 0;
  }
}
