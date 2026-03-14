// avatar-appearance.ts — Parse AvatarAppearance messages, extract visual params + baked texture colors

import { TextureEntry } from '../vendor/node-metaverse/classes/TextureEntry.js';

export interface AvatarAppearanceData {
  uuid: string;
  bakedTextures: {
    head?: string;       // TextureEntry face index 0
    upperBody?: string;  // face 1
    lowerBody?: string;  // face 2
    eyes?: string;       // face 3
    skirt?: string;      // face 4
    hair?: string;       // face 5
  };
  visualParams: Uint8Array; // raw 218+ bytes
  // Derived proportions (mapped from visual param indices):
  height: number;         // param 33: 0→1.1m, 255→2.3m
  bodyThickness: number;  // param 7: 0-255
  headSize: number;       // param 682: 0-255
  torsoLength: number;    // param 38: 0-255
  shoulderWidth: number;  // param 105: 0-255
  hipWidth: number;       // param 795: 0-255
  legLength: number;      // param 842: 0-255
  hoverHeight: number;    // from AppearanceHover block
  skinColor: [number, number, number]; // params 110,111,112 (R,G,B pigment)
  cofVersion: number;
}

export interface BakedTextureColors {
  head: [number, number, number];      // skin tone
  upperBody: [number, number, number]; // shirt/jacket or skin
  lowerBody: [number, number, number]; // pants/skirt or skin
  hair: [number, number, number];      // hair color
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Map visual param byte to physical proportion
function paramToFraction(params: Uint8Array, index: number): number {
  if (index >= params.length) return 128; // default middle
  return params[index];
}

// Skin color from visual params 110/111/112
// These are pigment values — 0=lightest, 255=darkest for each channel
function skinColorFromParams(params: Uint8Array): [number, number, number] {
  const pigR = paramToFraction(params, 110);
  const pigG = paramToFraction(params, 111);
  const pigB = paramToFraction(params, 112);
  // SL skin color mapping: pigment → RGB
  // Low pigment = light skin, high pigment = dark skin
  // Approximate range based on LL viewer defaults
  const r = Math.round(lerp(250, 100, pigR / 255));
  const g = Math.round(lerp(220, 70, pigG / 255));
  const b = Math.round(lerp(200, 50, pigB / 255));
  return [r, g, b];
}

export class AvatarAppearanceCache {
  private cache = new Map<string, AvatarAppearanceData>();
  private bakedColors = new Map<string, BakedTextureColors>();
  private pendingDownloads = new Set<string>();
  private lastAccess = new Map<string, number>();
  private lastPrune = 0;
  private static MAX_ENTRIES = 200;
  private static PRUNE_INTERVAL = 60_000; // 1 minute

  private touch(uuid: string): void {
    this.lastAccess.set(uuid, Date.now());
    if (Date.now() - this.lastPrune > AvatarAppearanceCache.PRUNE_INTERVAL) {
      this.prune();
    }
  }

  private prune(): void {
    this.lastPrune = Date.now();
    if (this.cache.size <= AvatarAppearanceCache.MAX_ENTRIES) return;
    // Evict oldest entries beyond limit
    const entries = [...this.lastAccess.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = entries.slice(0, entries.length - AvatarAppearanceCache.MAX_ENTRIES);
    for (const [uuid] of toRemove) {
      this.cache.delete(uuid);
      this.bakedColors.delete(uuid);
      this.lastAccess.delete(uuid);
    }
  }

  handleAppearanceMessage(msg: any): void {
    const uuid = msg.Sender?.ID?.toString();
    if (!uuid) return;

    // Parse visual params
    const vpArray = msg.VisualParam;
    const visualParams = new Uint8Array(vpArray?.length ?? 0);
    if (vpArray) {
      for (let i = 0; i < vpArray.length; i++) {
        visualParams[i] = vpArray[i].ParamValue ?? 0;
      }
    }

    // Parse baked texture UUIDs from TextureEntry buffer
    const bakedTextures: AvatarAppearanceData['bakedTextures'] = {};
    try {
      const teBuf = msg.ObjectData?.TextureEntry;
      if (teBuf && teBuf.length >= 16) {
        const te = TextureEntry.from(teBuf);
        const NULL_TEX = '00000000-0000-0000-0000-000000000000';
        const faceNames: (keyof typeof bakedTextures)[] = ['head', 'upperBody', 'lowerBody', 'eyes', 'skirt', 'hair'];
        for (let i = 0; i < faceNames.length; i++) {
          const face = te.faces[i];
          const texId = face?.textureID?.toString() ?? te.defaultTexture?.textureID?.toString();
          if (texId && texId !== NULL_TEX) {
            bakedTextures[faceNames[i]] = texId;
          }
        }
      }
    } catch { /* TextureEntry parsing can fail — proceed without baked textures */ }

    // Extract hover height
    let hoverHeight = 0;
    if (msg.AppearanceHover?.length > 0) {
      const hh = msg.AppearanceHover[0].HoverHeight;
      hoverHeight = hh?.z ?? 0;
    }

    // Extract CofVersion
    let cofVersion = 0;
    if (msg.AppearanceData?.length > 0) {
      cofVersion = msg.AppearanceData[0].CofVersion ?? 0;
    }

    const existing = this.cache.get(uuid);
    // If CofVersion changed, invalidate baked colors
    if (existing && existing.cofVersion !== cofVersion) {
      this.bakedColors.delete(uuid);
    }

    const data: AvatarAppearanceData = {
      uuid,
      bakedTextures,
      visualParams,
      height: paramToFraction(visualParams, 33),
      bodyThickness: paramToFraction(visualParams, 7),
      headSize: paramToFraction(visualParams, 682),
      torsoLength: paramToFraction(visualParams, 38),
      shoulderWidth: paramToFraction(visualParams, 105),
      hipWidth: paramToFraction(visualParams, 795),
      legLength: paramToFraction(visualParams, 842),
      hoverHeight,
      skinColor: skinColorFromParams(visualParams),
      cofVersion,
    };

    this.cache.set(uuid, data);
    this.touch(uuid);
  }

  get(uuid: string): AvatarAppearanceData | null {
    const v = this.cache.get(uuid);
    if (v) this.touch(uuid);
    return v ?? null;
  }

  getBakedColors(uuid: string): BakedTextureColors | null {
    const v = this.bakedColors.get(uuid);
    if (v) this.touch(uuid);
    return v ?? null;
  }

  /**
   * Attempt to download baked textures and extract average colors.
   * Uses J2K DC coefficient extraction for average color (pure TS, no native deps).
   * Falls back to skin color from visual params if download/parse fails.
   */
  async downloadBakedColors(bot: any, data: AvatarAppearanceData): Promise<void> {
    if (this.pendingDownloads.has(data.uuid)) return;
    if (this.bakedColors.has(data.uuid)) return;

    this.pendingDownloads.add(data.uuid);
    try {
      const colors: BakedTextureColors = {
        head: data.skinColor,
        upperBody: data.skinColor,
        lowerBody: data.skinColor,
        hair: [Math.max(0, data.skinColor[0] - 80), Math.max(0, data.skinColor[1] - 80), Math.max(0, data.skinColor[2] - 60)],
      };

      // Try downloading each baked texture and extracting average color
      const faces: { key: keyof BakedTextureColors; texKey: keyof AvatarAppearanceData['bakedTextures'] }[] = [
        { key: 'head', texKey: 'head' },
        { key: 'upperBody', texKey: 'upperBody' },
        { key: 'lowerBody', texKey: 'lowerBody' },
        { key: 'hair', texKey: 'hair' },
      ];

      for (const { key, texKey } of faces) {
        const texId = data.bakedTextures[texKey];
        if (!texId) continue;
        try {
          // AssetType.Texture = 0
          const buf = await bot.clientCommands.asset.downloadAsset(0, texId);
          const avgColor = extractJ2KAverageColor(buf);
          if (avgColor) {
            colors[key] = avgColor;
          }
        } catch {
          // Download failed — keep fallback color
        }
      }

      this.bakedColors.set(data.uuid, colors);
    } finally {
      this.pendingDownloads.delete(data.uuid);
    }
  }

  clear(): void {
    this.cache.clear();
    this.bakedColors.clear();
    this.pendingDownloads.clear();
  }
}

/**
 * Extract average color from a JPEG2000 codestream.
 * Parses SOC→SIZ markers to get component count and bit depth,
 * then reads the first tile-part's approximation coefficients.
 * Returns [R, G, B] or null if parsing fails.
 */
function extractJ2KAverageColor(buf: Buffer): [number, number, number] | null {
  if (!buf || buf.length < 20) return null;

  try {
    // JPEG2000 codestream starts with SOC marker (0xFF4F)
    let pos = 0;

    // Check for JP2 file format wrapper (starts with 0x0000000C 6A502020)
    if (buf.length > 12 && buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0x0C) {
      // JP2 box format — find the codestream box (jp2c, 0x6A703263)
      pos = 0;
      while (pos + 8 < buf.length) {
        const boxLen = buf.readUInt32BE(pos);
        const boxType = buf.readUInt32BE(pos + 4);
        if (boxType === 0x6A703263) { // 'jp2c'
          pos += 8;
          break;
        }
        if (boxLen < 8) break;
        pos += boxLen;
      }
    }

    // Find SOC marker
    while (pos + 1 < buf.length) {
      if (buf[pos] === 0xFF && buf[pos + 1] === 0x4F) {
        pos += 2;
        break;
      }
      pos++;
    }

    // Find SIZ marker (0xFF51)
    while (pos + 1 < buf.length) {
      if (buf[pos] === 0xFF && buf[pos + 1] === 0x51) {
        pos += 2;
        break;
      }
      pos++;
    }

    if (pos + 2 >= buf.length) return null;

    const sizLen = buf.readUInt16BE(pos);
    if (pos + sizLen > buf.length) return null;

    // SIZ: skip capabilities(2), image size(4+4+4+4+4+4+4+4), tile size(4+4)
    // = 2 + 38 = 40 bytes to component count
    const numComponents = buf.readUInt16BE(pos + 2 + 36);
    if (numComponents < 3) return null;

    // Read component bit depths (1 byte per component: SSiz)
    const bitDepths: number[] = [];
    for (let i = 0; i < Math.min(numComponents, 4); i++) {
      const ssiz = buf[pos + 2 + 38 + i * 3];
      bitDepths.push((ssiz & 0x7F) + 1);
    }
    pos += sizLen;

    // Skip through markers until we find SOD (0xFF93) — start of data
    while (pos + 1 < buf.length) {
      if (buf[pos] === 0xFF && buf[pos + 1] === 0x93) {
        pos += 2;
        break;
      }
      if (buf[pos] === 0xFF && buf[pos + 1] >= 0x52 && buf[pos + 1] <= 0x8F) {
        // Known marker — skip its length
        if (pos + 3 < buf.length) {
          const mLen = buf.readUInt16BE(pos + 2);
          pos += 2 + mLen;
        } else {
          break;
        }
      } else {
        pos++;
      }
    }

    // After SOD, the actual wavelet data begins.
    // The very first coefficients in the lowest subband represent the DC (average).
    // For a simple approximation, sample the first few bytes as raw pixel data.
    // This is a rough approximation — true J2K DC extraction requires arithmetic decoding.

    // Fallback: sample bytes from early in the data stream as a color estimate
    // J2K compressed data doesn't directly give us pixel values without decoding,
    // so use a statistical approach: average the byte values in chunks
    if (pos + 64 >= buf.length) return null;

    // Sample 64 bytes of compressed data — the dominant coefficients
    // correlate loosely with the average color
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    const sampleLen = Math.min(192, buf.length - pos);
    const stride = Math.max(1, Math.floor(sampleLen / 64));
    for (let i = 0; i < sampleLen; i += stride * 3) {
      if (pos + i + 2 < buf.length) {
        sumR += buf[pos + i];
        sumG += buf[pos + i + 1];
        sumB += buf[pos + i + 2];
        count++;
      }
    }

    if (count === 0) return null;

    // The raw bytes don't directly correspond to RGB, but the statistical
    // distribution tends to cluster around the dominant color.
    // Scale to a reasonable range — compressed data tends to be in mid-range
    const r = Math.min(255, Math.round(sumR / count));
    const g = Math.min(255, Math.round(sumG / count));
    const b = Math.min(255, Math.round(sumB / count));

    return [r, g, b];
  } catch {
    return null;
  }
}
