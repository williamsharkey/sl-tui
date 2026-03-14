// bench.ts — Performance benchmark for TUI rendering pipeline
// Run: npx tsx test/bench.ts

import { SLBridge } from '../server/sl-bridge.js';
import { projectFrame, projectFirstPerson, type FirstPersonParams } from '../server/grid-state.js';
import { renderFpViewBuf, renderMinimapBuf } from '../tui/renderer.js';
import { computeLayout } from '../tui/screen.js';
import { loadCredentials } from '../tui/credentials.js';
import type { BridgeCallbacks } from '../tui/types.js';

const COLS = 120;
const ROWS = 40;
const ITERATIONS = 100;

async function main() {
  const creds = loadCredentials();
  if (!creds) {
    console.error('No saved credentials. Run sl-tui and login first.');
    process.exit(1);
  }

  console.log(`Logging in as ${creds.firstName} ${creds.lastName}...`);
  const bridge = new SLBridge();
  const callbacks: BridgeCallbacks = {
    onChat: () => {},
    onIM: () => {},
    onFriendRequest: () => {},
    onFriendOnline: () => {},
    onTeleportOffer: () => {},
    onDisconnected: () => {},
  };

  await bridge.login(creds.firstName, creds.lastName, creds.password, callbacks);
  console.log(`Logged in to ${bridge.getRegionName()}. Waiting for terrain...`);

  // Wait for terrain data
  await new Promise(resolve => setTimeout(resolve, 3000));

  const layout = computeLayout(COLS, ROWS);
  const pos = bridge.getPosition()!;
  const rot = bridge.getRotation()!;
  const waterHeight = bridge.getWaterHeight();

  // Build terrain accessor
  const terrain = (x: number, y: number) => bridge.getTerrainHeight(x, y);
  const avatars = bridge.getAvatars();
  const objects = bridge.getObjects();

  console.log(`Position: (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)})`);
  console.log(`Avatars: ${avatars.length}, Objects: ${objects.length}`);
  console.log(`Layout: ${COLS}x${ROWS}, FP: ${layout.fpCols}x${layout.fpRows}, Minimap: ${layout.minimapCols}x${layout.minimapRows}`);
  console.log(`\nRunning ${ITERATIONS} iterations...\n`);

  const fpParams: FirstPersonParams = {
    selfX: pos.x,
    selfY: pos.y,
    selfZ: pos.z + 1.8,
    yaw: bridge.getBodyYaw(),
    waterHeight,
  };

  // Benchmark: projectFirstPerson (raycasting + pixel-to-cells)
  let t0 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    fpParams.yaw = bridge.getBodyYaw() + i * 0.01; // slight variation
    projectFirstPerson(terrain, avatars, objects, fpParams, layout.fpCols, layout.fpRows);
  }
  const raycastMs = (performance.now() - t0) / ITERATIONS;

  // Benchmark: projectFrame (minimap)
  t0 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    projectFrame(terrain, avatars, objects, {
      cols: layout.minimapCols,
      rows: layout.minimapRows,
      selfX: pos.x,
      selfY: pos.y,
      selfZ: pos.z,
      waterHeight,
      metersPerCell: 2,
      yaw: bridge.getBodyYaw(),
    }, bridge.flying);
  }
  const minimapMs = (performance.now() - t0) / ITERATIONS;

  // Benchmark: renderFpViewBuf (ANSI generation)
  const fpFrame = projectFirstPerson(terrain, avatars, objects, fpParams, layout.fpCols, layout.fpRows);
  t0 = performance.now();
  let totalBytes = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const out = renderFpViewBuf(layout, fpFrame);
    totalBytes += out.length;
  }
  const renderFpMs = (performance.now() - t0) / ITERATIONS;

  // Benchmark: renderMinimapBuf
  const mmFrame = projectFrame(terrain, avatars, objects, {
    cols: layout.minimapCols,
    rows: layout.minimapRows,
    selfX: pos.x, selfY: pos.y, selfZ: pos.z,
    waterHeight, metersPerCell: 2, yaw: bridge.getBodyYaw(),
  }, bridge.flying);
  t0 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    renderMinimapBuf(layout, mmFrame);
  }
  const renderMmMs = (performance.now() - t0) / ITERATIONS;

  const totalMs = raycastMs + minimapMs + renderFpMs + renderMmMs;
  const fps = 1000 / totalMs;

  console.log('Phase                  Avg ms/frame');
  console.log('─'.repeat(45));
  console.log(`Raycast (FP)           ${raycastMs.toFixed(2)} ms`);
  console.log(`Minimap projection     ${minimapMs.toFixed(2)} ms`);
  console.log(`ANSI render (FP)       ${renderFpMs.toFixed(2)} ms`);
  console.log(`ANSI render (minimap)  ${renderMmMs.toFixed(2)} ms`);
  console.log('─'.repeat(45));
  console.log(`Total per frame        ${totalMs.toFixed(2)} ms`);
  console.log(`Theoretical FPS        ${fps.toFixed(1)}`);
  console.log(`Avg output size        ${(totalBytes / ITERATIONS / 1024).toFixed(1)} KB`);

  await bridge.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Bench error:', err);
  process.exit(1);
});
