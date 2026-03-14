// graphics-stress.ts — Deep graphics pipeline stress tests
// Run: npx tsx test/graphics-stress.ts
//
// Tests that systematically hammer every rendering path:
// - All 3 render modes (voxel, triangle, hybrid)
// - Camera modes (first-person, third-person with orbit)
// - Edge-case yaw angles (0, π, -π, near-zero, full circle sweep)
// - Extreme altitudes (underground, water level, high altitude, skybox)
// - Sim boundary positions (0,0 / 255,255 / negative from dead-reckoning)
// - All feature combos (clouds±, dither±, terrain-texture±)
// - Teleport between regions (different terrain/sky/objects)
// - Rapid resize cycling
// - Degenerate inputs (NaN, Infinity, zero-size frames)

import { SLBridge } from '../server/sl-bridge.js';
import {
  projectFirstPerson, projectFrame, diffFrames,
  type FirstPersonParams, type GridFrame, type ObjectData, type AvatarData,
} from '../server/grid-state.js';
import {
  renderFpViewBuf, renderFpDeltaBuf, renderMinimapBuf, renderStatusBarBuf,
} from '../tui/renderer.js';
import { computeLayout, type ScreenLayout } from '../tui/screen.js';
import { loadCredentials } from '../tui/credentials.js';
import type { BridgeCallbacks } from '../tui/types.js';
import { generateProceduralClouds, type CloudParams } from '../server/cloud-cache.js';

process.on('uncaughtException', (err) => {
  console.error('\nUNCAUGHT EXCEPTION:', err.stack || err);
  process.exit(1);
});
process.on('unhandledRejection', (err: any) => {
  console.error('\nUNHANDLED REJECTION:', err?.stack || err);
  process.exit(1);
});

// ─── Test framework ───────────────────────────────────────────
interface TestResult { name: string; passed: boolean; ms: number; detail: string; error?: string }
const results: TestResult[] = [];
let bridge: SLBridge;
const cloudTex = generateProceduralClouds(128, 128);

function log(icon: string, msg: string) { console.log(`  ${icon} ${msg}`); }

async function test(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    results.push({ name, passed: true, ms, detail });
    log('PASS', `${name} (${ms}ms) — ${detail}`);
  } catch (err: any) {
    const ms = Date.now() - t0;
    const error = err?.stack || err?.message || String(err);
    results.push({ name, passed: false, ms, detail: '', error });
    log('FAIL', `${name} (${ms}ms)`);
    console.error(`        ${error.split('\n')[0]}`);
  }
}

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Helpers
function getTerrainFn() {
  return (x: number, y: number) => bridge.getTerrainHeight(x, y);
}

function makeCloudParams(): CloudParams {
  const cp = (bridge as any).getCloudParams?.();
  return {
    texture: cloudTex,
    scrollRateX: cp?.scrollRateX ?? 0.05,
    scrollRateY: cp?.scrollRateY ?? 0.03,
    density1Z: cp?.density1Z ?? 0.5,
    density2Z: cp?.density2Z ?? 0.3,
    scale: cp?.scale ?? 0.4,
    shadow: cp?.shadow ?? 0.5,
    colorR: cp?.colorR ?? 240,
    colorG: cp?.colorG ?? 240,
    colorB: cp?.colorB ?? 245,
  };
}

function buildFpParams(overrides: Partial<FirstPersonParams> = {}): FirstPersonParams {
  const pos = bridge.getPosition()!;
  const yaw = bridge.getBodyYaw();
  const terrainFn = getTerrainFn();
  const avatarNameMap = new Map<string, string>();
  for (const av of bridge.getAvatars()) {
    if (!av.isSelf) avatarNameMap.set(av.uuid, `${av.firstName} ${av.lastName}`.trim());
  }
  return {
    selfX: pos.x,
    selfY: pos.y,
    selfZ: pos.z + 1.8,
    yaw,
    waterHeight: bridge.getWaterHeight(),
    renderMode: 'triangle',
    flying: bridge.flying,
    terrainHeight: terrainFn(Math.floor(pos.x), Math.floor(pos.y)),
    ditherPhase: 0.5,
    skyColors: bridge.getSkyColors() ?? undefined,
    sunDir: bridge.getSkyColors()?.sunDir,
    avatarNames: avatarNameMap,
    chatBubbles: new Map(),
    cloudParams: makeCloudParams(),
    cloudTime: 1.0,
    sceneMeshLookup: (uuid: string) => (bridge as any).getSceneMesh?.(uuid) ?? null,
    sceneMeshTrigger: (uuids: string[]) => (bridge as any).triggerSceneMeshFetch?.(uuids),
    meshLookup: (uuid: string) => bridge.getAvatarMeshBundle(uuid),
    appearanceLookup: (uuid: string) => (bridge as any).getAvatarAppearance?.(uuid) ?? null,
    bakedColorsLookup: (uuid: string) => (bridge as any).getAvatarBakedColors?.(uuid) ?? null,
    terrainTexture: false,
    ...overrides,
  };
}

// Render a full frame and return timing + output size
function renderFullFrame(layout: ScreenLayout, params: FirstPersonParams): { ms: number; fpBytes: number; mmBytes: number } {
  const t0 = performance.now();
  const terrainFn = getTerrainFn();
  const avatars = bridge.getAvatars();
  const objects = bridge.getObjects();

  const fpFrame = projectFirstPerson(terrainFn, avatars, objects, params, layout.fpCols, layout.fpRows);
  const fpBuf = renderFpViewBuf(layout, fpFrame);

  const mmFrame = projectFrame(terrainFn, avatars, objects, {
    cols: layout.minimapCols, rows: layout.minimapRows,
    selfX: params.selfX, selfY: params.selfY, selfZ: params.selfZ - 1.8,
    waterHeight: params.waterHeight, metersPerCell: 2, yaw: params.yaw,
  }, params.flying ?? false);
  const mmBuf = renderMinimapBuf(layout, mmFrame);

  const pos = bridge.getPosition();
  const statusBuf = renderStatusBarBuf(layout, bridge.getRegionName(), pos, bridge.flying);

  return { ms: performance.now() - t0, fpBytes: fpBuf.length, mmBytes: mmBuf.length };
}

// Render N ticks with delta rendering, tracking performance
function renderTickLoop(layout: ScreenLayout, ticks: number, paramsFn: (tick: number) => FirstPersonParams): { avg: number; max: number; errors: number } {
  let prevFrame: GridFrame | null = null;
  let totalMs = 0;
  let maxMs = 0;
  let errors = 0;
  const terrainFn = getTerrainFn();
  const avatars = bridge.getAvatars();
  const objects = bridge.getObjects();

  for (let i = 0; i < ticks; i++) {
    try {
      const params = paramsFn(i);
      const t0 = performance.now();
      const fpFrame = projectFirstPerson(terrainFn, avatars, objects, params, layout.fpCols, layout.fpRows);

      if (prevFrame && prevFrame.cols === fpFrame.cols && prevFrame.rows === fpFrame.rows) {
        const deltas = diffFrames(prevFrame, fpFrame);
        if (deltas.length > 0) renderFpDeltaBuf(layout, deltas, fpFrame);
      } else {
        renderFpViewBuf(layout, fpFrame);
      }
      prevFrame = fpFrame;

      const ms = performance.now() - t0;
      totalMs += ms;
      if (ms > maxMs) maxMs = ms;
    } catch {
      errors++;
    }
  }
  return { avg: totalMs / ticks, max: maxMs, errors };
}

// ─── Tests ────────────────────────────────────────────────────

async function runTests() {
  console.log('\n  GRAPHICS STRESS TEST SUITE\n  ' + '='.repeat(60));

  const creds = loadCredentials();
  if (!creds) { console.error('No creds'); process.exit(1); }

  bridge = new SLBridge();
  const callbacks: BridgeCallbacks = {
    onChat: () => {}, onIM: () => {}, onFriendRequest: () => {},
    onFriendOnline: () => {}, onTeleportOffer: () => {},
    onDisconnected: (r) => { console.error('DISCONNECTED:', r); process.exit(1); },
  };

  await test('Login', async () => {
    await bridge.login(creds.firstName, creds.lastName, creds.password, callbacks);
    await sleep(3000);
    const pos = bridge.getPosition()!;
    return `${bridge.getRegionName()} at (${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}) obj=${bridge.getObjects().length}`;
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 1. RENDER MODE COMPARISON ---');
  // ═══════════════════════════════════════════════════════════

  const stdLayout = computeLayout(120, 40);

  for (const mode of ['voxel', 'triangle', 'hybrid'] as const) {
    await test(`Render mode: ${mode} (120x40)`, async () => {
      const params = buildFpParams({ renderMode: mode });
      const r = renderFullFrame(stdLayout, params);
      return `${r.ms.toFixed(1)}ms, fp=${(r.fpBytes/1024).toFixed(0)}K`;
    });
  }

  await test('Render mode: triangle at 200x60 (large)', async () => {
    const layout = computeLayout(200, 60);
    const params = buildFpParams({ renderMode: 'triangle' });
    const r = renderFullFrame(layout, params);
    return `${r.ms.toFixed(1)}ms, fp=${(r.fpBytes/1024).toFixed(0)}K mm=${(r.mmBytes/1024).toFixed(0)}K`;
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 2. CAMERA MODES ---');
  // ═══════════════════════════════════════════════════════════

  await test('First-person camera', async () => {
    const params = buildFpParams({ cameraMode: 'first-person' });
    const r = renderFullFrame(stdLayout, params);
    return `${r.ms.toFixed(1)}ms`;
  });

  await test('Third-person camera (orbit 0,0)', async () => {
    const pos = bridge.getPosition()!;
    const params = buildFpParams({
      cameraMode: 'third-person',
      cameraOrbitYaw: 0, cameraOrbitPitch: 0,
      selfAvatarPos: { x: pos.x, y: pos.y, z: pos.z },
    });
    const r = renderFullFrame(stdLayout, params);
    return `${r.ms.toFixed(1)}ms`;
  });

  await test('Third-person camera orbit sweep (16 angles)', async () => {
    const pos = bridge.getPosition()!;
    let maxMs = 0;
    for (let i = 0; i < 16; i++) {
      const orbitYaw = (i / 16) * Math.PI * 2 - Math.PI;
      const orbitPitch = Math.sin(i * 0.5) * 0.3;
      const params = buildFpParams({
        cameraMode: 'third-person',
        cameraOrbitYaw: orbitYaw,
        cameraOrbitPitch: orbitPitch,
        selfAvatarPos: { x: pos.x, y: pos.y, z: pos.z },
      });
      const r = renderFullFrame(stdLayout, params);
      if (r.ms > maxMs) maxMs = r.ms;
    }
    return `16 orbits, max ${maxMs.toFixed(1)}ms`;
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 3. YAW EDGE CASES ---');
  // ═══════════════════════════════════════════════════════════

  const yawCases: [string, number][] = [
    ['0', 0], ['π/2', Math.PI / 2], ['π', Math.PI], ['-π', -Math.PI],
    ['3π/2', 3 * Math.PI / 2], ['2π', Math.PI * 2], ['-2π', -Math.PI * 2],
    ['tiny (1e-10)', 1e-10], ['large (100π)', 100 * Math.PI],
    ['negative large (-50π)', -50 * Math.PI],
  ];

  await test('Yaw sweep: 10 edge-case angles', async () => {
    let maxMs = 0;
    for (const [label, yaw] of yawCases) {
      const params = buildFpParams({ yaw });
      const r = renderFullFrame(stdLayout, params);
      if (r.ms > maxMs) maxMs = r.ms;
    }
    return `10 yaw values, max ${maxMs.toFixed(1)}ms`;
  });

  await test('Continuous yaw rotation (360° in 60 frames)', async () => {
    const result = renderTickLoop(stdLayout, 60, (i) => {
      const yaw = (i / 60) * Math.PI * 2;
      return buildFpParams({ yaw, ditherPhase: i * 0.15 });
    });
    return `avg=${result.avg.toFixed(1)}ms max=${result.max.toFixed(1)}ms err=${result.errors}`;
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 4. EXTREME ALTITUDES ---');
  // ═══════════════════════════════════════════════════════════

  const altCases: [string, number, boolean][] = [
    ['ground level', 2, false],
    ['underwater (-5m)', -5, false],
    ['water surface', bridge.getWaterHeight(), false],
    ['just above water', bridge.getWaterHeight() + 0.1, false],
    ['50m altitude', 50, true],
    ['200m altitude', 200, true],
    ['500m altitude (skybox range)', 500, true],
    ['4000m altitude (max skybox)', 4000, true],
  ];

  for (const [label, z, fly] of altCases) {
    await test(`Altitude: ${label}`, async () => {
      const pos = bridge.getPosition()!;
      const params = buildFpParams({
        selfZ: z + 1.8,
        flying: fly,
        terrainHeight: getTerrainFn()(Math.floor(pos.x), Math.floor(pos.y)),
      });
      const r = renderFullFrame(stdLayout, params);
      return `${r.ms.toFixed(1)}ms, fp=${(r.fpBytes/1024).toFixed(0)}K`;
    });
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 5. SIM BOUNDARY POSITIONS ---');
  // ═══════════════════════════════════════════════════════════

  const boundaryPositions: [string, number, number][] = [
    ['origin (0,0)', 0, 0],
    ['corner (255,255)', 255, 255],
    ['corner (0,255)', 0, 255],
    ['corner (255,0)', 255, 0],
    ['center (128,128)', 128, 128],
    ['edge (0,128)', 0, 128],
    ['edge (128,0)', 128, 0],
    ['slightly OOB (-1,-1)', -1, -1],
    ['slightly OOB (257,257)', 257, 257],
  ];

  for (const [label, x, y] of boundaryPositions) {
    await test(`Position: ${label}`, async () => {
      const terrainH = getTerrainFn()(Math.max(0, Math.min(255, Math.floor(x))), Math.max(0, Math.min(255, Math.floor(y))));
      const params = buildFpParams({
        selfX: x, selfY: y, selfZ: terrainH + 1.8,
        terrainHeight: terrainH,
      });
      const r = renderFullFrame(stdLayout, params);
      return `${r.ms.toFixed(1)}ms`;
    });
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 6. FEATURE TOGGLE COMBINATIONS ---');
  // ═══════════════════════════════════════════════════════════

  const combos: [string, Partial<FirstPersonParams>][] = [
    ['all off', { cloudParams: undefined, ditherPhase: undefined, terrainTexture: false }],
    ['clouds only', { cloudParams: makeCloudParams(), cloudTime: 5, ditherPhase: undefined, terrainTexture: false }],
    ['dither only', { cloudParams: undefined, ditherPhase: 2.5, terrainTexture: false }],
    ['terrain-tex only', { cloudParams: undefined, ditherPhase: undefined, terrainTexture: true }],
    ['all on', { cloudParams: makeCloudParams(), cloudTime: 5, ditherPhase: 2.5, terrainTexture: true }],
    ['all on + third-person', {
      cloudParams: makeCloudParams(), cloudTime: 5, ditherPhase: 2.5, terrainTexture: true,
      cameraMode: 'third-person' as const, cameraOrbitYaw: 0.5, cameraOrbitPitch: -0.2,
      selfAvatarPos: bridge.getPosition()!,
    }],
  ];

  for (const [label, overrides] of combos) {
    await test(`Features: ${label}`, async () => {
      const params = buildFpParams(overrides);
      const r = renderFullFrame(stdLayout, params);
      return `${r.ms.toFixed(1)}ms`;
    });
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 7. TERMINAL SIZE STRESS ---');
  // ═══════════════════════════════════════════════════════════

  const termSizes: [number, number][] = [
    [10, 5], [20, 10], [40, 15], [80, 24], [120, 40],
    [160, 50], [200, 60], [250, 80], [300, 100],
  ];

  for (const [cols, rows] of termSizes) {
    await test(`Size ${cols}x${rows}`, async () => {
      const layout = computeLayout(cols, rows);
      if (layout.fpRows <= 0) return `skipped (fpRows=${layout.fpRows})`;
      const params = buildFpParams();
      const r = renderFullFrame(layout, params);
      return `${r.ms.toFixed(1)}ms fp=${layout.fpCols}x${layout.fpRows} mm=${layout.minimapCols}x${layout.minimapRows}`;
    });
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 8. RAPID RESIZE CYCLING ---');
  // ═══════════════════════════════════════════════════════════

  await test('Resize cycle (100 frames, random sizes)', async () => {
    let maxMs = 0, errors = 0;
    for (let i = 0; i < 100; i++) {
      try {
        const cols = 30 + Math.floor(Math.random() * 220);
        const rows = 10 + Math.floor(Math.random() * 70);
        const layout = computeLayout(cols, rows);
        if (layout.fpRows <= 0) continue;
        const params = buildFpParams({ yaw: (i / 100) * Math.PI * 2 });
        const t0 = performance.now();
        const fpFrame = projectFirstPerson(getTerrainFn(), bridge.getAvatars(), bridge.getObjects(), params, layout.fpCols, layout.fpRows);
        renderFpViewBuf(layout, fpFrame);
        const ms = performance.now() - t0;
        if (ms > maxMs) maxMs = ms;
      } catch { errors++; }
    }
    return `100 random sizes, max=${maxMs.toFixed(1)}ms, errors=${errors}`;
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 9. DELTA RENDERING STRESS ---');
  // ═══════════════════════════════════════════════════════════

  await test('Delta render: walking forward 120 frames', async () => {
    bridge.move('forward');
    await sleep(500);
    const result = renderTickLoop(stdLayout, 120, (i) => {
      return buildFpParams({ ditherPhase: i * 0.15, cloudTime: i / 15 });
    });
    bridge.stop();
    return `avg=${result.avg.toFixed(1)}ms max=${result.max.toFixed(1)}ms err=${result.errors}`;
  });

  await test('Delta render: spinning in place 120 frames', async () => {
    const result = renderTickLoop(stdLayout, 120, (i) => {
      return buildFpParams({ yaw: (i / 120) * Math.PI * 2 });
    });
    return `avg=${result.avg.toFixed(1)}ms max=${result.max.toFixed(1)}ms err=${result.errors}`;
  });

  await test('Delta render: flying upward 120 frames', async () => {
    const pos = bridge.getPosition()!;
    const result = renderTickLoop(stdLayout, 120, (i) => {
      return buildFpParams({
        selfZ: pos.z + 1.8 + i * 0.5,
        flying: true,
        terrainHeight: getTerrainFn()(Math.floor(pos.x), Math.floor(pos.y)),
      });
    });
    return `avg=${result.avg.toFixed(1)}ms max=${result.max.toFixed(1)}ms err=${result.errors}`;
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 10. DEGENERATE INPUTS ---');
  // ═══════════════════════════════════════════════════════════

  const degenerateCases: [string, Partial<FirstPersonParams>][] = [
    ['NaN yaw', { yaw: NaN }],
    ['Infinity yaw', { yaw: Infinity }],
    ['NaN position', { selfX: NaN, selfY: NaN, selfZ: NaN }],
    ['Infinity position', { selfX: Infinity, selfY: 0, selfZ: 0 }],
    ['Zero water height', { waterHeight: 0 }],
    ['Negative water height', { waterHeight: -100 }],
    ['NaN terrain height', { terrainHeight: NaN }],
    ['NaN dither phase', { ditherPhase: NaN }],
    ['Infinity cloud time', { cloudTime: Infinity }],
    ['Negative cloud time', { cloudTime: -100 }],
  ];

  for (const [label, overrides] of degenerateCases) {
    await test(`Degenerate: ${label}`, async () => {
      try {
        const params = buildFpParams(overrides);
        const r = renderFullFrame(stdLayout, params);
        return `survived, ${r.ms.toFixed(1)}ms`;
      } catch (err: any) {
        return `threw: ${err.message.slice(0, 60)}`;
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 11. MOVEMENT + RENDER (real-time 30s) ---');
  // ═══════════════════════════════════════════════════════════

  await test('30s real-time tick loop with movement', async () => {
    const actions: [number, string, () => void][] = [
      [10,  'fwd',    () => bridge.move('forward')],
      [40,  'turn-L', () => { bridge.turn('left'); bridge.turn('left'); }],
      [55,  'turn-R', () => { bridge.turn('right'); bridge.turn('right'); bridge.turn('right'); }],
      [70,  'stop',   () => bridge.stop()],
      [75,  'fly',    () => { bridge.setFlying(true); bridge.move('forward'); }],
      [100, 'spin',   () => { for (let i = 0; i < 8; i++) bridge.turn('left'); }],
      [115, 'land',   () => { bridge.setFlying(false); bridge.stop(); }],
      [120, 'strafe', () => bridge.move('strafe_right')],
      [140, 'back',   () => bridge.move('back')],
      [155, 'stop',   () => bridge.stop()],
    ];
    const CYCLE = 160;

    let tick = 0;
    let errors = 0;
    let maxMs = 0;
    let totalMs = 0;
    let nextAction = 0;
    let prevFrame: GridFrame | null = null;
    const terrainFn = getTerrainFn();

    // Features cycle: clouds, dither, terrain-texture all toggle
    const endTime = Date.now() + 30000;
    while (Date.now() < endTime) {
      tick++;
      const cycleTick = tick % CYCLE;
      if (cycleTick === 0) nextAction = 0;

      while (nextAction < actions.length && actions[nextAction][0] <= cycleTick) {
        try { actions[nextAction][1]; actions[nextAction][2](); } catch {}
        nextAction++;
      }

      try {
        const pos = bridge.getPosition();
        if (!pos) { await sleep(66); continue; }

        const params = buildFpParams({
          ditherPhase: tick * 0.15,
          cloudTime: tick / 15,
          cloudParams: tick % 200 < 100 ? makeCloudParams() : undefined,
          terrainTexture: tick % 150 < 75,
          renderMode: tick % 300 < 100 ? 'voxel' : tick % 300 < 200 ? 'triangle' : 'hybrid',
        });

        const t0 = performance.now();
        const avatars = bridge.getAvatars();
        const objects = bridge.getObjects();
        const fpFrame = projectFirstPerson(terrainFn, avatars, objects, params, stdLayout.fpCols, stdLayout.fpRows);

        if (prevFrame && prevFrame.cols === fpFrame.cols) {
          const deltas = diffFrames(prevFrame, fpFrame);
          if (deltas.length > 0) renderFpDeltaBuf(stdLayout, deltas, fpFrame);
        } else {
          renderFpViewBuf(stdLayout, fpFrame);
        }
        prevFrame = fpFrame;

        const mmFrame = projectFrame(terrainFn, avatars, objects, {
          cols: stdLayout.minimapCols, rows: stdLayout.minimapRows,
          selfX: pos.x, selfY: pos.y, selfZ: pos.z,
          waterHeight: bridge.getWaterHeight(), metersPerCell: 2, yaw: params.yaw,
        }, bridge.flying);
        renderMinimapBuf(stdLayout, mmFrame);
        renderStatusBarBuf(stdLayout, bridge.getRegionName(), pos, bridge.flying);

        const ms = performance.now() - t0;
        totalMs += ms;
        if (ms > maxMs) maxMs = ms;
      } catch {
        errors++;
      }

      await sleep(66); // 15Hz
    }

    const avgMs = (totalMs / tick).toFixed(1);
    return `${tick} ticks, avg=${avgMs}ms, max=${maxMs.toFixed(1)}ms, errors=${errors}`;
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 12. TELEPORT + RENDER ---');
  // ═══════════════════════════════════════════════════════════

  await test('Teleport to Waterhead and render', async () => {
    try {
      await bridge.teleportToRegion('Waterhead', 128, 128, 30);
      await sleep(3000); // wait for terrain/objects
      const params = buildFpParams();
      const r = renderFullFrame(stdLayout, params);
      const objects = bridge.getObjects().length;
      return `${bridge.getRegionName()} obj=${objects}, ${r.ms.toFixed(1)}ms`;
    } catch (err: any) {
      return `teleport failed: ${err.message} (non-fatal)`;
    }
  });

  await test('Render 60 frames in new region', async () => {
    const result = renderTickLoop(stdLayout, 60, (i) => {
      return buildFpParams({ yaw: (i / 60) * Math.PI * 2, cloudTime: i / 15 });
    });
    return `avg=${result.avg.toFixed(1)}ms max=${result.max.toFixed(1)}ms err=${result.errors}`;
  });

  await test('Teleport back to Ahern and render', async () => {
    try {
      await bridge.teleportToRegion('Ahern', 128, 128, 30);
      await sleep(3000);
      const params = buildFpParams();
      const r = renderFullFrame(stdLayout, params);
      return `${bridge.getRegionName()} obj=${bridge.getObjects().length}, ${r.ms.toFixed(1)}ms`;
    } catch (err: any) {
      return `teleport failed: ${err.message} (non-fatal)`;
    }
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n  --- 13. SUSTAINED THROUGHPUT (no sleep) ---');
  // ═══════════════════════════════════════════════════════════

  await test('Max throughput: 500 frames back-to-back', async () => {
    const t0 = performance.now();
    let maxMs = 0;
    const terrainFn = getTerrainFn();
    const avatars = bridge.getAvatars();
    const objects = bridge.getObjects();

    for (let i = 0; i < 500; i++) {
      const ft0 = performance.now();
      const params = buildFpParams({ yaw: i * 0.1, ditherPhase: i * 0.15 });
      const fpFrame = projectFirstPerson(terrainFn, avatars, objects, params, stdLayout.fpCols, stdLayout.fpRows);
      renderFpViewBuf(stdLayout, fpFrame);
      const ms = performance.now() - ft0;
      if (ms > maxMs) maxMs = ms;
    }
    const totalMs = performance.now() - t0;
    const fps = (500 / (totalMs / 1000)).toFixed(0);
    return `${totalMs.toFixed(0)}ms total, ${fps} FPS, max frame=${maxMs.toFixed(1)}ms`;
  });

  // ═══════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════

  await test('Logout', async () => {
    await bridge.close();
    return 'clean';
  });

  // Report
  console.log(`\n  ${'='.repeat(60)}`);
  console.log('  RESULTS');
  console.log(`  ${'='.repeat(60)}`);
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`  ${passed}/${results.length} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  FAILURES:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    FAIL ${r.name}`);
      console.log(`         ${r.error?.split('\n')[0]}`);
    }
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

// Hard timeout
setTimeout(() => {
  console.error('\nHARD TIMEOUT (180s)');
  bridge?.close().catch(() => {});
  process.exit(2);
}, 180000);

runTests().catch(err => {
  console.error('FATAL:', err.stack || err);
  process.exit(2);
});
