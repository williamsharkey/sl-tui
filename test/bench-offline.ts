// bench-offline.ts — Offline performance benchmark (no SL connection needed)
// Run: npx tsx test/bench-offline.ts
//
// Generates synthetic terrain, objects, and avatars to measure rendering
// pipeline throughput. Reports per-phase timing and identifies bottlenecks.

import {
  projectFrame, projectFirstPerson,
  terrainTexturedRGB, avatarColorFromUUID,
  type FirstPersonParams, type AvatarData, type ObjectData,
} from '../server/grid-state.js';
import { pixelsToCells } from '../server/pixel-to-cells.js';
import { renderFpViewBuf, renderMinimapBuf } from '../tui/renderer.js';
import { computeLayout } from '../tui/screen.js';

// ─── Synthetic data generators ──────────────────────────────────

function generateTerrain(): Float32Array {
  // 256x256 heightmap with hills and valleys
  const data = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      data[y * 256 + x] =
        20 +
        10 * Math.sin(x * 0.03) * Math.cos(y * 0.04) +
        5 * Math.sin(x * 0.08 + y * 0.06) +
        2 * Math.cos(x * 0.15 - y * 0.12);
    }
  }
  return data;
}

function generateObjects(count: number, cx: number, cy: number): ObjectData[] {
  const objects: ObjectData[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const dist = 5 + Math.random() * 35;
    objects.push({
      uuid: `obj-${i.toString(16).padStart(8, '0')}`,
      name: `Object ${i}`,
      x: cx + Math.cos(angle) * dist,
      y: cy + Math.sin(angle) * dist,
      z: 22 + Math.random() * 3,
      scaleX: 0.5 + Math.random() * 3,
      scaleY: 0.5 + Math.random() * 3,
      scaleZ: 0.5 + Math.random() * 5,
      isTree: i % 5 === 0,
      pcode: i % 5 === 0 ? 111 : 9,
      treeSpecies: i % 5 === 0 ? (i % 14) : -1,
      pathCurve: i % 3 === 0 ? 32 : 16,
      profileCurve: i % 4,
      rotX: 0, rotY: 0, rotZ: Math.sin(i) * 0.3, rotW: Math.cos(i * 0.5) * 0.95,
      colorR: 80 + (i * 37) % 150,
      colorG: 60 + (i * 53) % 170,
      colorB: 40 + (i * 71) % 180,
      faceColors: i % 3 === 0 ? [
        [200, 100, 50, 1], [50, 150, 200, 1], [100, 200, 50, 1],
        [200, 200, 50, 1], [50, 100, 200, 1], [200, 50, 100, 1],
      ] : undefined,
      pathTaperX: i % 4 === 0 ? 0.3 : undefined,
      pathTaperY: i % 4 === 0 ? -0.2 : undefined,
      pathTwist: i % 6 === 0 ? 0.5 : undefined,
    });
  }
  return objects;
}

function generateAvatars(count: number, cx: number, cy: number): AvatarData[] {
  const avatars: AvatarData[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const dist = 3 + Math.random() * 25;
    avatars.push({
      uuid: `av-${i.toString(16).padStart(8, '0')}`,
      firstName: `User${i}`,
      lastName: 'Resident',
      x: cx + Math.cos(angle) * dist,
      y: cy + Math.sin(angle) * dist,
      z: 22 + Math.random() * 2,
      yaw: angle + Math.PI,
      isSelf: i === 0,
      velX: Math.random() * 2 - 1,
      velY: Math.random() * 2 - 1,
      velZ: 0,
    });
  }
  return avatars;
}

// ─── Benchmark runner ───────────────────────────────────────────

interface BenchResult {
  name: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
}

function bench(name: string, iterations: number, fn: () => void): BenchResult {
  // Warmup
  for (let i = 0; i < 5; i++) fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  return {
    name,
    avgMs: avg,
    minMs: times[0],
    maxMs: times[times.length - 1],
    p95Ms: times[Math.floor(times.length * 0.95)],
  };
}

function printResult(r: BenchResult): void {
  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number) => n.toFixed(2).padStart(8);
  console.log(`  ${pad(r.name, 32)} avg:${num(r.avgMs)} ms  min:${num(r.minMs)}  p95:${num(r.p95Ms)}  max:${num(r.maxMs)}`);
}

// ─── Main ───────────────────────────────────────────────────────

const COLS = 120;
const ROWS = 40;
const ITERATIONS = 200;

const terrainData = generateTerrain();
const terrainFn = (x: number, y: number): number => {
  const ix = Math.max(0, Math.min(255, Math.floor(x)));
  const iy = Math.max(0, Math.min(255, Math.floor(y)));
  return terrainData[iy * 256 + ix];
};

const selfX = 128, selfY = 128, selfZ = 23.8;
const waterHeight = 20;

const objects = generateObjects(150, selfX, selfY);
const avatars = generateAvatars(20, selfX, selfY);
const layout = computeLayout(COLS, ROWS);

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║          SL-TUI Rendering Pipeline Benchmark                ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`  Terminal: ${COLS}x${ROWS}  Pixel: ${layout.fpCols * 2}x${layout.fpRows * 3}  Iterations: ${ITERATIONS}`);
console.log(`  Objects: ${objects.length}  Avatars: ${avatars.length}`);
console.log();

const results: BenchResult[] = [];

// 1. Voxel raycast FP render
const fpParams: FirstPersonParams = {
  selfX, selfY, selfZ, yaw: Math.PI / 2,
  waterHeight, terrainTexture: true,
};

results.push(bench('Voxel FP (raycast + p2c)', ITERATIONS, () => {
  fpParams.yaw = Math.PI / 2 + Math.random() * 0.02;
  projectFirstPerson(terrainFn, avatars, objects, fpParams, layout.fpCols, layout.fpRows);
}));

// 2. Flying FP render (extended draw distance + pitch)
const flyParams: FirstPersonParams = {
  selfX, selfY, selfZ: selfZ + 50, yaw: Math.PI / 2,
  waterHeight, flying: true, terrainHeight: 22, terrainTexture: true,
};

results.push(bench('Flying FP (extended draw)', ITERATIONS, () => {
  flyParams.yaw = Math.PI / 2 + Math.random() * 0.02;
  projectFirstPerson(terrainFn, avatars, objects, flyParams, layout.fpCols, layout.fpRows);
}));

// 3. Minimap projection
results.push(bench('Minimap projection', ITERATIONS, () => {
  projectFrame(terrainFn, avatars, objects, {
    cols: layout.minimapCols, rows: layout.minimapRows,
    selfX, selfY, selfZ, waterHeight, metersPerCell: 2, yaw: Math.PI / 2,
  }, false);
}));

// 4. pixelsToCells isolation
const pw = layout.fpCols * 2, ph = layout.fpRows * 3;
const fakePixels = new Uint8Array(pw * ph * 4);
for (let i = 0; i < fakePixels.length; i += 4) {
  fakePixels[i] = Math.floor(Math.random() * 256);
  fakePixels[i + 1] = Math.floor(Math.random() * 256);
  fakePixels[i + 2] = Math.floor(Math.random() * 256);
  fakePixels[i + 3] = 255;
}

results.push(bench('pixelsToCells (sextant)', ITERATIONS, () => {
  pixelsToCells(fakePixels, pw, ph, 0x1a, 0x1a, 0x2e);
}));

// 5. ANSI render (FP view)
const fpFrame = projectFirstPerson(terrainFn, avatars, objects, fpParams, layout.fpCols, layout.fpRows);
let totalAnsiBytes = 0;

results.push(bench('ANSI render (FP view)', ITERATIONS, () => {
  const out = renderFpViewBuf(layout, fpFrame);
  totalAnsiBytes += out.length;
}));

// 6. ANSI render (minimap)
const mmFrame = projectFrame(terrainFn, avatars, objects, {
  cols: layout.minimapCols, rows: layout.minimapRows,
  selfX, selfY, selfZ, waterHeight, metersPerCell: 2, yaw: Math.PI / 2,
}, false);

results.push(bench('ANSI render (minimap)', ITERATIONS, () => {
  renderMinimapBuf(layout, mmFrame);
}));

// 7. terrainRGB color computation
results.push(bench('terrainTexturedRGB (10K)', ITERATIONS, () => {
  for (let i = 0; i < 10000; i++) {
    terrainTexturedRGB(15 + Math.random() * 40, 20, Math.random() * 256, Math.random() * 256);
  }
}));

// 8. avatarColorFromUUID
results.push(bench('avatarColorFromUUID (1K)', ITERATIONS, () => {
  for (let i = 0; i < 1000; i++) {
    avatarColorFromUUID(`av-${i.toString(16).padStart(8, '0')}`);
  }
}));

// ─── Report ─────────────────────────────────────────────────────
console.log('Phase                            avg (ms)      min       p95       max');
console.log('─'.repeat(78));
for (const r of results) printResult(r);
console.log('─'.repeat(78));

// Total frame time estimate (FP + minimap + ANSI)
const fpRender = results[0].avgMs;
const mmRender = results[2].avgMs;
const ansiRender = results[4].avgMs + results[5].avgMs;
const totalFrame = fpRender + mmRender + ansiRender;

console.log();
console.log(`  Estimated frame time:  ${totalFrame.toFixed(2)} ms`);
console.log(`  Theoretical FPS:       ${(1000 / totalFrame).toFixed(1)}`);
console.log(`  Target (15 Hz):        ${(66.67).toFixed(2)} ms budget`);
console.log(`  Budget headroom:       ${(66.67 - totalFrame).toFixed(2)} ms (${((66.67 - totalFrame) / 66.67 * 100).toFixed(0)}%)`);
console.log(`  Avg ANSI output:       ${(totalAnsiBytes / ITERATIONS / 1024).toFixed(1)} KB`);

// Identify bottleneck
const sorted = [...results].sort((a, b) => b.avgMs - a.avgMs);
console.log();
console.log(`  Bottleneck: ${sorted[0].name} (${sorted[0].avgMs.toFixed(2)} ms, ${(sorted[0].avgMs / totalFrame * 100).toFixed(0)}% of frame)`);

process.exit(0);
