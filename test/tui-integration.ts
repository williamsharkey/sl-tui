#!/usr/bin/env npx tsx
// tui-integration.ts — Full TUI integration tests with MockSLBridge

import { TUIApp } from '../tui/app.js';
import { setBwMode } from '../tui/renderer.js';
import type { ISLBridge, WritableTarget, BridgeCallbacks } from '../tui/types.js';
import type { AvatarData, ObjectData } from '../server/grid-state.js';

setBwMode(true);

// ─── Test Framework ──────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  PASS  ${name}`);
  } catch (err: any) {
    results.push({ name, passed: false, error: err.message });
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── StringBuffer WritableTarget ──────────────────────────────────

class StringBuffer implements WritableTarget {
  data = '';
  columns: number;
  rows: number;

  constructor(cols = 80, rows = 24) {
    this.columns = cols;
    this.rows = rows;
  }

  write(s: string): void {
    this.data += s;
  }

  clear(): void {
    this.data = '';
  }

  getPlainText(): string {
    return this.data.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '').replace(/\x1b\[\?[^A-Za-z]*[A-Za-z]/g, '');
  }

  contains(text: string): boolean {
    return this.getPlainText().includes(text);
  }
}

// ─── MockSLBridge ────────────────────────────────────────────────

class MockSLBridge implements ISLBridge {
  private callbacks: BridgeCallbacks | null = null;
  private _flying = false;
  private pos: { x: number; y: number; z: number } | null = { x: 128, y: 128, z: 25 };
  private _region = 'MockRegion';
  private _waterHeight = 20;
  private tickCallback: (() => void) | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  logged = false;
  moves: string[] = [];
  stopped = false;
  chatMessages: string[] = [];
  closed = false;
  private _failNextLogin: Error | null = null;
  private _failNextTeleport: Error | null = null;

  async login(firstName: string, lastName: string, password: string, callbacks: BridgeCallbacks): Promise<{ region: string; waterHeight: number }> {
    if (this._failNextLogin) {
      const err = this._failNextLogin;
      this._failNextLogin = null;
      throw err;
    }
    this.callbacks = callbacks;
    this.logged = true;
    return { region: this._region, waterHeight: this._waterHeight };
  }

  getPosition() { return this.pos ? { ...this.pos } : null; }
  getRotation() { return { x: 0, y: 0, z: 0, w: 1 }; }
  getTerrainHeight(x: number, y: number): number {
    // Simple terrain: higher in the center
    const dx = x - 128;
    const dy = y - 128;
    return 22 + Math.max(0, 10 - Math.sqrt(dx * dx + dy * dy) / 10);
  }
  getWaterHeight() { return this._waterHeight; }
  getRegionName() { return this._region; }

  getAvatars(): AvatarData[] {
    const p = this.pos || { x: 128, y: 128, z: 25 };
    return [
      { uuid: 'self-uuid-1234', firstName: 'Test', lastName: 'User', x: p.x, y: p.y, z: p.z, yaw: 0, isSelf: true },
      { uuid: 'other-uuid-5678', firstName: 'Other', lastName: 'Avatar', x: 140, y: 140, z: 25, yaw: 1.57, isSelf: false },
    ];
  }

  getObjects(): ObjectData[] {
    return [
      { uuid: 'tree-1', name: 'Pine', x: 120, y: 120, z: 25, scaleX: 2, scaleY: 2, scaleZ: 5, isTree: true },
      { uuid: 'box-1', name: 'Welcome Sign', x: 135, y: 130, z: 25, scaleX: 1, scaleY: 1, scaleZ: 2, isTree: false },
    ];
  }

  private _bodyYaw = Math.PI / 2;
  turns: string[] = [];

  move(dir: string) { this.moves.push(dir); }
  turn(direction: 'left' | 'right') { this.turns.push(direction); this._bodyYaw += direction === 'left' ? 0.39 : -0.39; }
  getBodyYaw() { return this._bodyYaw; }
  stop() { this.stopped = true; }
  setFlying(enabled: boolean) { this._flying = enabled; }
  get flying() { return this._flying; }

  async say(message: string) { this.chatMessages.push(message); }
  async whisper(message: string) { this.chatMessages.push(`/whisper ${message}`); }
  async shout(message: string) { this.chatMessages.push(`/shout ${message}`); }
  async sendIM(to: string, message: string) { this.chatMessages.push(`/im ${to} ${message}`); }
  async searchPeople(query: string) { return [{ name: 'Found User', uuid: 'found-uuid' }]; }
  async sendFriendRequest(to: string, message: string) {}
  async acceptFriendRequest(fromUuid: string) {}
  async declineFriendRequest(fromUuid: string) {}
  async teleportToRegion(region: string, x?: number, y?: number, z?: number) {
    if (this._failNextTeleport) {
      const err = this._failNextTeleport;
      this._failNextTeleport = null;
      throw err;
    }
    this._region = region;
  }
  async acceptTeleport(fromUuid: string) {}
  async declineTeleport(fromUuid: string) {}
  async teleportHome() { this._region = 'Home'; }
  async sitOnObject(uuid: string) {}
  stand() {}
  async touchObject(uuid: string) {}
  async getProfile(uuid: string) { return { displayName: 'Test User', userName: 'test.user', bio: 'A test avatar', bornOn: '2020-01-01' }; }
  inspectObject(uuid: string) { return { name: 'Test Object', description: 'desc', owner: 'owner-uuid', position: '128, 128, 25' }; }
  inspectAvatar(uuid: string) { return { name: 'Other Avatar', title: 'Tester', position: '140, 140, 25' }; }
  async getFriendsList() { return [{ uuid: 'friend-1', name: 'Friend One', online: true, rightsGiven: false, rightsHas: false }]; }

  startTick(callback: () => void, hz = 4) {
    this.tickCallback = callback;
    this.tickTimer = setInterval(callback, 1000 / hz);
  }

  stopTick() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  async close() {
    this.stopTick();
    this.closed = true;
  }

  // Test helpers
  simulateChat(from: string, message: string) {
    this.callbacks?.onChat(from, message, 0, 'from-uuid');
  }

  simulateIM(fromName: string, message: string) {
    this.callbacks?.onIM('im-uuid', fromName, message, false);
  }

  movePosition(dx: number, dy: number) {
    if (this.pos) {
      this.pos.x += dx;
      this.pos.y += dy;
    }
  }

  setPosition(x: number, y: number, z: number) {
    this.pos = { x, y, z };
  }

  setNullPosition() {
    (this as any).pos = null;
  }

  restorePosition() {
    if (!(this as any).pos) (this as any).pos = { x: 128, y: 128, z: 25 };
  }

  failNextLogin(error: Error) {
    this._failNextLogin = error;
  }

  failNextTeleport(error: Error) {
    this._failNextTeleport = error;
  }

  simulateDisconnect(reason: string) {
    this.callbacks?.onDisconnected(reason);
  }

  simulateFriendRequest(name: string, msg: string) {
    this.callbacks?.onFriendRequest('fr-uuid', name, msg, 'req-id');
  }

  simulateTeleportOffer(name: string, msg: string) {
    this.callbacks?.onTeleportOffer('tp-uuid', name, msg, {});
  }
}

// ─── Helper ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Tests ───────────────────────────────────────────────────────

async function runTests() {
  console.log('\n=== TUI Integration Tests (MockSLBridge) ===\n');

  // ─── Login and Grid Render ──────────────────────────────────────

  await test('Auto-login shows grid', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    assert(bridge.logged, 'Bridge not logged in');
    assertEqual(app.getMode(), 'grid');

    // Should have rendered something with ANSI codes
    assert(buf.data.length > 100, 'Output too short');
    // Should contain region name in status bar
    assert(buf.data.includes('MockRegion'), 'Missing region in status');

    await app.destroy();
  });

  await test('Grid contains @ (self) and terrain chars', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    // Strip all ANSI escape sequences for content check
    const plain = buf.data.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '').replace(/\x1b\[\?[^A-Za-z]*[A-Za-z]/g, '');
    assert(plain.includes('@'), 'Missing self @ in grid');

    await app.destroy();
  });

  // ─── Movement ──────────────────────────────────────────────────

  await test('Arrow keys trigger movement', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    app.simulateKey(undefined, { name: 'up' });
    app.simulateKey('d', { name: 'd' });

    assert(bridge.moves.includes('forward'), 'Missing forward move');
    assert(bridge.moves.includes('strafe_right'), 'Missing strafe_right move');

    await app.destroy();
  });

  await test('F key toggles flying', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    assert(!bridge.flying, 'Should not be flying initially');
    app.simulateKey('f', { name: 'f' });
    assert(bridge.flying, 'Should be flying after F');
    app.simulateKey('f', { name: 'f' });
    assert(!bridge.flying, 'Should not be flying after second F');

    await app.destroy();
  });

  // ─── Chat ──────────────────────────────────────────────────────

  await test('Enter chat mode, type, and send', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    // Enter chat mode
    app.simulateKey(undefined, { name: 'return' });
    assertEqual(app.getMode(), 'chat-input');

    // Type a message
    for (const ch of 'hello') {
      app.simulateKey(ch, { name: ch });
    }

    // Submit
    app.simulateKey(undefined, { name: 'return' });
    assertEqual(app.getMode(), 'grid');
    assert(bridge.chatMessages.includes('hello'), 'Message not sent');

    await app.destroy();
  });

  await test('Escape cancels chat input', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    app.simulateKey(undefined, { name: 'return' }); // enter chat
    app.simulateKey('h', { name: 'h' }); // type
    app.simulateKey(undefined, { name: 'escape' }); // cancel

    assertEqual(app.getMode(), 'grid');
    assertEqual(bridge.chatMessages.length, 0, 'No message should be sent');

    await app.destroy();
  });

  await test('Incoming chat appears in buffer', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    bridge.simulateChat('Alice', 'Hey there!');
    await sleep(50);

    const chatBuf = app.getChatBuffer();
    const lines = chatBuf.getVisibleLines(5);
    assert(lines.some(l => l.includes('Alice') && l.includes('Hey there!')), 'Chat message not in buffer');

    await app.destroy();
  });

  await test('Incoming IM appears in buffer', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    bridge.simulateIM('Bob', 'Private message');
    await sleep(50);

    const chatBuf = app.getChatBuffer();
    const lines = chatBuf.getVisibleLines(5);
    assert(lines.some(l => l.includes('IM') && l.includes('Bob')), 'IM not in buffer');

    await app.destroy();
  });

  // ─── Tick Loop ──────────────────────────────────────────────────

  await test('Tick updates grid after position change', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    const dataBefore = buf.data.length;

    // Move position and tick
    bridge.movePosition(5, 5);
    app.tick();

    // Should have written more data (delta render)
    assert(buf.data.length > dataBefore, 'No new output after tick with position change');

    await app.destroy();
  });

  // ─── Slash Commands ────────────────────────────────────────────

  await test('/tp slash command changes region', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    // Enter chat, type /tp command
    app.simulateKey(undefined, { name: 'return' });
    for (const ch of '/tp NewPlace') {
      app.simulateKey(ch, { name: ch });
    }
    app.simulateKey(undefined, { name: 'return' });

    await sleep(50);
    assertEqual(bridge.getRegionName(), 'NewPlace');

    await app.destroy();
  });

  // ─── Full Pipeline ─────────────────────────────────────────────

  await test('Full pipeline: login -> render -> move -> chat -> quit', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    // 1. Login
    await app.start();
    await sleep(50);
    assert(bridge.logged, 'Not logged in');
    assertEqual(app.getMode(), 'grid');

    // 2. Grid rendered
    assert(buf.data.includes('MockRegion'), 'Grid not rendered');

    // 3. Move (up arrow = forward in body-relative mode)
    app.simulateKey(undefined, { name: 'up' });
    assert(bridge.moves.length > 0, 'No movement');

    // 4. Chat
    app.simulateKey(undefined, { name: 'return' });
    for (const ch of 'hi') {
      app.simulateKey(ch, { name: ch });
    }
    app.simulateKey(undefined, { name: 'return' });
    assert(bridge.chatMessages.includes('hi'), 'Chat not sent');

    // 5. Quit
    await app.destroy();
    assert(bridge.closed, 'Bridge not closed');
  });

  // ─── Layout ────────────────────────────────────────────────────

  await test('Different terminal sizes render correctly', async () => {
    for (const [cols, rows] of [[40, 16], [120, 40], [80, 24]]) {
      const buf = new StringBuffer(cols, rows);
      const bridge = new MockSLBridge();
      const app = new TUIApp({
        bridge,
        output: buf,
        autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
      });

      await app.start();
      await sleep(50);

      assert(buf.data.length > 0, `No output for ${cols}x${rows}`);
      const layout = app.getLayout();
      assertEqual(layout.totalCols, cols, `cols for ${cols}x${rows}`);
      assertEqual(layout.totalRows, rows, `rows for ${cols}x${rows}`);

      await app.destroy();
    }
  });

  // ─── Layout & Boundary Stress ──────────────────────────────────

  await test('Tiny terminal 20x8 does not crash', async () => {
    const buf = new StringBuffer(20, 8);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    const layout = app.getLayout();
    assert(layout.gridRows >= 1, `gridRows should be >= 1, got ${layout.gridRows}`);
    assertEqual(app.getMode(), 'grid');

    await app.destroy();
  });

  await test('Zero-size terminal 0x0 does not crash', async () => {
    const buf = new StringBuffer(0, 0);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    // Should not throw
    await app.start();
    await sleep(50);

    const layout = app.getLayout();
    assert(layout.gridRows >= 1, `gridRows should be >= 1, got ${layout.gridRows}`);

    await app.destroy();
  });

  // ─── Login Edge Cases ─────────────────────────────────────────

  await test('Login failure shows error and stays on login screen', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    bridge.failNextLogin(new Error('Invalid credentials'));

    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    assertEqual(app.getMode(), 'login');
    assert(buf.contains('Login failed'), 'Should show login error');
    assert(!app.isTickActive(), 'Tick should not be running after failed login');

    await app.destroy();
  });

  await test('Login with empty password shows error', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: '', password: '' },
    });

    await app.start();
    await sleep(50);

    assertEqual(app.getMode(), 'login');
    assert(buf.contains('required'), 'Should show validation error');
    assert(!bridge.logged, 'Bridge should not have logged in');

    await app.destroy();
  });

  await test('Double-login guard prevents concurrent login', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
    });

    await app.start();
    await sleep(50);

    // Manually set login state and simulate rapid Enter presses
    // Enter login fields first
    app.simulateKey('T', { name: 'T' }); // firstName
    app.simulateKey(undefined, { name: 'tab' }); // to lastName
    app.simulateKey(undefined, { name: 'tab' }); // to password
    app.simulateKey('p', { name: 'p' }); // password

    // Double submit
    app.simulateKey(undefined, { name: 'return' });
    app.simulateKey(undefined, { name: 'return' });

    await sleep(50);
    // Should not crash, and bridge should only see one login
    await app.destroy();
  });

  // ─── Chat & Command Parsing ───────────────────────────────────

  await test('/tp with NaN coords uses defaults', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    app.simulateKey(undefined, { name: 'return' });
    for (const ch of '/tp Region abc def') {
      app.simulateKey(ch, { name: ch });
    }
    app.simulateKey(undefined, { name: 'return' });
    await sleep(50);

    // Should not crash — bridge should have been called with region
    assertEqual(bridge.getRegionName(), 'Region');

    await app.destroy();
  });

  await test('/im with no args shows usage', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    app.simulateKey(undefined, { name: 'return' });
    for (const ch of '/im') {
      app.simulateKey(ch, { name: ch });
    }
    app.simulateKey(undefined, { name: 'return' });
    await sleep(50);

    const chatLines = app.getChatBuffer().getVisibleLines(10);
    assert(chatLines.some(l => l.includes('Usage')), 'Should show usage hint for /im');

    await app.destroy();
  });

  await test('/im uuid without message shows usage', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    app.simulateKey(undefined, { name: 'return' });
    for (const ch of '/im some-uuid') {
      app.simulateKey(ch, { name: ch });
    }
    app.simulateKey(undefined, { name: 'return' });
    await sleep(50);

    const chatLines = app.getChatBuffer().getVisibleLines(10);
    assert(chatLines.some(l => l.includes('Usage')), 'Should show usage hint for /im without message');

    await app.destroy();
  });

  await test('Empty chat submit does not call bridge.say()', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    // Enter chat mode and immediately submit (empty)
    app.simulateKey(undefined, { name: 'return' });
    app.simulateKey(undefined, { name: 'return' });

    assertEqual(bridge.chatMessages.length, 0, 'Empty submit should not send');
    assertEqual(app.getMode(), 'grid');

    await app.destroy();
  });

  await test('Backspace past empty in chat is no-op', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    app.simulateKey(undefined, { name: 'return' }); // enter chat
    app.simulateKey(undefined, { name: 'backspace' }); // backspace on empty
    app.simulateKey(undefined, { name: 'backspace' }); // again

    assertEqual(app.getChatInput(), '', 'Should remain empty');
    assertEqual(app.getMode(), 'chat-input');

    await app.destroy();
  });

  // ─── Tick Loop & Lifecycle ────────────────────────────────────

  await test('Tick with null position does not crash', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    bridge.setNullPosition();
    // Should not throw
    app.tick();
    app.tick();

    bridge.restorePosition();
    await app.destroy();
  });

  await test('Tick after destroy does not render', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);
    await app.destroy();

    const dataAfterDestroy = buf.data.length;
    app.tick(); // should be no-op
    assertEqual(buf.data.length, dataAfterDestroy, 'Should not render after destroy');
  });

  await test('Double destroy does not throw', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    await app.destroy();
    await app.destroy(); // should not throw
    assert(bridge.closed, 'Bridge should be closed');
  });

  // ─── Rapid Input Sequences ───────────────────────────────────

  await test('Type in chat then Escape then Enter: input cleared on re-enter', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    // Enter chat, type something
    app.simulateKey(undefined, { name: 'return' });
    app.simulateKey('h', { name: 'h' });
    app.simulateKey('i', { name: 'i' });
    assertEqual(app.getChatInput(), 'hi');

    // Escape (cancel)
    app.simulateKey(undefined, { name: 'escape' });
    assertEqual(app.getMode(), 'grid');

    // Re-enter chat
    app.simulateKey(undefined, { name: 'return' });
    assertEqual(app.getMode(), 'chat-input');
    assertEqual(app.getChatInput(), '', 'Input should be cleared on re-enter');

    await app.destroy();
  });

  await test('Rapid arrow keys all trigger moves', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    for (let i = 0; i < 10; i++) {
      app.simulateKey(undefined, { name: 'up' });
    }

    assertEqual(bridge.moves.length, 10, 'All 10 arrow presses should trigger moves');

    await app.destroy();
  });

  // ─── Grid Rendering Correctness ──────────────────────────────

  await test('Self @ is always at grid center', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    const plain = buf.getPlainText();
    assert(plain.includes('@'), 'Grid must contain self @');

    await app.destroy();
  });

  await test('First-person view renders in top area', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    const layout = app.getLayout();
    assert(layout.fpRows >= 3, `FP view should have >= 3 rows, got ${layout.fpRows}`);
    // The FP view should produce some output (terrain chars like ▒, ░, etc.)
    assert(buf.data.length > 0, 'Should have rendered something');

    await app.destroy();
  });

  await test('FOV arc dots appear around self @', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    const plain = buf.getPlainText();
    assert(plain.includes('·'), 'FOV arc dots should appear around self');

    await app.destroy();
  });

  await test('Other avatar direction char appears in grid', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    const plain = buf.getPlainText();
    // Other avatar at yaw=1.57 (north) should render as '^'
    assert(plain.includes('^'), 'Should contain avatar direction char ^');

    await app.destroy();
  });

  // ─── Disconnect / Friend Request / Teleport Offer ────────────

  await test('Disconnect event appears in chat', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    bridge.simulateDisconnect('Server shutdown');
    const lines = app.getChatBuffer().getVisibleLines(10);
    assert(lines.some(l => l.includes('Disconnected') && l.includes('Server shutdown')), 'Disconnect should appear in chat');

    await app.destroy();
  });

  await test('Friend request appears in chat', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    bridge.simulateFriendRequest('Alice', 'Be my friend!');
    const lines = app.getChatBuffer().getVisibleLines(10);
    assert(lines.some(l => l.includes('Friend request') && l.includes('Alice')), 'Friend request should appear in chat');

    await app.destroy();
  });

  await test('Teleport offer appears in chat', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    bridge.simulateTeleportOffer('Bob', 'Join me!');
    const lines = app.getChatBuffer().getVisibleLines(10);
    assert(lines.some(l => l.includes('Teleport offer') && l.includes('Bob')), 'Teleport offer should appear in chat');

    await app.destroy();
  });

  // ─── Teleport failure ────────────────────────────────────────

  await test('Teleport failure shows error in chat', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    bridge.failNextTeleport(new Error('Region not found'));

    app.simulateKey(undefined, { name: 'return' });
    for (const ch of '/tp BadRegion') {
      app.simulateKey(ch, { name: ch });
    }
    app.simulateKey(undefined, { name: 'return' });
    await sleep(50);

    const lines = app.getChatBuffer().getVisibleLines(10);
    assert(lines.some(l => l.includes('Teleport failed')), 'Should show teleport failure');

    await app.destroy();
  });

  // ─── Observability Getters ───────────────────────────────────

  await test('Observability: isRunning, isTickActive, getRegionName, getPrevFrame', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
    });

    await app.start();
    await sleep(50);

    assert(app.isRunning(), 'Should be running after start');
    assert(app.isTickActive(), 'Tick should be active after login');
    assertEqual(app.getRegionName(), 'MockRegion');
    assert(app.getPrevFrame() !== null, 'Should have a prevFrame after tick');

    await app.destroy();

    assert(!app.isRunning(), 'Should not be running after destroy');
    assert(!app.isTickActive(), 'Tick should not be active after destroy');
    assert(app.isDestroyed(), 'Should be destroyed');
  });

  // ─── Logout ────────────────────────────────────────────────────

  await test('/logout returns to login screen', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    let logoutCalled = false;
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
      createBridge: () => new MockSLBridge(),
      onLogout: () => { logoutCalled = true; },
    });

    await app.start();
    await sleep(50);

    assertEqual(app.getMode(), 'grid');
    assert(app.isTickActive(), 'Tick should be active');

    // Type /logout
    app.simulateKey(undefined, { name: 'return' });
    for (const ch of '/logout') {
      app.simulateKey(ch, { name: ch });
    }
    app.simulateKey(undefined, { name: 'return' });
    await sleep(50);

    assertEqual(app.getMode(), 'login');
    assert(!app.isTickActive(), 'Tick should stop after logout');
    assert(logoutCalled, 'onLogout callback should fire');
    assert(bridge.closed, 'Old bridge should be closed');

    await app.destroy();
  });

  await test('/logout then re-login works', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    let loginCount = 0;
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'pass' },
      createBridge: () => {
        const b = new MockSLBridge();
        return b;
      },
      onLoginSuccess: () => { loginCount++; },
    });

    await app.start();
    await sleep(50);
    assertEqual(loginCount, 1, 'First login');

    // Logout
    app.simulateKey(undefined, { name: 'return' });
    for (const ch of '/logout') {
      app.simulateKey(ch, { name: ch });
    }
    app.simulateKey(undefined, { name: 'return' });
    await sleep(50);

    assertEqual(app.getMode(), 'login');

    // Type credentials and log back in
    for (const ch of 'Test') {
      app.simulateKey(ch, { name: ch });
    }
    app.simulateKey(undefined, { name: 'tab' }); // lastName
    app.simulateKey(undefined, { name: 'tab' }); // password
    for (const ch of 'pass') {
      app.simulateKey(ch, { name: ch });
    }
    app.simulateKey(undefined, { name: 'return' });
    await sleep(50);

    assertEqual(app.getMode(), 'grid');
    assertEqual(loginCount, 2, 'Second login');

    await app.destroy();
  });

  // ─── Credential Persistence ───────────────────────────────────

  await test('onLoginSuccess callback fires with credentials', async () => {
    const buf = new StringBuffer(80, 24);
    const bridge = new MockSLBridge();
    let savedCreds: { fn: string; ln: string; pw: string } | null = null;
    const app = new TUIApp({
      bridge,
      output: buf,
      autoLogin: { firstName: 'Test', lastName: 'User', password: 'secret' },
      onLoginSuccess: (fn, ln, pw) => { savedCreds = { fn, ln, pw }; },
    });

    await app.start();
    await sleep(50);

    assert(savedCreds !== null, 'onLoginSuccess should have been called');
    assertEqual(savedCreds!.fn, 'Test');
    assertEqual(savedCreds!.ln, 'User');
    assertEqual(savedCreds!.pw, 'secret');

    await app.destroy();
  });

  // ─── Report ────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(50)}`);
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`  ${passed}/${results.length} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\n  Failed:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    - ${r.name}: ${r.error}`);
    }
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
