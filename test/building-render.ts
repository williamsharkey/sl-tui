// building-render.ts — Integration test: teleport to Ahern, verify building prims render
// Run: npx tsx test/building-render.ts (requires SL credentials)

import { SLBridge } from '../server/sl-bridge.js';
import { projectFirstPerson, type FirstPersonParams } from '../server/grid-state.js';
import { loadCredentials } from '../tui/credentials.js';
import type { BridgeCallbacks } from '../tui/types.js';

// Hard timeout: 60s
const HARD_TIMEOUT = setTimeout(() => {
  console.error('TIMEOUT: 60s exceeded');
  process.exit(2);
}, 60000);

let bridge: SLBridge | null = null;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main() {
  // Phase 1 — Login
  const creds = loadCredentials();
  if (!creds) {
    console.error('No saved credentials. Run sl-tui and login first.');
    process.exit(1);
  }

  console.log(`Logging in as ${creds.firstName} ${creds.lastName}...`);
  bridge = new SLBridge();
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
  await new Promise(r => setTimeout(r, 2000));

  // Phase 2 — Teleport to Ahern
  console.log('Teleporting to Ahern...');
  try {
    await bridge.teleportToRegion('Ahern', 128, 128, 30);
  } catch (err: any) {
    // Fallback to Waterhead
    console.log(`Ahern failed (${err.message}), trying Waterhead...`);
    await bridge.teleportToRegion('Waterhead', 128, 128, 30);
  }
  const region = bridge.getRegionName();
  console.log(`Arrived at: ${region}`);
  assert(
    region.toLowerCase().includes('ahern') || region.toLowerCase().includes('waterhead'),
    `Expected Ahern or Waterhead, got: ${region}`,
  );

  // Wait for object streaming to begin (sim needs time to start sending ObjectUpdate packets)
  console.log('Waiting 8s for object streaming to begin...');
  await new Promise(r => setTimeout(r, 8000));

  // Phase 3 — Object Streaming: poll until stable
  console.log('Waiting for objects to stabilize...');
  let prevCount = 0;
  let stableRuns = 0;
  const pollStart = Date.now();
  const POLL_TIMEOUT = 25000;

  while (stableRuns < 3 && Date.now() - pollStart < POLL_TIMEOUT) {
    await new Promise(r => setTimeout(r, 2500));
    const count = bridge.getObjects().length;
    // Only count as stable if we actually have objects (0→0 is not stable, it's "not started")
    if (count > 0 && Math.abs(count - prevCount) <= 2) {
      stableRuns++;
    } else if (count > 0) {
      stableRuns = 0;
    }
    prevCount = count;
    console.log(`  Objects: ${count} (stable: ${stableRuns}/3)`);
  }

  if (stableRuns < 3) {
    console.log('  WARNING: object count did not stabilize, proceeding anyway');
  }

  const objects = bridge.getObjects();
  console.log(`Total objects: ${objects.length}`);
  assert(objects.length >= 10, `Expected ≥10 objects, got ${objects.length}`);

  // Phase 4 — Object Property Assertions
  const terrainFn = (x: number, y: number) => bridge!.getTerrainHeight(x, y);

  const buildings = objects.filter(o =>
    o.pcode === 9 && !o.isTree && o.scaleZ > 0.5,
  );
  console.log(`Building-like prims: ${buildings.length}`);
  // Debug: show z range of building prims
  if (buildings.length > 0) {
    const zVals = buildings.map(o => o.z).sort((a, b) => a - b);
    console.log(`  Z range: ${zVals[0].toFixed(1)} to ${zVals[zVals.length - 1].toFixed(1)}`);
    console.log(`  Sample: pcode=${buildings[0].pcode} pathCurve=${buildings[0].pathCurve} pos=(${buildings[0].x.toFixed(1)},${buildings[0].y.toFixed(1)},${buildings[0].z.toFixed(1)}) scale=(${buildings[0].scaleX.toFixed(1)},${buildings[0].scaleY.toFixed(1)},${buildings[0].scaleZ.toFixed(1)})`);
  }
  assert(buildings.length >= 3, `Expected ≥3 building prims, got ${buildings.length}`);

  const hasBox = buildings.some(o => o.pathCurve === 16);
  assert(hasBox, 'Expected ≥1 box prim (pathCurve=16)');

  // Check if any prim is above the terrain at its own position
  // After teleport, terrain may not be loaded — check if terrain returns non-zero
  const sampleTH = terrainFn(128, 128);
  console.log(`Terrain height at (128,128): ${sampleTH}`);
  // Some prims should be above z=0 regardless (buildings are elevated)
  const hasAboveGround = buildings.some(o => {
    if (sampleTH > 0) {
      const th = terrainFn(Math.floor(o.x), Math.floor(o.y));
      return o.z > th + 0.5;
    }
    // Terrain not loaded — just check z > 1 (above ground level)
    return o.z > 1;
  });
  assert(hasAboveGround, 'Expected ≥1 prim above ground');

  // Phase 5 — Render Verification
  console.log('Rendering first-person views...');
  const pos = bridge.getPosition()!;
  const waterHeight = bridge.getWaterHeight();
  const avatars = bridge.getAvatars();

  const nonTreeUUIDs = new Set(
    objects.filter(o => !o.isTree && o.pcode === 9).map(o => o.uuid),
  );

  const allVisibleOIDs = new Set<string>();
  const yaws = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

  for (const yaw of yaws) {
    const fpParams: FirstPersonParams = {
      selfX: pos.x,
      selfY: pos.y,
      selfZ: pos.z + 1.8,
      yaw,
      waterHeight,
      renderMode: 'triangle',
    };

    const frame = projectFirstPerson(terrainFn, avatars, objects, fpParams, 80, 30);

    for (const cell of frame.cells) {
      if (cell.oid && nonTreeUUIDs.has(cell.oid)) {
        allVisibleOIDs.add(cell.oid);
      }
    }
  }

  console.log(`Unique building OIDs rendered: ${allVisibleOIDs.size}`);
  assert(allVisibleOIDs.size >= 1, 'Expected ≥1 building prim OID visible in rendered cells');
  assert(allVisibleOIDs.size >= 2, `Expected ≥2 distinct OIDs across 4 directions, got ${allVisibleOIDs.size}`);

  // Phase 6 — Cleanup
  console.log('\n✓ All assertions passed!');
  await bridge.close();
  clearTimeout(HARD_TIMEOUT);
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Test FAILED:', err.message || err);
  if (bridge) {
    try { await bridge.close(); } catch {}
  }
  clearTimeout(HARD_TIMEOUT);
  process.exit(1);
});
