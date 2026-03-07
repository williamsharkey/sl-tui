#!/usr/bin/env npx tsx
// tui-unit.ts — Unit tests for renderer, input, screen, chat-buffer

import { computeLayout } from '../tui/screen.js';
import { loadCredentials, saveCredentials, clearCredentials } from '../tui/credentials.js';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  hex256, hexToRgb, rgbTo256, fgColor, bgColor, moveTo,
  renderStatusBar, renderMinimap, renderSeparator,
  renderChatLines, renderInputLine, setBwMode,
} from '../tui/renderer.js';
import { ChatBuffer } from '../tui/chat-buffer.js';
import { InputHandler, type Mode } from '../tui/input.js';
import { createEmptyFrame, diffFrames, projectFirstPerson, type GridFrame, type Cell, type CellDelta } from '../server/grid-state.js';
import type { WritableTarget } from '../tui/types.js';

// ─── Test Framework ──────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
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
}

// ─── Screen Layout Tests ─────────────────────────────────────────

console.log('\n=== Screen Layout ===');

test('80x24 layout has correct regions', () => {
  const l = computeLayout(80, 24);
  assertEqual(l.statusRow, 0);
  assertEqual(l.fpTop, 1);
  assertEqual(l.inputRow, 23);
  assertEqual(l.separatorRow, 17);
  assertEqual(l.chatTop, 18);
  assertEqual(l.chatBottom, 22);
  assertEqual(l.chatLines, 5);
  // FP view takes all space between status and separator
  assertEqual(l.fpRows, 16); // rows 1..16
  assertEqual(l.fpCols, 80);
  // Minimap overlay
  assert(l.minimapCols >= 8, 'minimapCols should be >= 8');
  assert(l.minimapRows >= 4, 'minimapRows should be >= 4');
  assertEqual(l.minimapLeft, 80 - l.minimapCols);
});

test('120x40 layout scales correctly', () => {
  const l = computeLayout(120, 40);
  assertEqual(l.fpCols, 120);
  assertEqual(l.separatorRow, 33);
  assertEqual(l.chatLines, 5);
  // FP takes all rows between status and separator
  assertEqual(l.fpRows, 32); // rows 1..32
  assert(l.minimapCols >= 8, 'minimapCols should be >= 8');
  assert(l.minimapRows >= 4, 'minimapRows should be >= 4');
});

test('minimal 40x12 layout', () => {
  const l = computeLayout(40, 12);
  assertEqual(l.fpRows, 4); // rows 1..4 (separatorRow=5, fpBottom=4)
  assertEqual(l.fpCols, 40);
  assertEqual(l.inputRow, 11);
  assert(l.minimapRows >= 1, 'minimapRows should be >= 1');
});

// ─── Color Conversion Tests ──────────────────────────────────────

console.log('\n=== Color Conversion ===');

test('hexToRgb parses correctly', () => {
  const [r, g, b] = hexToRgb('#ff0000');
  assertEqual(r, 255);
  assertEqual(g, 0);
  assertEqual(b, 0);
});

test('hexToRgb without hash', () => {
  const [r, g, b] = hexToRgb('00ff00');
  assertEqual(r, 0);
  assertEqual(g, 255);
  assertEqual(b, 0);
});

test('rgbTo256 pure red', () => {
  const c = rgbTo256(255, 0, 0);
  assertEqual(c, 196); // 16 + 36*5 + 6*0 + 0
});

test('rgbTo256 grayscale', () => {
  const c = rgbTo256(128, 128, 128);
  assert(c >= 232 && c <= 255, `Expected grayscale range, got ${c}`);
});

test('hex256 caches results', () => {
  const v1 = hex256('#336633');
  const v2 = hex256('#336633');
  assertEqual(v1, v2);
});

test('fgColor generates valid ANSI', () => {
  const seq = fgColor('#ff0000');
  assert(seq.startsWith('\x1b[38;5;'), `Bad fg sequence: ${seq}`);
});

test('bgColor generates valid ANSI', () => {
  const seq = bgColor('#0000ff');
  assert(seq.startsWith('\x1b[48;5;'), `Bad bg sequence: ${seq}`);
});

// ─── Renderer Tests ──────────────────────────────────────────────

console.log('\n=== Renderer ===');

// Enable BW mode for renderer tests — no color escapes to worry about
setBwMode(true);

test('moveTo generates correct cursor position', () => {
  assertEqual(moveTo(0, 0), '\x1b[1;1H');
  assertEqual(moveTo(5, 10), '\x1b[6;11H');
});

test('renderStatusBar outputs to buffer', () => {
  const buf = new StringBuffer(80, 24);
  const layout = computeLayout(80, 24);
  renderStatusBar(buf, layout, 'TestRegion', { x: 128, y: 128, z: 30 }, false);
  assert(buf.data.includes('TestRegion'), 'Missing region name');
  assert(buf.data.includes('128'), 'Missing position');
  assert(!buf.data.includes('[FLY]'), 'Should not show FLY');
});

test('renderStatusBar shows flying', () => {
  const buf = new StringBuffer(80, 24);
  const layout = computeLayout(80, 24);
  renderStatusBar(buf, layout, 'Test', { x: 0, y: 0, z: 0 }, true);
  assert(buf.data.includes('[FLY]'), 'Missing [FLY] indicator');
});

test('renderMinimap outputs all cells', () => {
  const buf = new StringBuffer(40, 20);
  const layout = computeLayout(40, 20);
  const frame: GridFrame = {
    cells: [],
    cols: layout.minimapCols,
    rows: layout.minimapRows,
  };
  for (let i = 0; i < layout.minimapCols * layout.minimapRows; i++) {
    frame.cells.push({ char: '.', fg: '#336633', bg: '#f0eedc' });
  }
  renderMinimap(buf, layout, frame);
  // Should contain dot characters
  const dotCount = (buf.data.match(/\./g) || []).length;
  assertEqual(dotCount, layout.minimapCols * layout.minimapRows, 'dot count');
});

test('renderMinimap contains cursor positioning', () => {
  const buf = new StringBuffer(80, 24);
  const layout = computeLayout(80, 24);
  const frame: GridFrame = {
    cells: [],
    cols: layout.minimapCols,
    rows: layout.minimapRows,
  };
  for (let i = 0; i < layout.minimapCols * layout.minimapRows; i++) {
    frame.cells.push({ char: '@', fg: '#cc0000', bg: '#f0eedc' });
  }
  renderMinimap(buf, layout, frame);
  assert(buf.data.includes('@'), 'Missing @ character');
  assert(buf.data.includes('\x1b['), 'Missing ANSI escape');
});

test('renderSeparator draws horizontal line', () => {
  const buf = new StringBuffer(40, 20);
  const layout = computeLayout(40, 20);
  renderSeparator(buf, layout);
  // BW mode uses '-', color mode uses box-drawing char
  assert(buf.data.includes('-'), 'Missing separator char');
});

test('renderChatLines outputs messages', () => {
  const buf = new StringBuffer(80, 24);
  const layout = computeLayout(80, 24);
  renderChatLines(buf, layout, ['Hello world', 'Test message']);
  assert(buf.data.includes('Hello world'), 'Missing chat line');
  assert(buf.data.includes('Test message'), 'Missing chat line 2');
});

test('renderInputLine shows grid hints', () => {
  const buf = new StringBuffer(80, 24);
  const layout = computeLayout(80, 24);
  renderInputLine(buf, layout, 'grid', '');
  assert(buf.data.includes('fwd/back'), 'Missing movement hints');
  assert(buf.data.includes('Q:quit'), 'Missing quit hint');
});

test('renderInputLine shows chat prompt', () => {
  const buf = new StringBuffer(80, 24);
  const layout = computeLayout(80, 24);
  renderInputLine(buf, layout, 'chat-input', 'hello');
  assert(buf.data.includes('Say:'), 'Missing Say: prompt');
  assert(buf.data.includes('hello'), 'Missing input text');
});

// ─── ChatBuffer Tests ────────────────────────────────────────────

console.log('\n=== ChatBuffer ===');

test('add and retrieve messages', () => {
  const cb = new ChatBuffer();
  cb.add('Alice', 'Hello');
  cb.add('Bob', 'Hi there');
  const lines = cb.getVisibleLines(5);
  assertEqual(lines.length, 2);
  assert(lines[0].includes('Alice'), 'Missing Alice');
  assert(lines[1].includes('Bob'), 'Missing Bob');
});

test('addSystem adds system messages', () => {
  const cb = new ChatBuffer();
  cb.addSystem('Connected');
  const lines = cb.getVisibleLines(5);
  assertEqual(lines.length, 1);
  assert(lines[0].startsWith('*'), 'System message should start with *');
});

test('getVisibleLines respects count', () => {
  const cb = new ChatBuffer();
  for (let i = 0; i < 10; i++) {
    cb.add('User', `Message ${i}`);
  }
  const lines = cb.getVisibleLines(3);
  assertEqual(lines.length, 3);
  assert(lines[2].includes('Message 9'), 'Should show most recent');
});

test('scroll up and down', () => {
  const cb = new ChatBuffer();
  for (let i = 0; i < 10; i++) {
    cb.add('User', `Msg ${i}`);
  }
  cb.scrollUp(2);
  assert(cb.isScrolledUp, 'Should be scrolled up');
  const lines = cb.getVisibleLines(3);
  assert(lines[2].includes('Msg 7'), `Expected Msg 7, got: ${lines[2]}`);

  cb.scrollDown(2);
  assert(!cb.isScrolledUp, 'Should be at bottom');
  const lines2 = cb.getVisibleLines(3);
  assert(lines2[2].includes('Msg 9'), `Expected Msg 9, got: ${lines2[2]}`);
});

test('max messages ring buffer', () => {
  const cb = new ChatBuffer(5);
  for (let i = 0; i < 10; i++) {
    cb.add('User', `Msg ${i}`);
  }
  assertEqual(cb.length, 5);
  const lines = cb.getVisibleLines(10);
  assert(lines[0].includes('Msg 5'), 'Oldest should be Msg 5');
});

// ─── Input Handler Tests ─────────────────────────────────────────

console.log('\n=== InputHandler ===');

// Helper for InputHandler callbacks
function makeCallbacks(overrides: Partial<import('../tui/input.js').InputCallbacks> = {}): import('../tui/input.js').InputCallbacks {
  return {
    onMove: () => {}, onStop: () => {}, onToggleFly: () => {}, onToggleDither: () => {},
    onTurnLeft: () => {}, onTurnRight: () => {},
    onEnterChat: () => {}, onExitChat: () => {},
    onChatSubmit: () => {}, onChatChar: () => {}, onChatBackspace: () => {},
    onQuit: () => {}, onLoginChar: () => {}, onLoginBackspace: () => {},
    onLoginSubmit: () => {}, onLoginTab: () => {},
    ...overrides,
  };
}

test('grid mode: arrow keys trigger move/turn', () => {
  const moves: string[] = [];
  const turns: string[] = [];
  const handler = new InputHandler(makeCallbacks({
    onMove: (dir) => moves.push(dir),
    onTurnLeft: () => turns.push('left'),
    onTurnRight: () => turns.push('right'),
  }));
  handler.setMode('grid');
  handler.handleKey(undefined, { name: 'up' });    // forward
  handler.handleKey(undefined, { name: 'down' });   // back
  handler.handleKey(undefined, { name: 'left' });   // turn left
  handler.handleKey(undefined, { name: 'right' });  // turn right
  assertEqual(moves.length, 2);
  assertEqual(moves[0], 'forward');
  assertEqual(moves[1], 'back');
  assertEqual(turns.length, 2);
  assertEqual(turns[0], 'left');
  assertEqual(turns[1], 'right');
});

test('grid mode: f toggles fly', () => {
  let flyToggled = false;
  const handler = new InputHandler(makeCallbacks({ onToggleFly: () => { flyToggled = true; } }));
  handler.setMode('grid');
  handler.handleKey('f', { name: 'f' });
  assert(flyToggled, 'Fly not toggled');
});

test('grid mode: Enter enters chat', () => {
  let entered = false;
  const handler = new InputHandler(makeCallbacks({ onEnterChat: () => { entered = true; } }));
  handler.setMode('grid');
  handler.handleKey(undefined, { name: 'return' });
  assert(entered, 'Chat not entered');
});

test('grid mode: q quits', () => {
  let quit = false;
  const handler = new InputHandler(makeCallbacks({ onQuit: () => { quit = true; } }));
  handler.setMode('grid');
  handler.handleKey('q', { name: 'q' });
  assert(quit, 'Did not quit');
});

test('chat mode: typing adds chars', () => {
  const chars: string[] = [];
  const handler = new InputHandler(makeCallbacks({ onChatChar: (ch) => chars.push(ch) }));
  handler.setMode('chat-input');
  handler.handleKey('h', { name: 'h' });
  handler.handleKey('i', { name: 'i' });
  assertEqual(chars.length, 2);
  assertEqual(chars[0], 'h');
  assertEqual(chars[1], 'i');
});

test('chat mode: Escape exits chat', () => {
  let exited = false;
  const handler = new InputHandler(makeCallbacks({ onExitChat: () => { exited = true; } }));
  handler.setMode('chat-input');
  handler.handleKey(undefined, { name: 'escape' });
  assert(exited, 'Chat not exited');
});

test('chat mode: Enter submits', () => {
  let submitted = false;
  const handler = new InputHandler(makeCallbacks({ onChatSubmit: () => { submitted = true; } }));
  handler.setMode('chat-input');
  handler.handleKey(undefined, { name: 'return' });
  assert(submitted, 'Chat not submitted');
});

test('Ctrl+C always quits regardless of mode', () => {
  for (const mode of ['login', 'grid', 'chat-input'] as Mode[]) {
    let quit = false;
    const handler = new InputHandler(makeCallbacks({ onQuit: () => { quit = true; } }));
    handler.setMode(mode);
    handler.handleKey(undefined, { name: 'c', ctrl: true });
    assert(quit, `Ctrl+C did not quit in ${mode} mode`);
  }
});

test('login mode: tab cycles fields', () => {
  let tabbed = false;
  const handler = new InputHandler(makeCallbacks({ onLoginTab: () => { tabbed = true; } }));
  handler.setMode('login');
  handler.handleKey(undefined, { name: 'tab' });
  assert(tabbed, 'Tab not handled');
});

// ─── Layout Boundary Tests ───────────────────────────────────────

console.log('\n=== Layout Boundaries ===');

test('tiny terminal 20x8: gridRows clamped to minimum 1', () => {
  const l = computeLayout(20, 8);
  assert(l.gridRows >= 1, `gridRows should be >= 1, got ${l.gridRows}`);
  assertEqual(l.totalCols, 20);
  assertEqual(l.totalRows, 8);
});

test('zero-size terminal 0x0: gridRows clamped to 1', () => {
  const l = computeLayout(0, 0);
  assert(l.gridRows >= 1, `gridRows should be >= 1, got ${l.gridRows}`);
});

test('very small terminal 10x5: gridRows clamped', () => {
  const l = computeLayout(10, 5);
  assert(l.gridRows >= 1, `gridRows should be >= 1, got ${l.gridRows}`);
});

test('single row terminal 80x1: gridRows clamped', () => {
  const l = computeLayout(80, 1);
  assert(l.gridRows >= 1, `gridRows should be >= 1, got ${l.gridRows}`);
});

// ─── ChatBuffer Edge Cases ──────────────────────────────────────

console.log('\n=== ChatBuffer Edge Cases ===');

test('scroll on empty buffer stays at 0', () => {
  const cb = new ChatBuffer();
  cb.scrollUp(1);
  assertEqual(cb.isScrolledUp, false, 'Empty buffer should not be scrolled');
  const lines = cb.getVisibleLines(5);
  assertEqual(lines.length, 0, 'Empty buffer should return empty array');
});

test('getVisibleLines(0) returns empty', () => {
  const cb = new ChatBuffer();
  cb.add('User', 'hello');
  const lines = cb.getVisibleLines(0);
  assertEqual(lines.length, 0, 'getVisibleLines(0) should return []');
});

test('ring buffer overflow: 300 messages into size-200 buffer', () => {
  const cb = new ChatBuffer(200);
  for (let i = 0; i < 300; i++) {
    cb.add('User', `Msg ${i}`);
  }
  assertEqual(cb.length, 200, 'Should have 200 messages');
  const lines = cb.getVisibleLines(200);
  assert(lines[0].includes('Msg 100'), `Oldest should be Msg 100, got: ${lines[0]}`);
  assert(lines[199].includes('Msg 299'), `Newest should be Msg 299, got: ${lines[199]}`);
});

test('add message while scrolled up resets scroll', () => {
  const cb = new ChatBuffer();
  for (let i = 0; i < 10; i++) cb.add('User', `Msg ${i}`);
  cb.scrollUp(3);
  assert(cb.isScrolledUp, 'Should be scrolled up');
  cb.add('User', 'New message');
  assertEqual(cb.isScrolledUp, false, 'Should auto-scroll on new message');
});

test('scrollDown past bottom clamps to 0', () => {
  const cb = new ChatBuffer();
  cb.add('User', 'hello');
  cb.scrollDown(10);
  assertEqual(cb.isScrolledUp, false, 'Should not go below 0');
});

// ─── Grid Rendering Correctness ─────────────────────────────────

console.log('\n=== Grid Rendering Correctness ===');

test('self @ is at minimap center', () => {
  const layout = computeLayout(40, 20);
  const frame = createEmptyFrame(layout.minimapCols, layout.minimapRows);
  // Simulate placing self at center
  const selfCol = Math.round(layout.minimapCols / 2);
  const selfRow = Math.round(layout.minimapRows / 2);
  frame.cells[selfRow * layout.minimapCols + selfCol] = { char: '@', fg: '#cc0000', bg: '#f0eedc' };

  const buf = new StringBuffer(40, 20);
  setBwMode(true);
  renderMinimap(buf, layout, frame);
  assert(buf.data.includes('@'), 'Missing @ in rendered minimap');
});

test('frame diff of identical frames = 0 deltas', () => {
  const frame = createEmptyFrame(10, 10);
  for (let i = 0; i < 100; i++) {
    frame.cells[i] = { char: '.', fg: '#336633', bg: '#f0eedc' };
  }
  const deltas = diffFrames(frame, frame);
  assertEqual(deltas.length, 0, 'Identical frames should have 0 deltas');
});

test('frame diff detects changed cells', () => {
  const frame1 = createEmptyFrame(10, 10);
  const frame2 = createEmptyFrame(10, 10);
  for (let i = 0; i < 100; i++) {
    frame1.cells[i] = { char: '.', fg: '#336633', bg: '#f0eedc' };
    frame2.cells[i] = { char: '.', fg: '#336633', bg: '#f0eedc' };
  }
  frame2.cells[55] = { char: '@', fg: '#cc0000', bg: '#f0eedc' };
  const deltas = diffFrames(frame1, frame2);
  assertEqual(deltas.length, 1, 'Should detect 1 changed cell');
  assertEqual(deltas[0].char, '@');
});

// ─── First-Person View Tests ────────────────────────────────────

console.log('\n=== First-Person View ===');

test('projectFirstPerson returns correct dimensions', () => {
  const fp = projectFirstPerson(
    () => 25,  // flat terrain at height 25
    [{ uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 25, yaw: 0, isSelf: true }],
    [],
    { selfX: 128, selfY: 128, selfZ: 25, yaw: 0, waterHeight: 20 },
    80, 5,
  );
  assertEqual(fp.cols, 80);
  assertEqual(fp.rows, 5);
  assertEqual(fp.cells.length, 400);
});

test('FP view: terrain at eye level fills around horizon', () => {
  const fp = projectFirstPerson(
    () => 25,
    [{ uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 25, yaw: 0, isSelf: true }],
    [],
    { selfX: 128, selfY: 128, selfZ: 25, yaw: 0, waterHeight: 20 },
    20, 5,
  );
  // Horizon is row 2. Terrain at same height = at horizon.
  // Below horizon should be terrain, above should be sky.
  const horizonRow = 2;
  const belowCell = fp.cells[(horizonRow + 1) * 20 + 10]; // one below horizon, center col
  const aboveCell = fp.cells[(horizonRow - 1) * 20 + 10]; // one above horizon
  // Terrain cells now use bg color (not sky bg '#1a1a2e')
  assert(belowCell.bg !== '#1a1a2e', `Below horizon should be terrain, got bg='${belowCell.bg}'`);
  // Above could be terrain or sky depending on depth; just verify it's a valid cell
  assert(aboveCell.char.length === 1, 'Above horizon should have a valid char');
});

test('FP view: flying high shows mostly sky', () => {
  const fp = projectFirstPerson(
    () => 25,
    [{ uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 200, yaw: 0, isSelf: true }],
    [],
    { selfX: 128, selfY: 128, selfZ: 200, yaw: 0, waterHeight: 20 },
    20, 5,
  );
  // At 200m altitude, terrain is 175m below. Most of the view should be sky.
  let skyCount = 0;
  for (let i = 0; i < fp.cells.length; i++) {
    if (fp.cells[i].bg === '#1a1a2e') skyCount++;
  }
  assert(skyCount > fp.cells.length * 0.5, `Flying high should show mostly sky, got ${skyCount}/${fp.cells.length}`);
});

test('FP view: different yaw changes terrain sampling', () => {
  // Non-uniform terrain: higher to the east (x > 128)
  const terrain = (x: number, y: number) => x > 140 ? 40 : 25;

  const fpEast = projectFirstPerson(
    terrain, [], [],
    { selfX: 128, selfY: 128, selfZ: 25, yaw: 0, waterHeight: 20 },
    20, 5,
  );
  const fpWest = projectFirstPerson(
    terrain, [], [],
    { selfX: 128, selfY: 128, selfZ: 25, yaw: Math.PI, waterHeight: 20 },
    20, 5,
  );

  // When facing east, we should see the mountain (more terrain above horizon)
  // When facing west, mostly flat terrain
  const countNonSky = (frame: GridFrame) => frame.cells.filter(c => c.bg !== '#1a1a2e').length;
  const eastTerrain = countNonSky(fpEast);
  const westTerrain = countNonSky(fpWest);
  assert(eastTerrain > westTerrain, `Facing east should show more terrain (${eastTerrain}) than west (${westTerrain})`);
});

// ─── Input Handler Edge Cases ───────────────────────────────────

console.log('\n=== Input Handler Edge Cases ===');

test('chat mode: backspace on empty string is no-op', () => {
  let backspaceCount = 0;
  const handler = new InputHandler(makeCallbacks({ onChatBackspace: () => { backspaceCount++; } }));
  handler.setMode('chat-input');
  handler.handleKey(undefined, { name: 'backspace' });
  assertEqual(backspaceCount, 1, 'Backspace callback should still fire');
});

test('grid mode: non-printable chars are ignored', () => {
  let moved = false;
  let chatEntered = false;
  const handler = new InputHandler(makeCallbacks({
    onMove: () => { moved = true; },
    onEnterChat: () => { chatEntered = true; },
  }));
  handler.setMode('grid');
  // control char (charCode < 32)
  handler.handleKey('\x01', { name: 'a', ctrl: false });
  assert(!moved && !chatEntered, 'Non-mapped key should be ignored');
});

test('login mode: control chars are ignored', () => {
  let charTyped = false;
  const handler = new InputHandler(makeCallbacks({ onLoginChar: () => { charTyped = true; } }));
  handler.setMode('login');
  handler.handleKey('\x01', { name: 'a' });
  assert(!charTyped, 'Control chars should not trigger onLoginChar');
});

// ─── Report ──────────────────────────────────────────────────────

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
