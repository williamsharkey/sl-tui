// cloud-cache.ts — Procedural cloud texture generator (SNES-style parallax)

export interface CloudTexture {
  pixels: Uint8Array; // RGBA, w*h*4
  w: number;
  h: number;
}

export interface CloudParams {
  texture: CloudTexture;
  scrollRateX: number;
  scrollRateY: number;
  density1Z: number;  // layer 1 opacity factor
  density2Z: number;  // layer 2 opacity factor
  scale: number;
  shadow: number;     // opacity multiplier 0–1
  colorR: number;     // tint 0–255
  colorG: number;
  colorB: number;
}

/**
 * Generate a procedural cloud texture using 3-octave sine noise.
 * Returns a tileable RGBA texture where alpha = cloud opacity.
 */
export function generateProceduralClouds(w: number, h: number): CloudTexture {
  const pixels = new Uint8Array(w * h * 4);
  const TWO_PI = Math.PI * 2;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Normalize to 0–1, tileable via sin
      const u = x / w;
      const v = y / h;

      // 3-octave sine noise (tileable)
      let val = 0;
      val += Math.sin(u * TWO_PI * 2 + 0.3) * Math.cos(v * TWO_PI * 1.5 + 0.7) * 0.5;
      val += Math.sin(u * TWO_PI * 4 + 1.1) * Math.cos(v * TWO_PI * 3 + 2.3) * 0.25;
      val += Math.sin(u * TWO_PI * 7 + 3.7) * Math.cos(v * TWO_PI * 5 + 1.9) * 0.125;

      // Threshold to create cloud/gap pattern
      const alpha = Math.max(0, Math.min(1, (val + 0.2) * 1.8));

      const i = (y * w + x) * 4;
      pixels[i]     = 255; // R (white cloud)
      pixels[i + 1] = 255; // G
      pixels[i + 2] = 255; // B
      pixels[i + 3] = Math.round(alpha * 255); // A
    }
  }

  return { pixels, w, h };
}

/** Sample alpha from cloud texture at UV coordinates (wrapping). Returns 0–1. */
export function sampleCloudAlpha(tex: CloudTexture, u: number, v: number): number {
  // Wrap to [0, 1)
  u = u - Math.floor(u);
  v = v - Math.floor(v);
  const px = (u * tex.w) | 0;
  const py = (v * tex.h) | 0;
  const i = (py * tex.w + px) * 4 + 3; // alpha channel
  return tex.pixels[i] / 255;
}
