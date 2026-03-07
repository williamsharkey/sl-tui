// pixel-to-cells.ts — Convert RGBA pixel buffer to Cell[] using Unicode quadrant block characters
//
// Each 2x2 pixel group maps to one terminal cell, doubling effective resolution.
// Picks fg/bg colors from the two most distant colors in the group, then selects
// the quadrant character that best represents which pixels are fg vs bg.

import type { Cell } from './grid-state.js';

// Unicode quadrant block characters indexed by 4-bit pattern.
// Bit 0 = top-left, bit 1 = top-right, bit 2 = bottom-left, bit 3 = bottom-right.
// A set bit means that quadrant uses the foreground color.
const QUADRANT_CHARS: string[] = [
  ' ',   // 0b0000 — all bg
  '\u2598', // 0b0001 — ▘ top-left
  '\u259D', // 0b0010 — ▝ top-right
  '\u2580', // 0b0011 — ▀ top half
  '\u2596', // 0b0100 — ▖ bottom-left
  '\u258C', // 0b0101 — ▌ left half
  '\u259E', // 0b0110 — ▞ diagonal
  '\u259B', // 0b0111 — ▛ three-quarter top-left
  '\u2597', // 0b1000 — ▗ bottom-right
  '\u259A', // 0b1001 — ▚ diagonal (other)
  '\u2590', // 0b1010 — ▐ right half
  '\u259C', // 0b1011 — ▜ three-quarter top-right
  '\u2584', // 0b1100 — ▄ bottom half
  '\u2599', // 0b1101 — ▙ three-quarter bottom-left
  '\u259F', // 0b1110 — ▟ three-quarter bottom-right
  '\u2588', // 0b1111 — █ full block (all fg)
];

function rgbToHex(r: number, g: number, b: number): string {
  return '#' +
    (r | 0).toString(16).padStart(2, '0') +
    (g | 0).toString(16).padStart(2, '0') +
    (b | 0).toString(16).padStart(2, '0');
}

function colorDistSq(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Convert an RGBA pixel buffer (pixelWidth x pixelHeight) into Cell[].
// Output dimensions: ceil(pixelWidth/2) x ceil(pixelHeight/2).
// bgColor is used for transparent (alpha=0) pixels.
export function pixelsToCells(
  pixels: Uint8Array,
  pixelWidth: number,
  pixelHeight: number,
  bgR: number, bgG: number, bgB: number,
): { cells: Cell[]; cols: number; rows: number } {
  const cols = Math.ceil(pixelWidth / 2);
  const rows = Math.ceil(pixelHeight / 2);
  const cells: Cell[] = new Array(cols * rows);

  for (let cr = 0; cr < rows; cr++) {
    for (let cc = 0; cc < cols; cc++) {
      // Gather the 2x2 pixel block's RGB values
      const px = cc * 2, py = cr * 2;
      const quad: [number, number, number][] = [];

      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const x = px + dx, y = py + dy;
          if (x < pixelWidth && y < pixelHeight) {
            const i = (y * pixelWidth + x) * 4;
            if (pixels[i + 3] > 0) {
              quad.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
            } else {
              quad.push([bgR, bgG, bgB]);
            }
          } else {
            quad.push([bgR, bgG, bgB]);
          }
        }
      }

      // Find two most distant colors among the 4 pixels
      let maxDist = -1;
      let c1 = 0, c2 = 0;
      for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
          const d = colorDistSq(quad[i][0], quad[i][1], quad[i][2], quad[j][0], quad[j][1], quad[j][2]);
          if (d > maxDist) {
            maxDist = d;
            c1 = i;
            c2 = j;
          }
        }
      }

      const [r1, g1, b1] = quad[c1];
      const [r2, g2, b2] = quad[c2];

      // Assign each pixel to the nearer of the two representative colors → 4-bit pattern
      let pattern = 0;
      for (let i = 0; i < 4; i++) {
        const d1 = colorDistSq(quad[i][0], quad[i][1], quad[i][2], r1, g1, b1);
        const d2 = colorDistSq(quad[i][0], quad[i][1], quad[i][2], r2, g2, b2);
        if (d1 <= d2) {
          pattern |= (1 << i); // belongs to color1 group (fg)
        }
      }

      // fg = darker color, bg = lighter color
      let fgR: number, fgG: number, fgB: number;
      let bgCR: number, bgCG: number, bgCB: number;
      if (luminance(r1, g1, b1) <= luminance(r2, g2, b2)) {
        fgR = r1; fgG = g1; fgB = b1;
        bgCR = r2; bgCG = g2; bgCB = b2;
        // pattern already maps c1→fg
      } else {
        fgR = r2; fgG = g2; fgB = b2;
        bgCR = r1; bgCG = g1; bgCB = b1;
        // Invert pattern: c1 is now bg, c2 is fg
        pattern = (~pattern) & 0xF;
      }

      cells[cr * cols + cc] = {
        char: QUADRANT_CHARS[pattern],
        fg: rgbToHex(fgR, fgG, fgB),
        bg: rgbToHex(bgCR, bgCG, bgCB),
      };
    }
  }

  return { cells, cols, rows };
}

// Composite pixel-to-cell output onto an existing frame at a given position.
// Skips cells that are fully background (transparent).
export function compositeOntoFrame(
  frameCells: Cell[],
  frameCols: number,
  frameRows: number,
  srcCells: Cell[],
  srcCols: number,
  srcRows: number,
  offsetCol: number,
  offsetRow: number,
  bgHex: string,
  oid?: string,
): void {
  for (let r = 0; r < srcRows; r++) {
    const fr = offsetRow + r;
    if (fr < 0 || fr >= frameRows) continue;
    for (let c = 0; c < srcCols; c++) {
      const fc = offsetCol + c;
      if (fc < 0 || fc >= frameCols) continue;
      const src = srcCells[r * srcCols + c];
      if (src.char === ' ' && src.fg === bgHex && src.bg === bgHex) continue; // transparent
      const cell: Cell = { char: src.char, fg: src.fg, bg: src.bg };
      if (oid) cell.oid = oid;
      frameCells[fr * frameCols + fc] = cell;
    }
  }
}
