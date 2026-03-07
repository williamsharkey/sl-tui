// renderer.ts — GridFrame -> ANSI escape sequences

import type { GridFrame, CellDelta } from '../server/grid-state.js';
import type { WritableTarget } from './types.js';
import type { ScreenLayout } from './screen.js';

// BW mode: skip all color escapes, just output chars + cursor positioning
let _bwMode = false;
export function setBwMode(enabled: boolean): void { _bwMode = enabled; }
export function isBwMode(): boolean { return _bwMode; }

// ANSI escape helpers
const ESC = '\x1b[';
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const ALT_SCREEN_ON = `${ESC}?1049h`;
const ALT_SCREEN_OFF = `${ESC}?1049l`;
const RESET = `${ESC}0m`;

function moveTo(row: number, col: number): string {
  return `${ESC}${row + 1};${col + 1}H`;
}

function clearScreen(): string {
  return `${ESC}2J`;
}

// Hex color -> ANSI 256 color mapping
// Pre-computed for the ~15 colors in our palette
const hex256Cache = new Map<string, number>();

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbTo256(r: number, g: number, b: number): number {
  // Check grayscale ramp first (232-255)
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round((r - 8) / 247 * 24) + 232;
  }
  // 6x6x6 color cube (16-231)
  const ri = Math.round(r / 255 * 5);
  const gi = Math.round(g / 255 * 5);
  const bi = Math.round(b / 255 * 5);
  return 16 + 36 * ri + 6 * gi + bi;
}

function hex256(hex: string): number {
  let v = hex256Cache.get(hex);
  if (v !== undefined) return v;
  const [r, g, b] = hexToRgb(hex);
  v = rgbTo256(r, g, b);
  hex256Cache.set(hex, v);
  return v;
}

function fgColor(hex: string): string {
  return `${ESC}38;5;${hex256(hex)}m`;
}

function bgColor(hex: string): string {
  return `${ESC}48;5;${hex256(hex)}m`;
}

export function enterAltScreen(out: WritableTarget): void {
  out.write(ALT_SCREEN_ON + HIDE_CURSOR + clearScreen());
}

export function exitAltScreen(out: WritableTarget): void {
  out.write(SHOW_CURSOR + ALT_SCREEN_OFF);
}

export function hideCursor(out: WritableTarget): void {
  out.write(HIDE_CURSOR);
}

export function showCursor(out: WritableTarget): void {
  out.write(SHOW_CURSOR);
}

export function renderStatusBar(
  out: WritableTarget,
  layout: ScreenLayout,
  region: string,
  pos: { x: number; y: number; z: number } | null,
  flying: boolean,
): void {
  out.write(renderStatusBarBuf(layout, region, pos, flying));
}

export function renderStatusBarBuf(
  layout: ScreenLayout,
  region: string,
  pos: { x: number; y: number; z: number } | null,
  flying: boolean,
): string {
  const posStr = pos ? `(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)})` : '(?,?,?)';
  const flyStr = flying ? ' [FLY]' : '';
  const status = ` ${region} ${posStr}${flyStr} `;
  const padded = status.padEnd(layout.totalCols);

  if (_bwMode) {
    return moveTo(layout.statusRow, 0) + padded;
  } else {
    return moveTo(layout.statusRow, 0) + `${ESC}7m` + padded + RESET;
  }
}

export function renderMinimap(
  out: WritableTarget,
  layout: ScreenLayout,
  frame: GridFrame,
): void {
  out.write(renderMinimapBuf(layout, frame));
}

export function renderMinimapBuf(
  layout: ScreenLayout,
  frame: GridFrame,
): string {
  let buf = '';
  for (let row = 0; row < layout.minimapRows && row < frame.rows; row++) {
    buf += moveTo(layout.minimapTop + row, layout.minimapLeft);
    if (_bwMode) {
      for (let col = 0; col < layout.minimapCols && col < frame.cols; col++) {
        buf += frame.cells[row * frame.cols + col].char;
      }
    } else {
      let lastFg = '';
      let lastBg = '';
      for (let col = 0; col < layout.minimapCols && col < frame.cols; col++) {
        const cell = frame.cells[row * frame.cols + col];
        if (cell.fg !== lastFg) {
          buf += fgColor(cell.fg);
          lastFg = cell.fg;
        }
        if (cell.bg !== lastBg) {
          buf += bgColor(cell.bg);
          lastBg = cell.bg;
        }
        buf += cell.char;
      }
      buf += RESET;
    }
  }
  return buf;
}

export function renderFpView(
  out: WritableTarget,
  layout: ScreenLayout,
  frame: GridFrame,
): void {
  out.write(renderFpViewBuf(layout, frame));
}

// Render FP view to buffer, skipping cells that overlap the minimap region
export function renderFpViewBuf(
  layout: ScreenLayout,
  frame: GridFrame,
  skipMinimap = true,
): string {
  if (layout.fpRows <= 0) return '';
  let buf = '';
  const renderCols = layout.fpCols || layout.totalCols;
  for (let row = 0; row < layout.fpRows && row < frame.rows; row++) {
    const screenRow = layout.fpTop + row;
    const inMinimapRowRange = skipMinimap &&
      screenRow >= layout.minimapTop &&
      screenRow < layout.minimapTop + layout.minimapRows;

    buf += moveTo(screenRow, 0);
    if (_bwMode) {
      for (let col = 0; col < renderCols && col < frame.cols; col++) {
        if (inMinimapRowRange && col >= layout.minimapLeft) break;
        buf += frame.cells[row * frame.cols + col].char;
      }
    } else {
      let lastFg = '';
      let lastBg = '';
      for (let col = 0; col < renderCols && col < frame.cols; col++) {
        if (inMinimapRowRange && col >= layout.minimapLeft) break;
        const cell = frame.cells[row * frame.cols + col];
        if (cell.fg !== lastFg) {
          buf += fgColor(cell.fg);
          lastFg = cell.fg;
        }
        if (cell.bg !== lastBg) {
          buf += bgColor(cell.bg);
          lastBg = cell.bg;
        }
        buf += cell.char;
      }
      buf += RESET;
    }
  }
  return buf;
}

// Render only changed FP cells, skipping minimap region
export function renderFpDeltaBuf(
  layout: ScreenLayout,
  deltas: import('../server/grid-state.js').CellDelta[],
  frame: GridFrame,
  skipMinimap = true,
): string {
  if (deltas.length === 0) return '';
  let buf = '';
  for (const d of deltas) {
    const row = Math.floor(d.idx / frame.cols);
    const col = d.idx % frame.cols;
    const screenRow = layout.fpTop + row;
    const screenCol = col;

    // Skip cells in minimap region
    if (skipMinimap &&
        screenRow >= layout.minimapTop &&
        screenRow < layout.minimapTop + layout.minimapRows &&
        screenCol >= layout.minimapLeft) {
      continue;
    }

    buf += moveTo(screenRow, screenCol);
    if (_bwMode) {
      buf += d.char;
    } else {
      buf += fgColor(d.fg) + (d.bg ? bgColor(d.bg) : '') + d.char + RESET;
    }
  }
  return buf;
}

export function renderSeparator(out: WritableTarget, layout: ScreenLayout): void {
  if (_bwMode) {
    out.write(moveTo(layout.separatorRow, 0) + '-'.repeat(layout.totalCols));
  } else {
    out.write(
      moveTo(layout.separatorRow, 0) +
      fgColor('#666666') +
      '\u2500'.repeat(layout.totalCols) +
      RESET
    );
  }
}

export function renderChatLines(
  out: WritableTarget,
  layout: ScreenLayout,
  lines: string[],
): void {
  let buf = '';
  for (let i = 0; i < layout.chatLines; i++) {
    buf += moveTo(layout.chatTop + i, 0);
    const line = lines[i] || '';
    buf += line.slice(0, layout.totalCols).padEnd(layout.totalCols);
  }
  out.write(buf);
}

export function renderInputLine(
  out: WritableTarget,
  layout: ScreenLayout,
  mode: 'grid' | 'chat-input' | 'login',
  inputText: string,
): void {
  let content: string;
  if (mode === 'chat-input') {
    content = `Say: ${inputText}\u2588`;
  } else if (mode === 'grid') {
    content = ' W/S:fwd/back A/D:strafe \u2190\u2192:turn Space:jump F:fly Enter:chat Q:quit';
  } else {
    content = '';
  }
  if (_bwMode) {
    out.write(moveTo(layout.inputRow, 0) + content.slice(0, layout.totalCols).padEnd(layout.totalCols));
  } else {
    out.write(
      moveTo(layout.inputRow, 0) +
      `${ESC}7m` + // reverse video
      content.slice(0, layout.totalCols).padEnd(layout.totalCols) +
      RESET
    );
  }
}

// For testing: extract the color conversion functions
export { hex256, hexToRgb, rgbTo256, fgColor, bgColor, moveTo, clearScreen };
