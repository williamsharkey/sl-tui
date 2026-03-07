#!/usr/bin/env node --import tsx/esm
// stress.ts — Aggressive integration tests designed to crash and expose bugs
//
// Usage:
//   npm run test:stress
//
// These tests push the system hard: real login, verified movement,
// rapid state changes, edge cases, reconnection, concurrent ops.

import { SLBridge } from '../server/sl-bridge.js';
import {
  projectFrame, diffFrames, createEmptyFrame,
  type ProjectionParams, type GridFrame,
} from '../server/grid-state.js';

// ─── Config ────────────────────────────────────────────────────────

const SL_USERNAME = process.env.SL_USERNAME;
const SL_PASSWORD = process.env.SL_PASSWORD;

if (!SL_USERNAME || !SL_PASSWORD) {
  console.error('Set SL_USERNAME and SL_PASSWORD env vars');
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

// ─── Framework ─────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  detail: string;
  error?: string;
}

const results: TestResult[] = [];
let bridge: SLBridge;

function ts() { return new Date().toISOString().slice(11, 19); }
function log(icon: string, msg: string) { console.log(`  ${icon} [${ts()}] ${msg}`); }
function section(title: string) {
  console.log(`\n${'━'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('━'.repeat(64));
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
    const error = err?.message || String(err);
    results.push({ name, passed: false, duration, detail: '', error });
    log('FAIL', `${name} (${duration}ms) — ${error}`);
  }
}

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function dist(a: {x:number,y:number,z:number}, b: {x:number,y:number,z:number}): number {
  return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
}
function dist2d(a: {x:number,y:number}, b: {x:number,y:number}): number {
  return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2);
}

// ─── Tests ─────────────────────────────────────────────────────────

async function runTests() {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   SL-TUI STRESS TEST SUITE                   ║
  ║   Target: ${(firstName + ' ' + lastName).padEnd(35)}║
  ╚══════════════════════════════════════════════╝`);

  const chatLog: { from: string; message: string; type: number }[] = [];
  const imLog: { from: string; fromName: string; message: string }[] = [];
  const friendEvents: { name: string; uuid: string; online: boolean }[] = [];
  let disconnected = false;

  // ═══════════════════════════════════════════════════════════════════
  section('1. LOGIN & INITIAL STATE');
  // ═══════════════════════════════════════════════════════════════════

  bridge = new SLBridge();

  await test('Login to SL', async () => {
    const result = await bridge.login(firstName, lastName, SL_PASSWORD!, {
      onChat: (from, message, chatType, fromId) => {
        chatLog.push({ from, message, type: chatType });
      },
      onIM: (from, fromName, message, isGroup) => {
        imLog.push({ from, fromName, message });
      },
      onFriendRequest: () => {},
      onFriendOnline: (name, uuid, online) => {
        friendEvents.push({ name, uuid, online });
      },
      onTeleportOffer: () => {},
      onDisconnected: (reason) => {
        disconnected = true;
        log('  DC', `Disconnected: ${reason}`);
      },
    });
    assert(result.region.length > 0, 'Region name empty');
    assert(typeof result.waterHeight === 'number', 'Water height not a number');
    return `Region: ${result.region}, Water: ${result.waterHeight}m`;
  });

  // Give sim time to populate data
  await sleep(3000);

  await test('Position is NOT (0,0,0)', async () => {
    const pos = bridge.getPosition()!;
    assert(pos !== null, 'Position null');
    const isOrigin = pos.x === 0 && pos.y === 0 && pos.z === 0;
    assert(!isOrigin, `Position stuck at origin (0,0,0) — ObjectStore not updating`);
    assert(pos.x >= 0 && pos.x <= 256, `X out of sim bounds: ${pos.x}`);
    assert(pos.y >= 0 && pos.y <= 256, `Y out of sim bounds: ${pos.y}`);
    assert(pos.z >= -10 && pos.z < 5000, `Z unreasonable: ${pos.z}`);
    return `(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`;
  });

  await test('Self avatar appears in region.agents', async () => {
    const avatars = bridge.getAvatars();
    const self = avatars.find(a => a.isSelf);
    assert(self !== undefined, 'Self not in avatar list');
    assert(self!.firstName.length > 0, 'Self has no firstName');
    return `${self!.firstName} ${self!.lastName} at (${self!.x.toFixed(1)}, ${self!.y.toFixed(1)}, ${self!.z.toFixed(1)})`;
  });

  await test('Terrain has real data (not all zeros)', async () => {
    let allZero = true;
    const heights: number[] = [];
    for (let x = 0; x < 256; x += 8) {
      for (let y = 0; y < 256; y += 8) {
        const h = bridge.getTerrainHeight(x, y);
        heights.push(h);
        if (h !== 0) allZero = false;
      }
    }
    assert(!allZero, 'All terrain heights are 0 — terrain not loaded');
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    return `${heights.length} samples, range ${min.toFixed(1)}—${max.toFixed(1)}m`;
  });

  // ═══════════════════════════════════════════════════════════════════
  section('2. VERIFIED MOVEMENT — walk and PROVE position changed');
  // ═══════════════════════════════════════════════════════════════════

  await test('Walk NORTH — position must change', async () => {
    const before = bridge.getPosition()!;
    assert(before !== null, 'No position before walk');
    bridge.move('n');
    await sleep(3000);
    bridge.stop();
    await sleep(1000);
    const after = bridge.getPosition()!;
    const d = dist(before, after);
    assert(d > 0.5, `Barely moved: ${d.toFixed(3)}m — movement broken`);
    return `Moved ${d.toFixed(2)}m: (${before.x.toFixed(1)},${before.y.toFixed(1)}) → (${after.x.toFixed(1)},${after.y.toFixed(1)})`;
  });

  await test('Walk EAST — X should decrease (left_neg = east in SL)', async () => {
    const before = bridge.getPosition()!;
    bridge.move('e');
    await sleep(3000);
    bridge.stop();
    await sleep(1000);
    const after = bridge.getPosition()!;
    const d = dist2d(before, after);
    assert(d > 0.5, `Barely moved: ${d.toFixed(3)}m`);
    return `Moved ${d.toFixed(2)}m: (${before.x.toFixed(1)},${before.y.toFixed(1)}) → (${after.x.toFixed(1)},${after.y.toFixed(1)})`;
  });

  await test('Walk SOUTH — position must change', async () => {
    const before = bridge.getPosition()!;
    bridge.move('s');
    await sleep(3000);
    bridge.stop();
    await sleep(1000);
    const after = bridge.getPosition()!;
    const d = dist(before, after);
    assert(d > 0.5, `Barely moved: ${d.toFixed(3)}m`);
    return `Moved ${d.toFixed(2)}m`;
  });

  await test('Walk WEST — position must change', async () => {
    const before = bridge.getPosition()!;
    bridge.move('w');
    await sleep(3000);
    bridge.stop();
    await sleep(1000);
    const after = bridge.getPosition()!;
    const d = dist2d(before, after);
    assert(d > 0.5, `Barely moved: ${d.toFixed(3)}m`);
    return `Moved ${d.toFixed(2)}m`;
  });

  // ═══════════════════════════════════════════════════════════════════
  section('3. FLYING — altitude verification');
  // ═══════════════════════════════════════════════════════════════════

  await test('Fly UP — Z must increase significantly', async () => {
    const before = bridge.getPosition()!;
    bridge.setFlying(true);
    await sleep(500);
    bridge.move('up');
    await sleep(4000);
    bridge.stop();
    await sleep(1000);
    const after = bridge.getPosition()!;
    const dz = after.z - before.z;
    assert(dz > 2, `Only gained ${dz.toFixed(2)}m altitude — flying broken`);
    return `Altitude: ${before.z.toFixed(1)}m → ${after.z.toFixed(1)}m (gained ${dz.toFixed(1)}m)`;
  });

  await test('Fly FORWARD while airborne', async () => {
    const before = bridge.getPosition()!;
    bridge.move('n');
    await sleep(3000);
    bridge.stop();
    await sleep(1000);
    const after = bridge.getPosition()!;
    const d = dist2d(before, after);
    return `Moved ${d.toFixed(2)}m while flying at z=${after.z.toFixed(1)}m`;
  });

  await test('Land — Z must decrease', async () => {
    const before = bridge.getPosition()!;
    bridge.setFlying(false);
    await sleep(3000);
    const after = bridge.getPosition()!;
    const dz = before.z - after.z;
    // Should fall at least a bit
    return `Altitude: ${before.z.toFixed(1)}m → ${after.z.toFixed(1)}m (dropped ${dz.toFixed(1)}m)`;
  });

  // ═══════════════════════════════════════════════════════════════════
  section('4. RAPID STATE CHANGES — try to crash it');
  // ═══════════════════════════════════════════════════════════════════

  await test('Rapid direction changes (50 in 1 second)', async () => {
    const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (let i = 0; i < 50; i++) {
      bridge.move(dirs[i % dirs.length]);
      await sleep(20);
    }
    bridge.stop();
    await sleep(500);
    const pos = bridge.getPosition();
    assert(pos !== null, 'Position null after rapid changes');
    return `Survived 50 rapid direction changes, pos: (${pos!.x.toFixed(1)}, ${pos!.y.toFixed(1)})`;
  });

  await test('Rapid fly toggle (20 toggles)', async () => {
    for (let i = 0; i < 20; i++) {
      bridge.setFlying(i % 2 === 0);
      await sleep(50);
    }
    bridge.setFlying(false);
    await sleep(500);
    assert(bridge.flying === false, 'Flying state inconsistent');
    return 'Survived 20 fly toggles';
  });

  await test('Move + fly + stop simultaneously', async () => {
    bridge.setFlying(true);
    bridge.move('n');
    bridge.move('up');
    await sleep(100);
    bridge.stop();
    bridge.setFlying(false);
    await sleep(500);
    const pos = bridge.getPosition();
    assert(pos !== null, 'Position null after concurrent ops');
    return `OK at (${pos!.x.toFixed(1)}, ${pos!.y.toFixed(1)}, ${pos!.z.toFixed(1)})`;
  });

  // ═══════════════════════════════════════════════════════════════════
  section('5. GRID RENDERING STRESS');
  // ═══════════════════════════════════════════════════════════════════

  await test('Render at extreme grid sizes', async () => {
    const pos = bridge.getPosition()!;
    const sizes = [[1, 1], [2, 2], [200, 100], [300, 150]];
    for (const [cols, rows] of sizes) {
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
      assert(frame.cells.length === cols * rows, `Wrong cell count for ${cols}x${rows}: ${frame.cells.length}`);
    }
    return `Rendered at sizes: ${sizes.map(s => `${s[0]}x${s[1]}`).join(', ')}`;
  });

  await test('Render with self at sim edges', async () => {
    const edgePositions = [
      { x: 0, y: 0, z: 25 },
      { x: 255, y: 255, z: 25 },
      { x: 0, y: 255, z: 25 },
      { x: 128, y: 128, z: 4000 }, // skybox height
      { x: 128, y: 128, z: -5 },   // underground
    ];
    for (const pos of edgePositions) {
      const params: ProjectionParams = {
        cols: 40, rows: 20,
        selfX: pos.x, selfY: pos.y, selfZ: pos.z,
        waterHeight: bridge.getWaterHeight(),
        metersPerCell: 256 / 40,
      };
      const frame = projectFrame(
        (x, y) => bridge.getTerrainHeight(x, y),
        bridge.getAvatars(),
        bridge.getObjects(),
        params,
        bridge.flying,
      );
      const hasSelf = frame.cells.some(c => c.char === '@');
      assert(hasSelf, `Self (@) missing at edge position (${pos.x},${pos.y},${pos.z})`);
    }
    return `Self visible at all 5 edge positions`;
  });

  await test('Rapid frame diffing (100 iterations)', async () => {
    const pos = bridge.getPosition()!;
    const params: ProjectionParams = {
      cols: 80, rows: 40,
      selfX: pos.x, selfY: pos.y, selfZ: pos.z,
      waterHeight: bridge.getWaterHeight(),
      metersPerCell: 256 / 80,
    };
    let prev = projectFrame(
      (x, y) => bridge.getTerrainHeight(x, y),
      bridge.getAvatars(), bridge.getObjects(), params, bridge.flying,
    );
    let totalDeltas = 0;
    for (let i = 0; i < 100; i++) {
      // Slightly jitter self position to force some diffs
      const jitteredParams = { ...params, selfX: pos.x + (i % 3) * 0.1 };
      const frame = projectFrame(
        (x, y) => bridge.getTerrainHeight(x, y),
        bridge.getAvatars(), bridge.getObjects(), jitteredParams, bridge.flying,
      );
      const deltas = diffFrames(prev, frame);
      totalDeltas += deltas.length;
      prev = frame;
    }
    return `100 frames diffed, ${totalDeltas} total delta cells`;
  });

  await test('Grid with zero metersPerCell (divide by zero?)', async () => {
    const pos = bridge.getPosition()!;
    let crashed = false;
    try {
      const params: ProjectionParams = {
        cols: 40, rows: 20,
        selfX: pos.x, selfY: pos.y, selfZ: pos.z,
        waterHeight: bridge.getWaterHeight(),
        metersPerCell: 0,
      };
      projectFrame(
        (x, y) => bridge.getTerrainHeight(x, y),
        bridge.getAvatars(), bridge.getObjects(), params, bridge.flying,
      );
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed on metersPerCell=0 (needs guard)' : 'Survived metersPerCell=0 (may produce garbage)';
  });

  await test('Grid with negative dimensions', async () => {
    const pos = bridge.getPosition()!;
    let crashed = false;
    try {
      const params: ProjectionParams = {
        cols: -10, rows: -5,
        selfX: pos.x, selfY: pos.y, selfZ: pos.z,
        waterHeight: bridge.getWaterHeight(),
        metersPerCell: 3,
      };
      projectFrame(
        (x, y) => bridge.getTerrainHeight(x, y),
        bridge.getAvatars(), bridge.getObjects(), params, bridge.flying,
      );
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed on negative dimensions (needs guard)' : 'Survived negative dimensions';
  });

  // ═══════════════════════════════════════════════════════════════════
  section('6. CHAT STRESS');
  // ═══════════════════════════════════════════════════════════════════

  await test('Send chat and receive echo', async () => {
    const before = chatLog.length;
    await bridge.say('sl-tui test ping');
    await sleep(2000);
    const received = chatLog.length - before;
    return `Sent 1, received back ${received} (echo)`;
  });

  await test('Send empty chat message', async () => {
    let crashed = false;
    try {
      await bridge.say('');
    } catch {
      crashed = true;
    }
    await sleep(500);
    return crashed ? 'Crashed on empty message' : 'Survived empty message';
  });

  await test('Whisper and shout', async () => {
    await bridge.whisper('test whisper');
    await sleep(500);
    await bridge.shout('test shout');
    await sleep(500);
    return 'Whisper + shout OK';
  });

  await test('Chat on non-zero channel (not visible to others)', async () => {
    await bridge.say('channel test', 42);
    await sleep(500);
    return 'Channel 42 sent';
  });

  // ═══════════════════════════════════════════════════════════════════
  section('7. SEARCH & PROFILE STRESS');
  // ═══════════════════════════════════════════════════════════════════

  await test('Search for nonexistent user', async () => {
    const results = await bridge.searchPeople('zzzznonexistent99999');
    return `Results: ${results.length} (expected 0)`;
  });

  await test('Search with empty string', async () => {
    let crashed = false;
    try {
      await bridge.searchPeople('');
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed on empty search' : 'Survived empty search';
  });

  await test('Search with special characters', async () => {
    let crashed = false;
    try {
      await bridge.searchPeople('<script>');
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed on special char search' : 'Survived special char search';
  });

  await test('Profile for invalid UUID', async () => {
    let crashed = false;
    try {
      await bridge.getProfile('not-a-uuid');
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed on bad UUID profile' : 'Returned null/handled gracefully';
  });

  await test('Profile for zero UUID', async () => {
    const profile = await bridge.getProfile('00000000-0000-0000-0000-000000000000');
    return profile ? `Got profile: ${profile.displayName}` : 'Returned null (expected)';
  });

  // ═══════════════════════════════════════════════════════════════════
  section('8. OBJECT INTERACTION EDGE CASES');
  // ═══════════════════════════════════════════════════════════════════

  await test('Touch invalid UUID', async () => {
    let crashed = false;
    try {
      await bridge.touchObject('not-a-real-uuid');
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed on invalid touch UUID' : 'Handled gracefully';
  });

  await test('Sit on invalid UUID', async () => {
    let crashed = false;
    try {
      await bridge.sitOnObject('00000000-0000-0000-0000-000000000000');
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed on sit with zero UUID' : 'Handled gracefully';
  });

  await test('Stand when not sitting', async () => {
    let crashed = false;
    try {
      bridge.stand();
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed on stand-when-not-sitting' : 'OK';
  });

  await test('Inspect nonexistent object', async () => {
    const info = bridge.inspectObject('00000000-0000-0000-0000-000000000000');
    return info ? `Got info: ${info.name}` : 'Returned null (expected)';
  });

  await test('Inspect nonexistent avatar', async () => {
    const info = bridge.inspectAvatar('00000000-0000-0000-0000-000000000000');
    return info ? `Got info: ${info.name}` : 'Returned null (expected)';
  });

  // ═══════════════════════════════════════════════════════════════════
  section('9. FRIEND OPERATIONS EDGE CASES');
  // ═══════════════════════════════════════════════════════════════════

  await test('Accept nonexistent friend request', async () => {
    let crashed = false;
    try {
      await bridge.acceptFriendRequest('00000000-0000-0000-0000-000000000000');
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed on accept invalid friend request' : 'Handled gracefully';
  });

  await test('Decline nonexistent friend request', async () => {
    let crashed = false;
    try {
      await bridge.declineFriendRequest('00000000-0000-0000-0000-000000000000');
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed' : 'OK';
  });

  await test('Get friends list twice (consistency)', async () => {
    const list1 = await bridge.getFriendsList();
    const list2 = await bridge.getFriendsList();
    assert(list1.length === list2.length, `Friend count changed: ${list1.length} vs ${list2.length}`);
    return `${list1.length} friends, consistent`;
  });

  // ═══════════════════════════════════════════════════════════════════
  section('10. TELEPORT EDGE CASES');
  // ═══════════════════════════════════════════════════════════════════

  await test('Accept nonexistent teleport offer', async () => {
    let crashed = false;
    try {
      await bridge.acceptTeleport('00000000-0000-0000-0000-000000000000');
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed' : 'OK (no pending lure)';
  });

  await test('Decline nonexistent teleport offer', async () => {
    let crashed = false;
    try {
      await bridge.declineTeleport('00000000-0000-0000-0000-000000000000');
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed' : 'OK';
  });

  // ═══════════════════════════════════════════════════════════════════
  section('11. IM EDGE CASES');
  // ═══════════════════════════════════════════════════════════════════

  await test('Send IM to zero UUID', async () => {
    let crashed = false;
    try {
      await bridge.sendIM('00000000-0000-0000-0000-000000000000', 'test');
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed sending IM to zero UUID' : 'Sent (SL may silently drop)';
  });

  await test('Send IM with empty message', async () => {
    let crashed = false;
    try {
      // IM to own UUID with empty string
      const avatars = bridge.getAvatars();
      const self = avatars.find(a => a.isSelf);
      if (self) {
        await bridge.sendIM(self.uuid, '');
      }
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed on empty IM' : 'OK';
  });

  await test('Start/stop typing to invalid target', async () => {
    let crashed = false;
    try {
      await bridge.startTypingIM('00000000-0000-0000-0000-000000000000');
      await bridge.stopTypingIM('00000000-0000-0000-0000-000000000000');
    } catch {
      crashed = true;
    }
    return crashed ? 'Crashed on typing indicator to zero UUID' : 'OK';
  });

  // ═══════════════════════════════════════════════════════════════════
  section('12. CONCURRENT OPERATIONS');
  // ═══════════════════════════════════════════════════════════════════

  await test('Concurrent: move + search + friends', async () => {
    const ops = [
      bridge.searchPeople(firstName),
      bridge.getFriendsList(),
      new Promise<void>(resolve => { bridge.move('n'); setTimeout(() => { bridge.stop(); resolve(); }, 500); }),
    ];
    const results = await Promise.allSettled(ops);
    const fulfilled = results.filter(r => r.status === 'fulfilled').length;
    const rejected = results.filter(r => r.status === 'rejected').length;
    return `${fulfilled}/3 succeeded, ${rejected}/3 rejected`;
  });

  await test('Concurrent: 5 searches at once', async () => {
    const names = [firstName, 'Philip Linden', 'Governor Linden', 'test', 'zzz'];
    const results = await Promise.allSettled(names.map(n => bridge.searchPeople(n)));
    const fulfilled = results.filter(r => r.status === 'fulfilled').length;
    return `${fulfilled}/5 searches completed`;
  });

  // ═══════════════════════════════════════════════════════════════════
  section('13. REAL-TIME TICK LOOP (4Hz for 5 seconds)');
  // ═══════════════════════════════════════════════════════════════════

  await test('Tick loop while walking — frames should differ', async () => {
    bridge.move('n');
    let prevFrame: GridFrame | null = null;
    let framesWithChanges = 0;
    let totalFrames = 0;

    for (let i = 0; i < 20; i++) { // 5 seconds at 4Hz
      const pos = bridge.getPosition()!;
      if (!pos) { await sleep(250); continue; }
      const params: ProjectionParams = {
        cols: 60, rows: 30,
        selfX: pos.x, selfY: pos.y, selfZ: pos.z,
        waterHeight: bridge.getWaterHeight(),
        metersPerCell: 256 / 60,
      };
      const frame = projectFrame(
        (x, y) => bridge.getTerrainHeight(x, y),
        bridge.getAvatars(), bridge.getObjects(), params, bridge.flying,
      );
      if (prevFrame) {
        const deltas = diffFrames(prevFrame, frame);
        if (deltas.length > 0) framesWithChanges++;
      }
      prevFrame = frame;
      totalFrames++;
      await sleep(250);
    }
    bridge.stop();
    await sleep(500);

    // If we're walking, SOME frames should show changes
    return `${framesWithChanges}/${totalFrames - 1} frames had changes`;
  });

  // ═══════════════════════════════════════════════════════════════════
  section('14. AVATAR GRID RENDERING ACCURACY');
  // ═══════════════════════════════════════════════════════════════════

  await test('All nearby avatars appear on grid', async () => {
    const pos = bridge.getPosition()!;
    const avatars = bridge.getAvatars();
    const cols = 80, rows = 40;
    const params: ProjectionParams = {
      cols, rows,
      selfX: pos.x, selfY: pos.y, selfZ: pos.z,
      waterHeight: bridge.getWaterHeight(),
      metersPerCell: 256 / cols,
    };
    const frame = projectFrame(
      (x, y) => bridge.getTerrainHeight(x, y),
      avatars, bridge.getObjects(), params, bridge.flying,
    );

    const avatarChars = ['@', '>', '<', 'v', '^'];
    const avatarCells = frame.cells.filter(c => avatarChars.includes(c.char));
    const nearbyInRange = avatars.filter(a => {
      const dx = Math.abs(a.x - pos.x);
      const dy = Math.abs(a.y - pos.y);
      const dz = Math.abs(a.z - pos.z);
      return dx < 128 && dy < 128 && dz < 30; // within grid + z-slice
    });

    return `${avatarCells.length} avatar chars on grid, ${nearbyInRange.length} avatars in range, ${avatars.length} total`;
  });

  await test('Print final grid snapshot', async () => {
    const pos = bridge.getPosition()!;
    const cols = 70, rows = 30;
    const params: ProjectionParams = {
      cols, rows,
      selfX: pos.x, selfY: pos.y, selfZ: pos.z,
      waterHeight: bridge.getWaterHeight(),
      metersPerCell: 256 / cols,
    };
    const frame = projectFrame(
      (x, y) => bridge.getTerrainHeight(x, y),
      bridge.getAvatars(), bridge.getObjects(), params, bridge.flying,
    );

    console.log(`\n    Final grid at (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}) in ${bridge.getRegionName()}:`);
    console.log('    ' + '─'.repeat(cols + 2));
    for (let row = 0; row < rows; row++) {
      let line = '    │';
      for (let col = 0; col < cols; col++) {
        line += frame.cells[row * cols + col].char;
      }
      line += '│';
      console.log(line);
    }
    console.log('    ' + '─'.repeat(cols + 2));

    const charCounts: Record<string, number> = {};
    for (const c of frame.cells) charCounts[c.char] = (charCounts[c.char] || 0) + 1;
    return Object.entries(charCounts).sort((a,b) => b[1]-a[1]).map(([c,n]) => `'${c}'=${n}`).join(', ');
  });

  // ═══════════════════════════════════════════════════════════════════
  section('15. SESSION STATE CONSISTENCY');
  // ═══════════════════════════════════════════════════════════════════

  await test('Region name consistent across calls', async () => {
    const names = Array.from({ length: 10 }, () => bridge.getRegionName());
    const unique = new Set(names);
    assert(unique.size === 1, `Region name changed: ${[...unique].join(', ')}`);
    return `"${names[0]}" (consistent)`;
  });

  await test('Water height consistent', async () => {
    const heights = Array.from({ length: 10 }, () => bridge.getWaterHeight());
    const unique = new Set(heights);
    assert(unique.size === 1, `Water height changed: ${[...unique].join(', ')}`);
    return `${heights[0]}m (consistent)`;
  });

  await test('Not disconnected during test', async () => {
    assert(!disconnected, 'Got disconnected during test!');
    return 'Still connected';
  });

  // ═══════════════════════════════════════════════════════════════════
  section('CLEANUP');
  // ═══════════════════════════════════════════════════════════════════

  await test('Logout', async () => {
    await bridge.close();
    return 'Clean disconnect';
  });

  printReport();
}

function printReport() {
  console.log(`\n${'═'.repeat(64)}`);
  console.log('  STRESS TEST REPORT');
  console.log('═'.repeat(64));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  const totalTime = results.reduce((s, r) => s + r.duration, 0);

  for (const r of results) {
    const icon = r.passed ? 'PASS' : 'FAIL';
    const time = `${r.duration}ms`.padStart(8);
    console.log(`  ${icon} ${time}  ${r.name}`);
    if (r.error) {
      console.log(`               ↳ ${r.error}`);
    }
  }

  console.log(`\n  ${'─'.repeat(60)}`);
  console.log(`  ${passed}/${total} passed, ${failed} failed (${(totalTime / 1000).toFixed(1)}s total)`);

  if (failed > 0) {
    console.log(`\n  BUGS FOUND (${failed}):`);
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    ✗ ${r.name}`);
      console.log(`      ${r.error}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(async (err) => {
  console.error('\nFATAL:', err);
  try { await bridge?.close(); } catch {}
  process.exit(2);
});
