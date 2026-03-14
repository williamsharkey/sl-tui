// render-stress.ts — Renderer-focused stress test with all features enabled
// Run: npx tsx test/render-stress.ts
//
// Full projectFirstPerson pipeline at 15Hz with clouds, dither, mesh,
// terrain texture, rapid movement, size changes, and yaw sweeps.

import { SLBridge } from '../server/sl-bridge.js';
import {
  projectFirstPerson, projectFrame, diffFrames,
  type FirstPersonParams, type GridFrame,
} from '../server/grid-state.js';
import {
  renderFpViewBuf, renderFpDeltaBuf, renderMinimapBuf, renderStatusBarBuf,
} from '../tui/renderer.js';
import { computeLayout } from '../tui/screen.js';
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

const DURATION_S = 40;
let tick = 0;
let errors = 0;
let maxMs = 0;
let totalMs = 0;
let slowTicks = 0;
let bridge: SLBridge;

const TIMEOUT = setTimeout(() => {
  const avgMs = (totalMs / tick).toFixed(1);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`RENDER STRESS TEST PASSED`);
  console.log(`  ${tick} ticks over ${DURATION_S}s, ${errors} render errors`);
  console.log(`  avg=${avgMs}ms, max=${maxMs.toFixed(1)}ms, slow(>30ms)=${slowTicks}`);
  console.log(`${'='.repeat(70)}`);
  bridge.close().catch(() => {});
  process.exit(errors > 10 ? 1 : 0);
}, DURATION_S * 1000);

async function main() {
  const creds = loadCredentials();
  if (!creds) { console.error('No creds'); process.exit(1); }

  bridge = new SLBridge();
  console.log(`Logging in as ${creds.firstName} ${creds.lastName}...`);
  const callbacks: BridgeCallbacks = {
    onChat: () => {},
    onIM: () => {},
    onFriendRequest: () => {},
    onFriendOnline: () => {},
    onTeleportOffer: () => {},
    onDisconnected: (r) => { console.error('DISCONNECTED:', r); process.exit(1); },
  };

  await bridge.login(creds.firstName, creds.lastName, creds.password, callbacks);
  console.log(`Region: ${bridge.getRegionName()}`);
  await new Promise(r => setTimeout(r, 2000));

  const terrainFn = (x: number, y: number) => bridge.getTerrainHeight(x, y);
  const cloudTex = generateProceduralClouds(128, 128);
  let prevFpFrame: GridFrame | null = null;
  let prevMmFrame: GridFrame | null = null;
  let ditherPhase = 0;
  let cloudTime = 0;
  const chatBubbles = new Map<string, { message: string; ts: number }>();

  // Terminal sizes to cycle through
  const sizes = [
    { cols: 120, rows: 40 },
    { cols: 200, rows: 60 },
    { cols: 80, rows: 24 },
    { cols: 160, rows: 50 },
    { cols: 40, rows: 15 },
    { cols: 100, rows: 35 },
  ];
  let sizeIdx = 0;
  let layout = computeLayout(sizes[0].cols, sizes[0].rows);

  // Movement actions
  const actions: [number, string, () => void][] = [
    [10,  'fwd',      () => bridge.move('forward')],
    [30,  'turn-L',   () => bridge.turn('left')],
    [35,  'turn-L',   () => bridge.turn('left')],
    [40,  'turn-R',   () => bridge.turn('right')],
    [50,  'stop',     () => bridge.stop()],
    [55,  'strafe-L', () => bridge.move('strafe_left')],
    [65,  'strafe-R', () => bridge.move('strafe_right')],
    [75,  'stop',     () => bridge.stop()],
    [80,  'fly+fwd',  () => { bridge.setFlying(true); bridge.move('forward'); }],
    [95,  'turn-R',   () => bridge.turn('right')],
    [100, 'turn-R',   () => bridge.turn('right')],
    [105, 'turn-R',   () => bridge.turn('right')],
    [110, 'turn-L',   () => bridge.turn('left')],
    [115, 'stop',     () => bridge.stop()],
    [120, 'fly-off',  () => { bridge.setFlying(false); bridge.stop(); }],
    [130, 'back',     () => bridge.move('back')],
    [145, 'stop',     () => bridge.stop()],
    // Rapid spin
    [150, 'spin-L',   () => { for (let i = 0; i < 10; i++) bridge.turn('left'); }],
    [155, 'spin-R',   () => { for (let i = 0; i < 10; i++) bridge.turn('right'); }],
    [160, 'fwd',      () => bridge.move('forward')],
    [175, 'fly+up',   () => { bridge.setFlying(true); bridge.move('forward'); }],
    [190, 'land',     () => { bridge.setFlying(false); bridge.stop(); }],
  ];
  const CYCLE = 200;
  let nextActionIdx = 0;

  // Feature toggles
  let cloudsOn = true;
  let ditherOn = true;
  let terrainTex = false;

  const doTick = () => {
    tick++;
    const cycleTick = tick % CYCLE;

    // Fire scheduled actions
    while (nextActionIdx < actions.length && actions[nextActionIdx][0] <= cycleTick) {
      const [, label, fn] = actions[nextActionIdx];
      try { fn(); } catch {}
      nextActionIdx++;
    }
    if (cycleTick === 0) nextActionIdx = 0;

    // Toggle features periodically
    if (tick % 100 === 0) cloudsOn = !cloudsOn;
    if (tick % 75 === 0) ditherOn = !ditherOn;
    if (tick % 120 === 0) terrainTex = !terrainTex;

    // Switch size every 90 ticks (~6s)
    if (tick % 90 === 0) {
      sizeIdx = (sizeIdx + 1) % sizes.length;
      layout = computeLayout(sizes[sizeIdx].cols, sizes[sizeIdx].rows);
      prevFpFrame = null;
      prevMmFrame = null;
    }

    const t0 = performance.now();
    try {
      const pos = bridge.getPosition();
      if (!pos) return;

      const avatars = bridge.getAvatars();
      const objects = bridge.getObjects();
      const yaw = bridge.getBodyYaw();
      const waterHeight = bridge.getWaterHeight();
      const skyColors = bridge.getSkyColors() ?? undefined;
      const terrainH = terrainFn(Math.floor(pos.x), Math.floor(pos.y));

      ditherPhase += 0.15;
      cloudTime += 1 / 15;

      const avatarNameMap = new Map<string, string>();
      for (const av of avatars) {
        if (!av.isSelf) avatarNameMap.set(av.uuid, `${av.firstName} ${av.lastName}`.trim());
      }

      const cp = (bridge as any).getCloudParams?.();
      const cloudParams: CloudParams | undefined = cloudsOn ? {
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
      } : undefined;

      // === FIRST PERSON ===
      const fpParams: FirstPersonParams = {
        selfX: pos.x,
        selfY: pos.y,
        selfZ: pos.z + 1.8,
        yaw,
        waterHeight,
        renderMode: 'triangle',
        flying: bridge.flying,
        terrainHeight: terrainH,
        ditherPhase: ditherOn ? ditherPhase : undefined,
        skyColors,
        sunDir: skyColors?.sunDir,
        avatarNames: avatarNameMap,
        chatBubbles,
        cloudParams,
        cloudTime,
        sceneMeshLookup: (uuid: string) => (bridge as any).getSceneMesh?.(uuid) ?? null,
        sceneMeshTrigger: (uuids: string[]) => (bridge as any).triggerSceneMeshFetch?.(uuids),
        meshLookup: (uuid: string) => bridge.getAvatarMeshBundle(uuid),
        appearanceLookup: (uuid: string) => (bridge as any).getAvatarAppearance?.(uuid) ?? null,
        bakedColorsLookup: (uuid: string) => (bridge as any).getAvatarBakedColors?.(uuid) ?? null,
        terrainTexture: terrainTex,
      };

      const fpFrame = projectFirstPerson(terrainFn, avatars, objects, fpParams, layout.fpCols, layout.fpRows);

      // ANSI render (delta or full)
      let fpBuf: string;
      if (prevFpFrame && prevFpFrame.cols === fpFrame.cols && prevFpFrame.rows === fpFrame.rows) {
        const deltas = diffFrames(prevFpFrame, fpFrame);
        fpBuf = deltas.length > 0 ? renderFpDeltaBuf(layout, deltas, fpFrame) : '';
      } else {
        fpBuf = renderFpViewBuf(layout, fpFrame);
      }
      prevFpFrame = fpFrame;

      // === MINIMAP ===
      const mmFrame = projectFrame(terrainFn, avatars, objects, {
        cols: layout.minimapCols, rows: layout.minimapRows,
        selfX: pos.x, selfY: pos.y, selfZ: pos.z,
        waterHeight, metersPerCell: 2, yaw,
      }, bridge.flying);
      let mmBuf: string;
      if (prevMmFrame && prevMmFrame.cols === mmFrame.cols && prevMmFrame.rows === mmFrame.rows) {
        const deltas = diffFrames(prevMmFrame, mmFrame);
        mmBuf = deltas.length > 0 ? renderMinimapBuf(layout, mmFrame) : '';
      } else {
        mmBuf = renderMinimapBuf(layout, mmFrame);
      }
      prevMmFrame = mmFrame;

      // === STATUS ===
      const statusBuf = renderStatusBarBuf(layout, bridge.getRegionName(), pos, bridge.flying);

      // Validate output
      const totalLen = fpBuf.length + mmBuf.length + statusBuf.length;

      const ms = performance.now() - t0;
      if (ms > maxMs) maxMs = ms;
      totalMs += ms;
      if (ms > 30) slowTicks++;

      if (tick % 60 === 0) {
        const sz = sizes[sizeIdx];
        console.log(
          `t=${tick} ${ms.toFixed(1)}ms pos=(${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}) ` +
          `obj=${objects.length} av=${avatars.length} yaw=${(yaw * 180 / Math.PI).toFixed(0)}° ` +
          `size=${sz.cols}x${sz.rows} fp=${layout.fpCols}x${layout.fpRows} ` +
          `out=${(totalLen/1024).toFixed(0)}K fly=${bridge.flying} ` +
          `clouds=${cloudsOn} dither=${ditherOn} tex=${terrainTex}`
        );
      }
      if (ms > 50) {
        console.log(`  SLOW: ${ms.toFixed(0)}ms at t=${tick} (${sizes[sizeIdx].cols}x${sizes[sizeIdx].rows})`);
      }

    } catch (err: any) {
      errors++;
      console.error(`ERROR at tick ${tick}:`, err.message || err);
      if (errors > 20) {
        console.error('Too many errors, aborting');
        bridge.close().catch(() => {});
        clearTimeout(TIMEOUT);
        process.exit(1);
      }
    }
  };

  // 15Hz tick loop
  setInterval(doTick, 1000 / 15);
}

main().catch(err => {
  console.error('FATAL:', err.stack || err);
  process.exit(1);
});
