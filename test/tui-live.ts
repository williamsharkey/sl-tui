// tui-live.ts — Simulates EXACT TUI tick loop to reproduce crashes
// Run: npx tsx test/tui-live.ts

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

const TIMEOUT = setTimeout(() => {
  console.log('\n=== 25s no crash ===');
  process.exit(0);
}, 25000);

async function main() {
  const creds = loadCredentials();
  if (!creds) { console.error('No creds'); process.exit(1); }

  const bridge = new SLBridge();
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

  // Match real TUI dimensions
  const COLS = process.stdout.columns || 120;
  const ROWS = process.stdout.rows || 40;
  const layout = computeLayout(COLS, ROWS);
  console.log(`Layout: ${COLS}x${ROWS} fp=${layout.fpCols}x${layout.fpRows} mm=${layout.minimapCols}x${layout.minimapRows}`);

  const terrainFn = (x: number, y: number) => bridge.getTerrainHeight(x, y);
  const cloudTex = generateProceduralClouds(128, 128);
  let prevFpFrame: GridFrame | null = null;
  let tick = 0;
  let ditherPhase = 0;
  let cloudTime = 0;
  const chatBubbles = new Map<string, { message: string; ts: number }>();

  // Actions to perform on specific ticks to simulate user input
  const actions: [number, () => void][] = [
    [30, () => { console.log('> forward'); bridge.move('forward'); }],
    [60, () => { console.log('> turn left'); bridge.turn('left'); }],
    [75, () => { console.log('> turn left'); bridge.turn('left'); }],
    [90, () => { console.log('> turn right'); bridge.turn('right'); }],
    [105, () => { console.log('> stop'); bridge.stop(); }],
    [120, () => { console.log('> strafe right'); bridge.move('strafe_right'); }],
    [150, () => { console.log('> stop + turn'); bridge.stop(); bridge.turn('left'); }],
    [165, () => { console.log('> forward'); bridge.move('forward'); }],
    [195, () => { console.log('> turn right x3'); bridge.turn('right'); bridge.turn('right'); bridge.turn('right'); }],
    [210, () => { console.log('> stop'); bridge.stop(); }],
    [225, () => { console.log('> fly on + up'); bridge.setFlying(true); bridge.move('forward'); }],
    [270, () => { console.log('> fly off + stop'); bridge.setFlying(false); bridge.stop(); }],
    [285, () => { console.log('> back'); bridge.move('back'); }],
    [315, () => { console.log('> stop'); bridge.stop(); }],
  ];
  let nextActionIdx = 0;

  const doTick = () => {
    tick++;
    // Fire scheduled actions
    while (nextActionIdx < actions.length && actions[nextActionIdx][0] <= tick) {
      actions[nextActionIdx][1]();
      nextActionIdx++;
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
      const cloudParams: CloudParams = {
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

      // === FIRST PERSON (exact same params as app.ts) ===
      const fpParams: FirstPersonParams = {
        selfX: pos.x,
        selfY: pos.y,
        selfZ: pos.z + 1.8,
        yaw,
        waterHeight,
        renderMode: 'triangle',
        flying: bridge.flying,
        terrainHeight: terrainH,
        ditherPhase,
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
        terrainTexture: false,
      };

      const fpFrame = projectFirstPerson(terrainFn, avatars, objects, fpParams, layout.fpCols, layout.fpRows);

      // ANSI render (delta or full)
      let fpBuf: string;
      if (prevFpFrame) {
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
      const mmBuf = renderMinimapBuf(layout, mmFrame);

      // === STATUS ===
      const statusBuf = renderStatusBarBuf(layout, bridge.getRegionName(),
        pos, bridge.flying);

      const ms = performance.now() - t0;
      if (tick % 15 === 0) {
        console.log(`t=${tick} ${ms.toFixed(1)}ms pos=(${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}) obj=${objects.length} av=${avatars.length} yaw=${(yaw * 180 / Math.PI).toFixed(0)}° fp=${fpBuf.length}B`);
      }
      if (ms > 50) console.log(`  SLOW: ${ms.toFixed(0)}ms at t=${tick}`);

    } catch (err: any) {
      console.error(`\nCRASH at tick ${tick}:`, err.stack || err.message || err);
      bridge.close().catch(() => {});
      clearTimeout(TIMEOUT);
      process.exit(1);
    }
  };

  // 15Hz tick loop
  setInterval(doTick, 1000 / 15);
}

main().catch(err => {
  console.error('FATAL:', err.stack || err);
  process.exit(1);
});
