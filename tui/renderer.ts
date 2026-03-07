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
const RESET_BG = `${ESC}49m`; // reset bg to default terminal bg

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

// Truecolor mode: use 24-bit RGB escape sequences for full color range
let _truecolor = true;
export function setTruecolor(enabled: boolean): void { _truecolor = enabled; }

const fgTrueCache = new Map<string, string>();
const bgTrueCache = new Map<string, string>();

function fgColor(hex: string): string {
  if (_truecolor) {
    let cached = fgTrueCache.get(hex);
    if (cached) return cached;
    const [r, g, b] = hexToRgb(hex);
    cached = `${ESC}38;2;${r};${g};${b}m`;
    fgTrueCache.set(hex, cached);
    return cached;
  }
  return `${ESC}38;5;${hex256(hex)}m`;
}

function bgColor(hex: string): string {
  if (_truecolor) {
    let cached = bgTrueCache.get(hex);
    if (cached) return cached;
    const [r, g, b] = hexToRgb(hex);
    cached = `${ESC}48;2;${r};${g};${b}m`;
    bgTrueCache.set(hex, cached);
    return cached;
  }
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

// Minimap: opaque dark background for all cells
const MINIMAP_TERRAIN = new Set(['.', ',', '~', ':', ' ']);
const MINIMAP_BG_HEX = '#101018';
const BORDER_COLOR_HEX = '#505050';

export function renderMinimapBuf(
  layout: ScreenLayout,
  frame: GridFrame,
): string {
  let buf = '';
  const mTop = layout.minimapTop;
  const mLeft = layout.minimapLeft;
  const mRows = Math.min(layout.minimapRows, frame.rows);
  const mCols = Math.min(layout.minimapCols, frame.cols);
  const darkBg = bgColor(MINIMAP_BG_HEX);

  for (let row = 0; row < mRows; row++) {
    buf += moveTo(mTop + row, mLeft);
    if (_bwMode) {
      for (let col = 0; col < mCols; col++) {
        const cell = frame.cells[row * frame.cols + col];
        const isBorder = row === 0 || row === mRows - 1 || col === 0 || col === mCols - 1;
        const isContent = !MINIMAP_TERRAIN.has(cell.char);
        buf += isBorder && !isContent ? '·' : cell.char;
      }
    } else {
      buf += darkBg;
      let lastFg = '';
      for (let col = 0; col < mCols; col++) {
        const cell = frame.cells[row * frame.cols + col];
        const isBorder = row === 0 || row === mRows - 1 || col === 0 || col === mCols - 1;
        const isContent = !MINIMAP_TERRAIN.has(cell.char);

        if (isBorder && !isContent) {
          if (lastFg !== BORDER_COLOR_HEX) {
            buf += fgColor(BORDER_COLOR_HEX);
            lastFg = BORDER_COLOR_HEX;
          }
          buf += '·';
        } else {
          if (lastFg !== cell.fg) {
            buf += fgColor(cell.fg);
            lastFg = cell.fg;
          }
          buf += cell.char;
        }
      }
      buf += RESET;
    }
  }
  return buf;
}

// Check if a screen position falls inside the minimap region
export function inMinimap(layout: ScreenLayout, screenRow: number, col: number): boolean {
  return screenRow >= layout.minimapTop &&
    screenRow < layout.minimapTop + layout.minimapRows &&
    col >= layout.minimapLeft &&
    col < layout.minimapLeft + layout.minimapCols;
}

export function renderFpView(
  out: WritableTarget,
  layout: ScreenLayout,
  frame: GridFrame,
): void {
  out.write(renderFpViewBuf(layout, frame));
}

// Render FP view to buffer — full width, skips minimap region to avoid overdraw
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
    // Determine if this row overlaps the minimap
    const inMinimapRow = skipMinimap &&
      screenRow >= layout.minimapTop &&
      screenRow < layout.minimapTop + layout.minimapRows;
    const colLimit = inMinimapRow ? Math.min(renderCols, layout.minimapLeft) : renderCols;

    buf += moveTo(screenRow, 0);
    if (_bwMode) {
      for (let col = 0; col < colLimit && col < frame.cols; col++) {
        buf += frame.cells[row * frame.cols + col].char;
      }
    } else {
      let lastFg = '';
      let lastBg = '';
      for (let col = 0; col < colLimit && col < frame.cols; col++) {
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
): string {
  if (deltas.length === 0) return '';
  let buf = '';
  for (const d of deltas) {
    const row = Math.floor(d.idx / frame.cols);
    const col = d.idx % frame.cols;
    const screenRow = layout.fpTop + row;

    // Skip deltas that fall inside the minimap region
    if (inMinimap(layout, screenRow, col)) continue;

    buf += moveTo(screenRow, col);
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
  mode: 'grid' | 'chat-input' | 'login' | 'menu',
  inputText: string,
): void {
  let content: string;
  if (mode === 'chat-input') {
    content = `Say: ${inputText}\u2588`;
  } else if (mode === 'menu') {
    content = ' / Menu \u2502 Esc:back  letter:select';
  } else if (mode === 'grid') {
    content = ' W/S:fwd/back A/D:strafe \u2190\u2192:turn Space:jump F:fly /:menu Enter:chat Q:quit';
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
