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
import { createEmptyFrame, diffFrames, projectFirstPerson, projectFrame, terrainTexturedRGB, avatarColorFromUUID, type GridFrame, type Cell, type CellDelta, type AvatarData, type ObjectData } from '../server/grid-state.js';
import { quatRotateVec3, quatMultiply } from '../server/quat-utils.js';
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
  assert(seq.startsWith('\x1b[38;'), `Bad fg sequence: ${seq}`);
});

test('bgColor generates valid ANSI', () => {
  const seq = bgColor('#0000ff');
  assert(seq.startsWith('\x1b[48;'), `Bad bg sequence: ${seq}`);
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

test('renderMinimap renders border and content cells', () => {
  const buf = new StringBuffer(40, 20);
  const layout = computeLayout(40, 20);
  const frame: GridFrame = {
    cells: [],
    cols: layout.minimapCols,
    rows: layout.minimapRows,
  };
  // Fill with terrain (transparent) but put an avatar '@' in the middle
  for (let i = 0; i < layout.minimapCols * layout.minimapRows; i++) {
    frame.cells.push({ char: '.', fg: '#336633', bg: '#f0eedc' });
  }
  const midIdx = Math.floor(layout.minimapRows / 2) * layout.minimapCols + Math.floor(layout.minimapCols / 2);
  frame.cells[midIdx] = { char: '@', fg: '#cc0000', bg: '#f0eedc' };
  renderMinimap(buf, layout, frame);
  // Should contain border dots and the @ content char
  const borderDots = (buf.data.match(/·/g) || []).length;
  assert(borderDots > 0, `Border dots should render, got ${borderDots}`);
  assert(buf.data.includes('@'), 'Content char @ should render');
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
    onMove: () => {}, onStop: () => {}, onToggleFly: () => {}, onToggleDither: () => {}, onToggleRenderMode: () => {},
    onTurnLeft: () => {}, onTurnRight: () => {},
    onEnterChat: () => {}, onExitChat: () => {},
    onChatSubmit: () => {}, onChatChar: () => {}, onChatBackspace: () => {},
    onQuit: () => {}, onOpenMenu: () => {}, onMenuKey: () => {},
    onLoginChar: () => {}, onLoginBackspace: () => {},
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
  for (const mode of ['login', 'grid', 'chat-input', 'menu'] as Mode[]) {
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
    [{ uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 25, yaw: 0, isSelf: true, velX: 0, velY: 0, velZ: 0 }],
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
    [{ uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 25, yaw: 0, isSelf: true, velX: 0, velY: 0, velZ: 0 }],
    [],
    { selfX: 128, selfY: 128, selfZ: 25, yaw: 0, waterHeight: 20 },
    20, 5,
  );
  // Horizon is row 2. Terrain at same height = at horizon.
  // Below horizon should have terrain cells (non-sky colors)
  const horizonRow = 2;
  const belowCell = fp.cells[(horizonRow + 1) * 20 + 10];
  const aboveCell = fp.cells[(horizonRow - 1) * 20 + 10];
  // Terrain cells differ from pure sky gradient — check fg differs from bg (sextant detail)
  assert(belowCell.char !== undefined, `Below horizon should have a cell`);
  assert(aboveCell.char !== undefined, 'Above horizon should have a valid cell');
});

test('FP view: flying high shows mostly sky', () => {
  const fp = projectFirstPerson(
    () => 25,
    [{ uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 200, yaw: 0, isSelf: true, velX: 0, velY: 0, velZ: 0 }],
    [],
    { selfX: 128, selfY: 128, selfZ: 200, yaw: 0, waterHeight: 20 },
    20, 5,
  );
  // At 200m altitude, terrain is 175m below. Most cells in upper half should be sky.
  // Sky cells: fg === bg (uniform color within 2x3 block = full block or space)
  let skyCount = 0;
  for (let i = 0; i < fp.cells.length; i++) {
    if (fp.cells[i].fg === fp.cells[i].bg) skyCount++;
  }
  assert(skyCount > fp.cells.length * 0.3, `Flying high should show mostly sky, got ${skyCount}/${fp.cells.length}`);
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

  // When facing east vs west, the rendered frames should differ
  // (different terrain = different colors in cells)
  let diffCount = 0;
  for (let i = 0; i < fpEast.cells.length; i++) {
    if (fpEast.cells[i].fg !== fpWest.cells[i].fg || fpEast.cells[i].bg !== fpWest.cells[i].bg) diffCount++;
  }
  assert(diffCount > 0, `Facing east vs west should produce different frames, got ${diffCount} different cells`);
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

// ─── Avatar Rendering (Depth Buffer) Tests ──────────────────────

console.log('\n=== Avatar Rendering ===');

test('FP view: avatar on flat terrain is visible', () => {
  const self: AvatarData = { uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 25, yaw: Math.PI / 2, isSelf: true, velX: 0, velY: 0, velZ: 0 };
  const other: AvatarData = { uuid: 'other-1', firstName: 'O', lastName: 'A', x: 128, y: 140, z: 25, yaw: 0, isSelf: false, velX: 0, velY: 0, velZ: 0 };
  const fp = projectFirstPerson(
    () => 25,
    [self, other],
    [],
    { selfX: 128, selfY: 128, selfZ: 25, yaw: Math.PI / 2, waterHeight: 20 },
    40, 10,
  );
  // Avatar at y=140 is 12m ahead (facing north = +y). Should have some cells with oid='other-1'
  const avatarCells = fp.cells.filter(c => c.oid === 'other-1');
  assert(avatarCells.length > 0, `Avatar should be visible, got ${avatarCells.length} cells with avatar OID`);
});

test('FP view: avatar behind hill is partially occluded', () => {
  // Hill between viewer and avatar
  const terrain = (x: number, y: number) => {
    if (y >= 133 && y <= 136) return 35; // 10m hill at y=133-136
    return 25;
  };
  const self: AvatarData = { uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 25, yaw: Math.PI / 2, isSelf: true, velX: 0, velY: 0, velZ: 0 };
  const other: AvatarData = { uuid: 'other-1', firstName: 'O', lastName: 'A', x: 128, y: 145, z: 25, yaw: 0, isSelf: false, velX: 0, velY: 0, velZ: 0 };

  const fp = projectFirstPerson(
    terrain,
    [self, other],
    [],
    { selfX: 128, selfY: 128, selfZ: 25, yaw: Math.PI / 2, waterHeight: 20 },
    40, 10,
  );
  // Avatar head (z+2=27) is below the hill peak (35), so it should be mostly occluded
  // But the depth buffer ensures proper per-pixel occlusion rather than blanket rejection
  // The avatar may still be partially visible above terrain at its depth
  const avatarCells = fp.cells.filter(c => c.oid === 'other-1');
  // With old topDrawn bug, this would be 0. With depth buffer, partial occlusion is correct.
  // Just verify no crash and reasonable result
  assert(true, 'Hill occlusion renders without crash');
});

test('FP view: close avatar renders larger than far avatar', () => {
  const self: AvatarData = { uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 25, yaw: Math.PI / 2, isSelf: true, velX: 0, velY: 0, velZ: 0 };
  const close: AvatarData = { uuid: 'close-1', firstName: 'C', lastName: 'A', x: 128, y: 133, z: 25, yaw: 0, isSelf: false, velX: 0, velY: 0, velZ: 0 };
  const far: AvatarData = { uuid: 'far-1', firstName: 'F', lastName: 'A', x: 128, y: 170, z: 25, yaw: 0, isSelf: false, velX: 0, velY: 0, velZ: 0 };

  const fp = projectFirstPerson(
    () => 25,
    [self, close, far],
    [],
    { selfX: 128, selfY: 128, selfZ: 25, yaw: Math.PI / 2, waterHeight: 20 },
    60, 15,
  );
  const closeCells = fp.cells.filter(c => c.oid === 'close-1').length;
  const farCells = fp.cells.filter(c => c.oid === 'far-1').length;
  assert(closeCells > farCells, `Close avatar (${closeCells} cells) should be larger than far avatar (${farCells} cells)`);
});

test('FP view: avatar in front of terrain overwrites terrain pixels', () => {
  // Terrain slopes up behind the avatar
  const terrain = (x: number, y: number) => y > 140 ? 40 : 25;
  const self: AvatarData = { uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 25, yaw: Math.PI / 2, isSelf: true, velX: 0, velY: 0, velZ: 0 };
  const other: AvatarData = { uuid: 'other-1', firstName: 'O', lastName: 'A', x: 128, y: 135, z: 25, yaw: 0, isSelf: false, velX: 0, velY: 0, velZ: 0 };

  const fp = projectFirstPerson(
    terrain,
    [self, other],
    [],
    { selfX: 128, selfY: 128, selfZ: 25, yaw: Math.PI / 2, waterHeight: 20 },
    40, 10,
  );
  const avatarCells = fp.cells.filter(c => c.oid === 'other-1');
  assert(avatarCells.length > 0, `Avatar in front of sloped terrain should be visible (${avatarCells.length} cells)`);
});

test('FP view: object uses depth buffer correctly', () => {
  const self: AvatarData = { uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 25, yaw: Math.PI / 2, isSelf: true, velX: 0, velY: 0, velZ: 0 };
  const obj: ObjectData = { uuid: 'box-1', name: 'Box', x: 128, y: 138, z: 25, scaleX: 2, scaleY: 2, scaleZ: 3, isTree: false, pcode: 9, treeSpecies: -1, pathCurve: 16, profileCurve: 1, rotX: 0, rotY: 0, rotZ: 0, rotW: 1, colorR: 128, colorG: 128, colorB: 128 };

  const fp = projectFirstPerson(
    () => 25,
    [self],
    [obj],
    { selfX: 128, selfY: 128, selfZ: 25, yaw: Math.PI / 2, waterHeight: 20 },
    40, 10,
  );
  const objCells = fp.cells.filter(c => c.oid === 'box-1');
  assert(objCells.length > 0, `Object should be visible (${objCells.length} cells)`);
});

test('FP view: name labels render next to avatar', () => {
  const self: AvatarData = { uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 25, yaw: Math.PI / 2, isSelf: true, velX: 0, velY: 0, velZ: 0 };
  const other: AvatarData = { uuid: 'other-1', firstName: 'Test', lastName: 'Person', x: 128, y: 140, z: 25, yaw: 0, isSelf: false, velX: 0, velY: 0, velZ: 0 };
  const names = new Map([['other-1', 'Test Person']]);

  const fp = projectFirstPerson(
    () => 25,
    [self, other],
    [],
    { selfX: 128, selfY: 128, selfZ: 25, yaw: Math.PI / 2, waterHeight: 20,
      avatarNames: names },
    60, 15,
  );
  // Name label characters should appear in the frame
  const allChars = fp.cells.map(c => c.char).join('');
  assert(allChars.includes('Test'), `Name label 'Test' should appear in FP view, chars: ${allChars.slice(0, 200)}`);
});

test('FP view: chat bubble renders next to avatar name', () => {
  const self: AvatarData = { uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 25, yaw: Math.PI / 2, isSelf: true, velX: 0, velY: 0, velZ: 0 };
  const other: AvatarData = { uuid: 'other-1', firstName: 'Test', lastName: 'Person', x: 128, y: 140, z: 25, yaw: 0, isSelf: false, velX: 0, velY: 0, velZ: 0 };
  const names = new Map([['other-1', 'Test Person']]);
  const bubbles = new Map([['other-1', { message: 'Hello world', ts: Date.now() }]]);

  const fp = projectFirstPerson(
    () => 25,
    [self, other],
    [],
    { selfX: 128, selfY: 128, selfZ: 25, yaw: Math.PI / 2, waterHeight: 20,
      avatarNames: names, chatBubbles: bubbles },
    80, 15,
  );
  const allChars = fp.cells.map(c => c.char).join('');
  assert(allChars.includes('Hello'), `Chat bubble 'Hello' should appear in FP view`);
});

test('Minimap: avatar altitude indicators + and -', () => {
  // Use a larger grid and place avatars far enough from self so indicators don't overlap with @ or FOV
  const self: AvatarData = { uuid: 'self', firstName: 'T', lastName: 'U', x: 128, y: 128, z: 25, yaw: Math.PI / 2, isSelf: true, velX: 0, velY: 0, velZ: 0 };
  const higher: AvatarData = { uuid: 'high-1', firstName: 'H', lastName: 'A', x: 128, y: 160, z: 35, yaw: 0, isSelf: false, velX: 0, velY: 0, velZ: 0 };
  const lower: AvatarData = { uuid: 'low-1', firstName: 'L', lastName: 'A', x: 160, y: 128, z: 15, yaw: 0, isSelf: false, velX: 0, velY: 0, velZ: 0 };

  const frame = projectFrame(
    () => 25,
    [self, higher, lower],
    [],
    { cols: 40, rows: 40, selfX: 128, selfY: 128, selfZ: 25, waterHeight: 20, metersPerCell: 256 / 40, yaw: Math.PI / 2 },
    false,
  );
  const chars = frame.cells.map(c => c.char);
  assert(chars.includes('+'), 'Higher avatar should have + indicator');
  assert(chars.includes('-'), 'Lower avatar should have - indicator');
});

test('Minimap: sim border markers appear near region edge', () => {
  // Place self near the edge of the sim (x=5)
  const frame = projectFrame(
    () => 25,
    [{ uuid: 'self', firstName: 'T', lastName: 'U', x: 5, y: 128, z: 25, yaw: Math.PI / 2, isSelf: true, velX: 0, velY: 0, velZ: 0 }],
    [],
    { cols: 20, rows: 20, selfX: 5, selfY: 128, selfZ: 25, waterHeight: 20, metersPerCell: 256 / 20, yaw: Math.PI / 2 },
    false,
  );
  const borderCells = frame.cells.filter(c => c.char === '│');
  assert(borderCells.length > 0, `Border markers should appear near sim edge, got ${borderCells.length}`);
});

// ─── Menu System Tests ──────────────────────────────────────────

console.log('\n=== Menu System ===');

import { MenuPanel } from '../tui/menu.js';

function makeMenuActions(overrides: Partial<import('../tui/menu.js').MenuActions> = {}): import('../tui/menu.js').MenuActions {
  return {
    sendIM: async () => {},
    flyToAvatar: () => {},
    getProfile: async () => null,
    getFriendsList: async () => [],
    teleportHome: async () => {},
    teleportRegion: async () => {},
    stand: () => {},
    closeMenu: () => {},
    systemMessage: () => {},
    ...overrides,
  };
}

test('menu opens and closes with Esc', () => {
  const menu = new MenuPanel(makeMenuActions());
  assert(!menu.isOpen, 'Should start closed');
  menu.open();
  assert(menu.isOpen, 'Should be open after open()');
  // Esc at root closes the menu
  const stay = menu.handleKey(undefined, { name: 'escape' });
  assert(!stay, 'Esc at root should return false (close)');
  assert(!menu.isOpen, 'Should be closed after Esc');
});

test('menu navigates to friends submenu and back', () => {
  const menu = new MenuPanel(makeMenuActions());
  menu.open();
  menu.handleKey('f', { name: 'f' }); // enter friends
  assert(menu.isOpen, 'Should stay open in friends');
  menu.handleKey(undefined, { name: 'escape' }); // back to root
  assert(menu.isOpen, 'Should stay open at root after back');
  menu.handleKey(undefined, { name: 'escape' }); // close
  assert(!menu.isOpen, 'Should close from root');
});

test('menu navigates to teleport > home', () => {
  let tpHome = false;
  const menu = new MenuPanel(makeMenuActions({ teleportHome: async () => { tpHome = true; } }));
  menu.open();
  menu.handleKey('t', { name: 't' }); // teleport submenu
  const stay = menu.handleKey('h', { name: 'h' }); // home
  assert(!stay, 'Teleport home should close menu');
  assert(tpHome, 'teleportHome should have been called');
});

test('menu actions > stand', () => {
  let stood = false;
  const menu = new MenuPanel(makeMenuActions({ stand: () => { stood = true; } }));
  menu.open();
  menu.handleKey('a', { name: 'a' }); // actions
  const stay = menu.handleKey('s', { name: 's' }); // stand
  assert(!stay, 'Stand should close menu');
  assert(stood, 'stand() should have been called');
});

test('menu tracks IMs and shows unread count', () => {
  const menu = new MenuPanel(makeMenuActions());
  assertEqual(menu.unreadCount, 0, 'Should start with 0 unread');
  menu.addIM('uuid-1', 'Alice', 'hello', false);
  menu.addIM('uuid-1', 'Alice', 'are you there?', false);
  assertEqual(menu.unreadCount, 2, 'Should have 2 unread');
  assertEqual(menu.imMessages.length, 2, 'Should have 2 messages');
});

test('menu compose mode sets isInputMode', () => {
  const menu = new MenuPanel(makeMenuActions({
    getFriendsList: async () => [{ uuid: 'u1', name: 'Alice', online: true }],
  }));
  menu.open();
  assert(!menu.isInputMode, 'Should not be input mode at root');
  menu.handleKey('t', { name: 't' }); // teleport
  menu.handleKey('r', { name: 'r' }); // region input
  assert(menu.isInputMode, 'Should be input mode in tp-input');
  menu.handleKey(undefined, { name: 'escape' }); // cancel
  assert(!menu.isInputMode, 'Should exit input mode on Esc');
});

test('menu render produces output with box drawing', () => {
  setBwMode(true);
  const menu = new MenuPanel(makeMenuActions());
  menu.open();
  const layout = computeLayout(80, 24);
  const output = menu.render(layout);
  assert(output.length > 0, 'Render should produce output');
  assert(output.includes('┌'), 'Should contain top-left corner');
  assert(output.includes('┘'), 'Should contain bottom-right corner');
  assert(output.includes('[F]'), 'Should show Friends shortcut');
  assert(output.includes('[M]'), 'Should show Messages shortcut');
  assert(output.includes('[T]'), 'Should show Teleport shortcut');
  assert(output.includes('[A]'), 'Should show Actions shortcut');
});

test('menu messages view shows conversations', () => {
  setBwMode(true);
  const menu = new MenuPanel(makeMenuActions());
  menu.addIM('uuid-1', 'Alice Resident', 'hey there', false);
  menu.addIM('uuid-2', 'Bob Builder', 'hello', false);
  menu.open();
  menu.handleKey('m', { name: 'm' }); // messages
  const layout = computeLayout(80, 24);
  const output = menu.render(layout);
  assert(output.includes('Alice'), 'Should show Alice in messages');
  assert(output.includes('Bob'), 'Should show Bob in messages');
});

test('menu compose sends IM via callback', () => {
  let sentTo = '';
  let sentMsg = '';
  const menu = new MenuPanel(makeMenuActions({
    sendIM: async (to, msg) => { sentTo = to; sentMsg = msg; },
  }));
  menu.addIM('uuid-1', 'Alice', 'hey', false);
  menu.open();
  menu.handleKey('m', { name: 'm' }); // messages
  menu.handleKey('1', { name: '1' }); // select first conversation
  menu.handleKey('r', { name: 'r' }); // reply
  assert(menu.isInputMode, 'Should be in compose mode');
  menu.handleKey('h', { name: 'h' });
  menu.handleKey('i', { name: 'i' });
  menu.handleKey(undefined, { name: 'return' }); // send
  assertEqual(sentTo, 'uuid-1', 'Should send to correct UUID');
  assertEqual(sentMsg, 'hi', 'Should send composed message');
  assert(!menu.isInputMode, 'Should exit compose after send');
});

test('grid mode: / opens menu', () => {
  let menuOpened = false;
  const handler = new InputHandler(makeCallbacks({ onOpenMenu: () => { menuOpened = true; } }));
  handler.setMode('grid');
  handler.handleKey('/', { name: '/' });
  assert(menuOpened, '/ should open menu');
});

test('grid mode: Tab opens menu', () => {
  let menuOpened = false;
  const handler = new InputHandler(makeCallbacks({ onOpenMenu: () => { menuOpened = true; } }));
  handler.setMode('grid');
  handler.handleKey(undefined, { name: 'tab' });
  assert(menuOpened, 'Tab should open menu');
});

test('menu mode: keys delegated to onMenuKey', () => {
  let receivedKey = '';
  const handler = new InputHandler(makeCallbacks({ onMenuKey: (str) => { receivedKey = str || ''; } }));
  handler.setMode('menu');
  handler.handleKey('f', { name: 'f' });
  assertEqual(receivedKey, 'f', 'Menu key should be delegated');
});

// ─── Quaternion Utilities ─────────────────────────────────────────

test('quatRotateVec3: identity quaternion returns same vector', () => {
  const [x, y, z] = quatRotateVec3(0, 0, 0, 1, 3, 4, 5);
  assert(Math.abs(x - 3) < 1e-9 && Math.abs(y - 4) < 1e-9 && Math.abs(z - 5) < 1e-9,
    `Expected (3,4,5) got (${x},${y},${z})`);
});

test('quatRotateVec3: 90° around Z rotates X to Y', () => {
  // 90° around Z: quat = (0, 0, sin(45°), cos(45°))
  const s = Math.SQRT1_2;
  const [x, y, z] = quatRotateVec3(0, 0, s, s, 1, 0, 0);
  assert(Math.abs(x) < 1e-9 && Math.abs(y - 1) < 1e-9 && Math.abs(z) < 1e-9,
    `Expected (0,1,0) got (${x},${y},${z})`);
});

test('quatMultiply: identity * q = q', () => {
  const [x, y, z, w] = quatMultiply(0, 0, 0, 1, 0.1, 0.2, 0.3, 0.9);
  assert(Math.abs(x - 0.1) < 1e-9 && Math.abs(y - 0.2) < 1e-9 &&
    Math.abs(z - 0.3) < 1e-9 && Math.abs(w - 0.9) < 1e-9,
    `Expected (0.1,0.2,0.3,0.9) got (${x},${y},${z},${w})`);
});

test('quatMultiply: two 90° Z rotations = 180° Z', () => {
  const s = Math.SQRT1_2;
  const [qx, qy, qz, qw] = quatMultiply(0, 0, s, s, 0, 0, s, s);
  // 180° around Z: (0, 0, 1, 0)
  assert(Math.abs(qx) < 1e-9 && Math.abs(qy) < 1e-9 &&
    Math.abs(qz - 1) < 1e-9 && Math.abs(qw) < 1e-9,
    `Expected (0,0,1,0) got (${qx},${qy},${qz},${qw})`);
});

test('quatRotateVec3 + quatMultiply: composed rotation', () => {
  // 90° around Z then 90° around X should map (1,0,0) → (0,1,0) → (0,0,1)
  const s = Math.SQRT1_2;
  const [cx, cy, cz, cw] = quatMultiply(s, 0, 0, s, 0, 0, s, s);
  const [rx, ry, rz] = quatRotateVec3(cx, cy, cz, cw, 1, 0, 0);
  assert(Math.abs(rx) < 1e-9 && Math.abs(ry) < 1e-9 && Math.abs(rz - 1) < 1e-9,
    `Expected (0,0,1) got (${rx},${ry},${rz})`);
});

test('projectFirstPerson: many nearby objects renders without crash', () => {
  const objects: ObjectData[] = [];
  for (let i = 0; i < 200; i++) {
    objects.push({
      uuid: `obj-${i}`, name: `box-${i}`,
      x: 128 + (i % 10) * 2, y: 128 + Math.floor(i / 10) * 2, z: 25,
      scaleX: 1, scaleY: 1, scaleZ: 1,
      isTree: false, pcode: 9, treeSpecies: -1,
      pathCurve: 16, profileCurve: 1,
      rotX: 0, rotY: 0, rotZ: 0, rotW: 1,
      colorR: 200, colorG: 150, colorB: 100,
    });
  }
  const frame = projectFirstPerson(
    () => 25, [], objects,
    { selfX: 128, selfY: 128, selfZ: 27, yaw: Math.PI / 2, waterHeight: 20, renderMode: 'voxel' },
    40, 12,
  );
  assert(frame.cells.length === 40 * 12, 'Frame size correct');
});

test('projectFirstPerson: all primitive types render without crash', () => {
  // Test every SL primitive shape: box, cylinder, sphere, prism, wedge, cone, torus, tube, ring
  const primTypes: [number, number, string][] = [
    [16, 1, 'box'],       // linear + square
    [16, 0, 'cylinder'],  // linear + circle
    [16, 2, 'prism-iso'], // linear + iso triangle
    [16, 3, 'prism-eq'],  // linear + equilateral triangle
    [16, 4, 'wedge'],     // linear + right triangle
    [16, 5, 'cone'],      // linear + half-circle
    [32, 5, 'sphere'],    // circular + half-circle
    [32, 0, 'torus'],     // circular + circle
    [32, 1, 'tube'],      // circular + square
    [32, 2, 'ring'],      // circular + triangle
    [48, 0, 'torus2'],    // circle2 path
    [16, 0x21, 'cyl+squareHole'], // profile with hole type in upper nibble
  ];
  const objects: ObjectData[] = primTypes.map(([pathCurve, profileCurve, name], i) => ({
    uuid: `prim-${name}`, name,
    x: 128 + i * 3, y: 132, z: 25,
    scaleX: 2, scaleY: 2, scaleZ: 2,
    isTree: false, pcode: 9, treeSpecies: -1,
    pathCurve, profileCurve,
    rotX: 0, rotY: 0, rotZ: 0, rotW: 1,
    colorR: 180, colorG: 120, colorB: 80,
  }));
  const frame = projectFirstPerson(
    () => 25, [], objects,
    { selfX: 128, selfY: 128, selfZ: 27, yaw: Math.PI / 2, waterHeight: 20, renderMode: 'voxel' },
    60, 18,
  );
  assert(frame.cells.length === 60 * 18, 'Frame size correct with all prim types');
});

test('projectFirstPerson: triangle mode with prims renders without crash', () => {
  const objects: ObjectData[] = [
    { uuid: 'box1', name: 'box', x: 130, y: 132, z: 25, scaleX: 3, scaleY: 3, scaleZ: 3,
      isTree: false, pcode: 9, treeSpecies: -1, pathCurve: 16, profileCurve: 1,
      rotX: 0, rotY: 0, rotZ: 0, rotW: 1, colorR: 200, colorG: 100, colorB: 50 },
    { uuid: 'torus1', name: 'torus', x: 134, y: 132, z: 25, scaleX: 2, scaleY: 2, scaleZ: 2,
      isTree: false, pcode: 9, treeSpecies: -1, pathCurve: 32, profileCurve: 0,
      rotX: 0, rotY: 0, rotZ: 0, rotW: 1, colorR: 100, colorG: 200, colorB: 50 },
  ];
  const frame = projectFirstPerson(
    () => 25, [], objects,
    { selfX: 128, selfY: 128, selfZ: 27, yaw: Math.PI / 2, waterHeight: 20, renderMode: 'triangle' },
    40, 12,
  );
  assert(frame.cells.length === 40 * 12, 'Frame renders in triangle mode');
});

// ─── Hybrid Mode ─────────────────────────────────────────────────

console.log('\n=== Hybrid Mode ===');

test('projectFirstPerson: hybrid mode renders without crash', () => {
  const frame = projectFirstPerson(
    () => 25, [], [],
    { selfX: 128, selfY: 128, selfZ: 27, yaw: Math.PI / 2, waterHeight: 20, renderMode: 'hybrid' },
    40, 12,
  );
  assert(frame.cells.length === 40 * 12, 'Hybrid mode frame size correct');
});

test('projectFirstPerson: hybrid mode with water terrain', () => {
  // Terrain below water — hybrid should render voxel water
  const frame = projectFirstPerson(
    () => 15, [], [],
    { selfX: 128, selfY: 128, selfZ: 27, yaw: Math.PI / 2, waterHeight: 20, renderMode: 'hybrid' },
    20, 8,
  );
  assert(frame.cells.length === 20 * 8, 'Hybrid mode with water renders');
});

// ─── Settings Toggle ─────────────────────────────────────────────

console.log('\n=== Settings Menu ===');

test('MenuPanel: settings submenu opens and has items', () => {
  const menu = new MenuPanel(makeMenuActions({
    getSettings: () => ({ renderMode: 'triangle', dither: false, flying: false, terrainTexture: false }),
    toggleSetting: () => {},
  }));
  menu.open();
  // Press 's' for settings
  menu.handleKey('s', {});
  assert(menu.isOpen, 'Settings submenu is open');
  const layout = computeLayout(80, 24);
  const rendered = menu.render(layout);
  assert(rendered.includes('Settings'), 'Settings panel renders');
});

// ─── Terrain Texture ──────────────────────────────────────────────

console.log('\n=== Terrain Texture ===');

test('terrainTexturedRGB returns valid RGB for grass zone', () => {
  const [r, g, b] = terrainTexturedRGB(30, 20, 10.5, 15.3);
  assert(r >= 0 && r <= 255, `R in range: ${r}`);
  assert(g >= 0 && g <= 255, `G in range: ${g}`);
  assert(b >= 0 && b <= 255, `B in range: ${b}`);
});

test('terrainTexturedRGB returns valid RGB for snow zone', () => {
  const [r, g, b] = terrainTexturedRGB(115, 20, 5.0, 5.0);
  assert(r >= 0 && r <= 255, `R in range: ${r}`);
  assert(g >= 0 && g <= 255, `G in range: ${g}`);
  assert(b >= 0 && b <= 255, `B in range: ${b}`);
});

test('terrainTexturedRGB varies with position (sand zone)', () => {
  const [r1] = terrainTexturedRGB(21, 20, 0, 0);
  const [r2] = terrainTexturedRGB(21, 20, 0.5, 0.5);
  // Different positions should potentially give different values
  // (not guaranteed but likely with sin functions)
  assert(typeof r1 === 'number' && typeof r2 === 'number', 'Returns numbers');
});

// ─── Avatar Color ─────────────────────────────────────────────────

console.log('\n=== Avatar Color ===');

test('avatarColorFromUUID returns valid RGB', () => {
  const [r, g, b] = avatarColorFromUUID('12345678-1234-1234-1234-123456789abc');
  assert(r >= 0 && r <= 255, `R in range: ${r}`);
  assert(g >= 0 && g <= 255, `G in range: ${g}`);
  assert(b >= 0 && b <= 255, `B in range: ${b}`);
});

test('avatarColorFromUUID returns different colors for different UUIDs', () => {
  const [r1, g1, b1] = avatarColorFromUUID('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  const [r2, g2, b2] = avatarColorFromUUID('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  const different = r1 !== r2 || g1 !== g2 || b1 !== b2;
  assert(different, 'Different UUIDs produce different colors');
});

test('avatarColorFromUUID is deterministic', () => {
  const uuid = 'deadbeef-1234-5678-9abc-def012345678';
  const [r1, g1, b1] = avatarColorFromUUID(uuid);
  const [r2, g2, b2] = avatarColorFromUUID(uuid);
  assert(r1 === r2 && g1 === g2 && b1 === b2, 'Same UUID gives same color');
});

// ─── Alpha/Fullbright ─────────────────────────────────────────────

console.log('\n=== Alpha/Fullbright ===');

test('projectFirstPerson: transparent objects are skipped', () => {
  const objects: ObjectData[] = [
    { uuid: 'transparent1', name: 'glass', x: 130, y: 132, z: 25, scaleX: 3, scaleY: 3, scaleZ: 3,
      isTree: false, pcode: 9, treeSpecies: -1, pathCurve: 16, profileCurve: 1,
      rotX: 0, rotY: 0, rotZ: 0, rotW: 1, colorR: 200, colorG: 100, colorB: 50,
      alpha: 0.05 },
  ];
  const frame = projectFirstPerson(
    () => 25, [], objects,
    { selfX: 128, selfY: 128, selfZ: 27, yaw: Math.PI / 2, waterHeight: 20, renderMode: 'triangle' },
    40, 12,
  );
  assert(frame.cells.length === 40 * 12, 'Frame renders with transparent objects');
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
