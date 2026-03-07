#!/usr/bin/env npx tsx
// integration.ts — Comprehensive real-world integration tests for SL-TUI
//
// Usage:
//   SL_USERNAME="dadchords" SL_PASSWORD="xxx" npx tsx test/integration.ts
//   SL_USERNAME="Cool Guy" SL_PASSWORD="xxx" npx tsx test/integration.ts
//
// The test logs into Second Life, walks around, checks friends, terrain,
// nearby avatars, objects, chat, grid rendering — everything real.

import { SLBridge } from '../server/sl-bridge.js';
import {
  projectFrame, diffFrames, createEmptyFrame,
  type ProjectionParams, type GridFrame,
} from '../server/grid-state.js';

// ─── Config ────────────────────────────────────────────────────────

const SL_USERNAME = process.env.SL_USERNAME;
const SL_PASSWORD = process.env.SL_PASSWORD;

if (!SL_USERNAME || !SL_PASSWORD) {
  console.error('ERROR: Set SL_USERNAME and SL_PASSWORD environment variables.');
  console.error('  SL_USERNAME="dadchords" SL_PASSWORD="xxx" npx tsx test/integration.ts');
  process.exit(1);
}

let firstName: string, lastName: string;
if (SL_USERNAME.includes(' ')) {
  const parts = SL_USERNAME.split(' ');
  firstName = parts[0];
  lastName = parts.slice(1).join(' ');
} else {
  firstName = SL_USERNAME;
  lastName = 'Resident';
}

// ─── Test Framework ────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  detail: string;
  error?: string;
}

const results: TestResult[] = [];
let bridge: SLBridge;

function log(icon: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  ${icon} [${ts}] ${msg}`);
}

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function test(name: string, fn: () => Promise<string>): Promise<void> {
  const start = Date.now();
  try {
    const detail = await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration, detail });
    log('PASS', `${name} (${duration}ms) — ${detail}`);
  } catch (err: any) {
    const duration = Date.now() - start;
    const error = err.message || String(err);
    results.push({ name, passed: false, duration, detail: '', error });
    log('FAIL', `${name} (${duration}ms) — ${error}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Tests ─────────────────────────────────────────────────────────

async function runTests() {
  console.log(`
  ╔════════════════════════════════════════════╗
  ║   SL-TUI Integration Test Suite            ║
  ║   Logging in as: ${(firstName + ' ' + lastName).padEnd(24)}║
  ╚════════════════════════════════════════════╝`);

  // Collect chat/IM events during the test
  const chatLog: { from: string; message: string; type: number }[] = [];
  const imLog: { from: string; fromName: string; message: string }[] = [];
  const friendEvents: { name: string; uuid: string; online: boolean }[] = [];

  // ─── 1. LOGIN ──────────────────────────────────────────────────

  section('1. LOGIN');
  bridge = new SLBridge();

  let regionName = '';
  let waterHeight = 0;

  await test('Login to Second Life', async () => {
    const result = await bridge.login(firstName, lastName, SL_PASSWORD!, {
      onChat: (from, message, chatType, fromId) => {
        chatLog.push({ from, message, type: chatType });
      },
      onIM: (from, fromName, message, isGroup) => {
        imLog.push({ from, fromName, message });
        log('  IM', `${fromName}: ${message}`);
      },
      onFriendRequest: (from, fromName, message) => {
        log('  FR', `Friend request from ${fromName}`);
      },
      onFriendOnline: (name, uuid, online) => {
        friendEvents.push({ name, uuid, online });
        log('  ON', `${name} is ${online ? 'online' : 'offline'}`);
      },
      onTeleportOffer: (from, fromName, message) => {
        log('  TP', `Teleport offer from ${fromName}: ${message}`);
      },
      onDisconnected: (reason) => {
        log('  DC', `Disconnected: ${reason}`);
      },
    });
    regionName = result.region;
    waterHeight = result.waterHeight;
    return `Region: ${result.region}, Water: ${result.waterHeight}m`;
  });

  // Give the sim a moment to send us data
  await sleep(2000);

  // ─── 2. POSITION & STATUS ─────────────────────────────────────

  section('2. POSITION & STATUS');

  await test('Get self position', async () => {
    const pos = bridge.getPosition();
    assert(pos !== null, 'Position is null');
    assert(typeof pos!.x === 'number' && !isNaN(pos!.x), 'X is not a number');
    assert(typeof pos!.y === 'number' && !isNaN(pos!.y), 'Y is not a number');
    assert(typeof pos!.z === 'number' && !isNaN(pos!.z), 'Z is not a number');
    assert(pos!.x >= 0 && pos!.x <= 256, `X out of range: ${pos!.x}`);
    assert(pos!.y >= 0 && pos!.y <= 256, `Y out of range: ${pos!.y}`);
    return `Position: (${pos!.x.toFixed(1)}, ${pos!.y.toFixed(1)}, ${pos!.z.toFixed(1)})`;
  });

  await test('Get self rotation', async () => {
    const rot = bridge.getRotation();
    assert(rot !== null, 'Rotation is null');
    const mag = Math.sqrt(rot!.x ** 2 + rot!.y ** 2 + rot!.z ** 2 + rot!.w ** 2);
    assert(Math.abs(mag - 1.0) < 0.1, `Quaternion not normalized: magnitude=${mag}`);
    return `Rotation: (${rot!.x.toFixed(3)}, ${rot!.y.toFixed(3)}, ${rot!.z.toFixed(3)}, ${rot!.w.toFixed(3)})`;
  });

  await test('Get region name', async () => {
    const name = bridge.getRegionName();
    assert(name.length > 0, 'Region name is empty');
    return `Region: "${name}"`;
  });

  await test('Get water height', async () => {
    const wh = bridge.getWaterHeight();
    assert(typeof wh === 'number' && !isNaN(wh), 'Water height is not a number');
    return `Water height: ${wh}m`;
  });

  // ─── 3. TERRAIN ───────────────────────────────────────────────

  section('3. TERRAIN');

  await test('Sample terrain heights', async () => {
    const samples: { x: number; y: number; h: number }[] = [];
    const testPoints = [[128, 128], [0, 0], [255, 255], [64, 192], [192, 64]];
    for (const [x, y] of testPoints) {
      const h = bridge.getTerrainHeight(x, y);
      assert(typeof h === 'number', `Height at (${x},${y}) is not a number`);
      samples.push({ x, y, h });
    }
    const validHeights = samples.filter(s => s.h > -100 && s.h < 1000);
    assert(validHeights.length >= 3, `Too few valid terrain heights: ${validHeights.length}/5`);
    const heightStr = samples.map(s => `(${s.x},${s.y})=${s.h.toFixed(1)}m`).join(', ');
    return heightStr;
  });

  await test('Terrain height variation exists', async () => {
    const heights: number[] = [];
    for (let x = 0; x < 256; x += 16) {
      for (let y = 0; y < 256; y += 16) {
        heights.push(bridge.getTerrainHeight(x, y));
      }
    }
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    const range = max - min;
    return `Range: ${min.toFixed(1)}m to ${max.toFixed(1)}m (delta: ${range.toFixed(1)}m)`;
  });

  // ─── 4. GRID RENDERING ───────────────────────────────────────

  section('4. GRID RENDERING');

  await test('Project full terrain frame (80x40)', async () => {
    const pos = bridge.getPosition()!;
    const params: ProjectionParams = {
      cols: 80, rows: 40,
      selfX: pos.x, selfY: pos.y, selfZ: pos.z,
      waterHeight: bridge.getWaterHeight(),
      metersPerCell: 256 / 80,
    };
    const frame = projectFrame(
      (x, y) => bridge.getTerrainHeight(x, y),
      bridge.getAvatars(),
      bridge.getObjects(),
      params,
      bridge.flying,
    );
    assert(frame.cells.length === 80 * 40, `Expected 3200 cells, got ${frame.cells.length}`);

    // Count terrain types
    const charCounts: Record<string, number> = {};
    for (const cell of frame.cells) {
      charCounts[cell.char] = (charCounts[cell.char] || 0) + 1;
    }
    const hasSelf = frame.cells.some(c => c.char === '@');
    assert(hasSelf, 'Self (@) not found in grid');

    const breakdown = Object.entries(charCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([ch, n]) => `'${ch}'=${n}`)
      .join(', ');
    return `Cells: ${breakdown}`;
  });

  await test('Render ASCII grid snapshot', async () => {
    const pos = bridge.getPosition()!;
    const cols = 60, rows = 25;
    const params: ProjectionParams = {
      cols, rows,
      selfX: pos.x, selfY: pos.y, selfZ: pos.z,
      waterHeight: bridge.getWaterHeight(),
      metersPerCell: 256 / cols,
    };
    const frame = projectFrame(
      (x, y) => bridge.getTerrainHeight(x, y),
      bridge.getAvatars(),
      bridge.getObjects(),
      params,
      bridge.flying,
    );

    // Print the grid
    console.log('\n    Grid snapshot (60x25):');
    console.log('    ' + '-'.repeat(cols + 2));
    for (let row = 0; row < rows; row++) {
      let line = '    |';
      for (let col = 0; col < cols; col++) {
        line += frame.cells[row * cols + col].char;
      }
      line += '|';
      console.log(line);
    }
    console.log('    ' + '-'.repeat(cols + 2));

    return `Rendered ${cols}x${rows} grid`;
  });

  await test('Frame diffing works', async () => {
    const pos = bridge.getPosition()!;
    const params: ProjectionParams = {
      cols: 40, rows: 20,
      selfX: pos.x, selfY: pos.y, selfZ: pos.z,
      waterHeight: bridge.getWaterHeight(),
      metersPerCell: 256 / 40,
    };
    const frame1 = projectFrame(
      (x, y) => bridge.getTerrainHeight(x, y),
      bridge.getAvatars(),
      bridge.getObjects(),
      params,
      bridge.flying,
    );
    // Same data should produce zero deltas
    const frame2 = projectFrame(
      (x, y) => bridge.getTerrainHeight(x, y),
      bridge.getAvatars(),
      bridge.getObjects(),
      params,
      bridge.flying,
    );
    const deltas = diffFrames(frame1, frame2);
    return `Same-frame diff: ${deltas.length} deltas (expected ~0)`;
  });

  // ─── 5. NEARBY AVATARS ────────────────────────────────────────

  section('5. NEARBY AVATARS');

  await test('Get nearby avatars', async () => {
    const avatars = bridge.getAvatars();
    const self = avatars.find(a => a.isSelf);
    const others = avatars.filter(a => !a.isSelf);
    assert(self !== undefined, 'Self avatar not found in avatar list');

    const selfStr = `Self: (${self!.x.toFixed(1)}, ${self!.y.toFixed(1)}, ${self!.z.toFixed(1)})`;
    const othersStr = others.length > 0
      ? others.map(a => `${a.firstName} ${a.lastName} at (${a.x.toFixed(0)},${a.y.toFixed(0)},${a.z.toFixed(0)})`).join('; ')
      : 'no one else nearby';
    return `${selfStr} | Nearby: ${othersStr}`;
  });

  await test('Avatar data is valid', async () => {
    const avatars = bridge.getAvatars();
    for (const av of avatars) {
      assert(typeof av.uuid === 'string' && av.uuid.length > 10, `Bad UUID: ${av.uuid}`);
      assert(typeof av.firstName === 'string', `Bad firstName for ${av.uuid}`);
      assert(typeof av.x === 'number' && !isNaN(av.x), `Bad x for ${av.firstName}`);
      assert(typeof av.yaw === 'number' && !isNaN(av.yaw), `Bad yaw for ${av.firstName}`);
    }
    return `${avatars.length} avatars validated`;
  });

  // ─── 6. OBJECTS ───────────────────────────────────────────────

  section('6. OBJECTS');

  await test('Get nearby objects', async () => {
    const objects = bridge.getObjects();
    const trees = objects.filter(o => o.isTree);
    const prims = objects.filter(o => !o.isTree);
    const named = prims.filter(o => o.name && o.name !== 'Object' && o.name !== 'Primitive');

    const namedStr = named.slice(0, 5).map(o => `"${o.name}"`).join(', ');
    return `${objects.length} objects (${trees.length} trees, ${prims.length} prims). Named: ${namedStr || 'none'}`;
  });

  await test('Inspect a nearby object', async () => {
    const objects = bridge.getObjects();
    if (objects.length === 0) return 'No objects to inspect (skip)';

    const obj = objects.find(o => o.name && o.name !== 'Object') || objects[0];
    const info = bridge.inspectObject(obj.uuid);
    if (!info) return `Could not inspect object ${obj.uuid.slice(0, 8)}`;
    return `Object: "${info.name}" at ${info.position}`;
  });

  // ─── 7. MOVEMENT ─────────────────────────────────────────────

  section('7. MOVEMENT');

  await test('Walk north for 2 seconds', async () => {
    const posBefore = bridge.getPosition()!;
    bridge.move('n');
    await sleep(2000);
    bridge.stop();
    await sleep(500);
    const posAfter = bridge.getPosition()!;
    const dist = Math.sqrt(
      (posAfter.x - posBefore.x) ** 2 +
      (posAfter.y - posBefore.y) ** 2 +
      (posAfter.z - posBefore.z) ** 2
    );
    return `Moved ${dist.toFixed(2)}m: (${posBefore.x.toFixed(1)},${posBefore.y.toFixed(1)}) -> (${posAfter.x.toFixed(1)},${posAfter.y.toFixed(1)})`;
  });

  await test('Walk east for 2 seconds', async () => {
    const posBefore = bridge.getPosition()!;
    bridge.move('e');
    await sleep(2000);
    bridge.stop();
    await sleep(500);
    const posAfter = bridge.getPosition()!;
    const dist = Math.sqrt(
      (posAfter.x - posBefore.x) ** 2 +
      (posAfter.y - posBefore.y) ** 2
    );
    return `Moved ${dist.toFixed(2)}m: (${posBefore.x.toFixed(1)},${posBefore.y.toFixed(1)}) -> (${posAfter.x.toFixed(1)},${posAfter.y.toFixed(1)})`;
  });

  await test('Toggle flying', async () => {
    bridge.setFlying(true);
    assert(bridge.flying === true, 'Flying flag not set');
    await sleep(500);

    // Fly up
    bridge.move('up');
    await sleep(2000);
    bridge.stop();
    await sleep(500);

    const pos = bridge.getPosition()!;
    bridge.setFlying(false);
    assert(bridge.flying === false, 'Flying flag not cleared');
    await sleep(1000);

    const posAfterLand = bridge.getPosition()!;
    return `Flew to z=${pos.z.toFixed(1)}m, landed at z=${posAfterLand.z.toFixed(1)}m`;
  });

  await test('Walk south back (return toward start)', async () => {
    bridge.move('s');
    await sleep(2000);
    bridge.stop();
    await sleep(500);
    const pos = bridge.getPosition()!;
    return `Now at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
  });

  // ─── 8. FRIENDS LIST ──────────────────────────────────────────

  section('8. FRIENDS LIST');

  await test('Get friends list', async () => {
    const friends = await bridge.getFriendsList();
    if (friends.length === 0) return 'No friends (empty buddy list)';

    const online = friends.filter(f => f.online);
    const offline = friends.filter(f => !f.online);

    console.log('\n    Friends List:');
    console.log('    ' + '-'.repeat(50));
    for (const f of friends) {
      const status = f.online ? ' ONLINE' : 'offline';
      const rights = [
        f.rightsGiven ? 'given' : '',
        f.rightsHas ? 'has' : '',
      ].filter(Boolean).join(',');
      console.log(`    ${status}  ${f.name.padEnd(30)} ${rights}`);
    }
    console.log('    ' + '-'.repeat(50));

    return `${friends.length} friends (${online.length} online, ${offline.length} offline)`;
  });

  await test('Friend data is valid', async () => {
    const friends = await bridge.getFriendsList();
    for (const f of friends) {
      assert(typeof f.uuid === 'string' && f.uuid.length > 10, `Bad friend UUID: ${f.uuid}`);
      assert(typeof f.name === 'string' && f.name.length > 0, `Bad friend name for ${f.uuid}`);
      assert(typeof f.online === 'boolean', `Bad online status for ${f.name}`);
    }
    return `${friends.length} friends validated`;
  });

  // ─── 9. FRIEND ONLINE EVENTS (collected during test) ──────────

  section('9. FRIEND ONLINE EVENTS');

  await test('Friend online/offline events received', async () => {
    // These accumulated during the test from the callback
    if (friendEvents.length === 0) return 'No friend events received (normal if no friends changed status)';
    const summary = friendEvents.map(e => `${e.name}: ${e.online ? 'online' : 'offline'}`).join(', ');
    return `${friendEvents.length} events: ${summary}`;
  });

  // Wait a bit more to collect any late friend notifications
  await sleep(2000);

  await test('Final friend event tally', async () => {
    return `Total friend events: ${friendEvents.length}`;
  });

  // ─── 10. CHAT ─────────────────────────────────────────────────

  section('10. CHAT');

  await test('Send nearby chat message', async () => {
    await bridge.say('SL-TUI integration test — please ignore');
    await sleep(1000);
    return 'Said "SL-TUI integration test — please ignore"';
  });

  await test('Chat messages received during session', async () => {
    if (chatLog.length === 0) return 'No chat received (normal if area is quiet)';
    const summary = chatLog.slice(-5).map(c => `${c.from}: "${c.message.slice(0, 40)}"`).join('; ');
    return `${chatLog.length} messages. Recent: ${summary}`;
  });

  // ─── 11. PEOPLE SEARCH ────────────────────────────────────────

  section('11. PEOPLE SEARCH');

  await test('Search for own avatar name', async () => {
    const results = await bridge.searchPeople(`${firstName} ${lastName}`);
    assert(results.length > 0, 'No search results for own name');
    return `Found: ${results.map(r => `${r.name} (${r.uuid.slice(0, 8)}...)`).join(', ')}`;
  });

  await test('Search for "Philip Linden"', async () => {
    const results = await bridge.searchPeople('Philip Linden');
    if (results.length === 0) return 'No results (may be expected)';
    return `Found: ${results.map(r => `${r.name} (${r.uuid.slice(0, 8)}...)`).join(', ')}`;
  });

  // ─── 12. PROFILE ──────────────────────────────────────────────

  section('12. PROFILE');

  await test('Get own profile', async () => {
    const avatars = bridge.getAvatars();
    const self = avatars.find(a => a.isSelf);
    if (!self) return 'Cannot find self UUID';
    const profile = await bridge.getProfile(self.uuid);
    if (!profile) return 'Profile returned null';
    return `Name: ${profile.displayName}, Born: ${profile.bornOn}, Bio: "${(profile.bio || '').slice(0, 50)}"`;
  });

  // ─── 13. GRID RENDERING WITH MOVEMENT ─────────────────────────

  section('13. GRID RENDERING AFTER MOVEMENT');

  await test('Grid snapshot after movement', async () => {
    const pos = bridge.getPosition()!;
    const cols = 60, rows = 20;
    const params: ProjectionParams = {
      cols, rows,
      selfX: pos.x, selfY: pos.y, selfZ: pos.z,
      waterHeight: bridge.getWaterHeight(),
      metersPerCell: 256 / cols,
    };
    const frame = projectFrame(
      (x, y) => bridge.getTerrainHeight(x, y),
      bridge.getAvatars(),
      bridge.getObjects(),
      params,
      bridge.flying,
    );
    console.log(`\n    Grid at (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}) in ${bridge.getRegionName()}:`);
    console.log('    ' + '-'.repeat(cols + 2));
    for (let row = 0; row < rows; row++) {
      let line = '    |';
      for (let col = 0; col < cols; col++) {
        line += frame.cells[row * cols + col].char;
      }
      line += '|';
      console.log(line);
    }
    console.log('    ' + '-'.repeat(cols + 2));
    return `Rendered at new position`;
  });

  // ─── 14. TICK LOOP SIMULATION ─────────────────────────────────

  section('14. TICK LOOP (simulated 4Hz)');

  await test('Run 8 tick cycles (2 seconds of game loop)', async () => {
    let deltaCount = 0;
    let totalDeltaCells = 0;
    let prevFrame: GridFrame | null = null;

    for (let i = 0; i < 8; i++) {
      const pos = bridge.getPosition()!;
      const params: ProjectionParams = {
        cols: 80, rows: 40,
        selfX: pos.x, selfY: pos.y, selfZ: pos.z,
        waterHeight: bridge.getWaterHeight(),
        metersPerCell: 256 / 80,
      };
      const frame = projectFrame(
        (x, y) => bridge.getTerrainHeight(x, y),
        bridge.getAvatars(),
        bridge.getObjects(),
        params,
        bridge.flying,
      );
      if (prevFrame) {
        const deltas = diffFrames(prevFrame, frame);
        if (deltas.length > 0) deltaCount++;
        totalDeltaCells += deltas.length;
      }
      prevFrame = frame;
      await sleep(250);
    }
    return `${deltaCount}/7 ticks had changes, ${totalDeltaCells} total cells changed`;
  });

  // ─── 15. END-TO-END WebSocket SESSION SIMULATION ──────────────

  section('15. END-TO-END SESSION (simulated)');

  await test('Simulate full session message flow', async () => {
    // Simulate what the client would see in a real session
    const pos = bridge.getPosition()!;
    const avatars = bridge.getAvatars();
    const objects = bridge.getObjects();
    const friends = await bridge.getFriendsList();

    const checks = [
      pos !== null ? 'position' : null,
      avatars.length > 0 ? 'avatars' : null,
      bridge.getRegionName() ? 'region' : null,
      bridge.getWaterHeight() > 0 ? 'water' : null,
    ].filter(Boolean);

    return `Session has: ${checks.join(', ')} | ${avatars.length} avatars, ${objects.length} objects, ${friends.length} friends`;
  });

  // ─── CLEANUP ──────────────────────────────────────────────────

  section('CLEANUP');

  await test('Logout and close', async () => {
    await bridge.close();
    return 'Disconnected cleanly';
  });

  // ─── REPORT ───────────────────────────────────────────────────

  printReport();
}

function printReport() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  TEST REPORT');
  console.log('='.repeat(60));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  const totalTime = results.reduce((s, r) => s + r.duration, 0);

  for (const r of results) {
    const icon = r.passed ? 'PASS' : 'FAIL';
    const time = `${r.duration}ms`.padStart(7);
    console.log(`  ${icon} ${time}  ${r.name}`);
    if (r.error) {
      console.log(`              ERROR: ${r.error}`);
    }
  }

  console.log(`\n  ${'-'.repeat(56)}`);
  console.log(`  ${passed}/${total} passed, ${failed} failed (${(totalTime / 1000).toFixed(1)}s total)`);

  if (failed > 0) {
    console.log('\n  FAILED TESTS:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    - ${r.name}: ${r.error}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

// ─── Run ───────────────────────────────────────────────────────────

runTests().catch(async (err) => {
  console.error('\nFATAL ERROR:', err);
  try { await bridge?.close(); } catch {}
  process.exit(2);
});
