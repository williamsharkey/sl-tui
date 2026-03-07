// pixel-to-cells.ts — Convert RGBA pixel buffer to Cell[] using Unicode sextant characters
//
// Each 2x3 pixel group maps to one terminal cell, tripling vertical resolution.
// Uses Unicode Block Elements + Symbols for Legacy Computing (U+1FB00–U+1FB3B)
// for 6-subpixel (sextant) patterns: 2 columns × 3 rows = 64 patterns.
// Falls back to quadrant (2x2, 16 patterns) if needed.

import type { Cell } from './grid-state.js';

// Build sextant character table: 6 bits → character
// Bit layout (MSB to LSB): row0-left, row0-right, row1-left, row1-right, row2-left, row2-right
// Pattern 0 = space (all bg), pattern 63 = full block (all fg)
const SEXTANT_CHARS: string[] = new Array(64);

// The Unicode sextant block runs U+1FB00 to U+1FB3B (60 chars for patterns 1–62)
// with gaps where existing block element chars are reused:
//   pattern 0  → ' ' (space)
//   pattern 63 → '█' (U+2588, full block)
// The mapping from 6-bit pattern to codepoint follows the standard encoding.
function buildSextantTable(): void {
  // Bit order for Unicode sextants (U+1FB00 range):
  //   bit 0 = top-left
  //   bit 1 = top-right
  //   bit 2 = middle-left
  //   bit 3 = middle-right
  //   bit 4 = bottom-left
  //   bit 5 = bottom-right

  SEXTANT_CHARS[0]  = ' ';   // all bg
  SEXTANT_CHARS[63] = '\u2588'; // full block

  // Only 2 sextant patterns have existing block element equivalents:
  //   left half (▌) = all 3 left subpixels = bits 0,2,4 = 0b010101 = 21
  //   right half (▐) = all 3 right subpixels = bits 1,3,5 = 0b101010 = 42
  // These are skipped in the U+1FB00 sequential range.
  const EXISTING: Record<number, string> = {
    0b010101: '\u258C', // ▌ left half
    0b101010: '\u2590', // ▐ right half
  };

  // U+1FB00–U+1FB3B = 60 codepoints for patterns 1–62 minus 2 skipped = 60
  let codepoint = 0x1FB00;
  for (let pattern = 1; pattern < 63; pattern++) {
    if (EXISTING[pattern]) {
      SEXTANT_CHARS[pattern] = EXISTING[pattern];
    } else {
      SEXTANT_CHARS[pattern] = String.fromCodePoint(codepoint);
      codepoint++;
    }
  }
}

buildSextantTable();

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
// Uses 2x3 sextant blocks: output dimensions = ceil(pixelWidth/2) x ceil(pixelHeight/3).
// bgColor is used for transparent (alpha=0) pixels.
export function pixelsToCells(
  pixels: Uint8Array,
  pixelWidth: number,
  pixelHeight: number,
  bgR: number, bgG: number, bgB: number,
): { cells: Cell[]; cols: number; rows: number } {
  const cols = Math.ceil(pixelWidth / 2);
  const rows = Math.ceil(pixelHeight / 3);
  const cells: Cell[] = new Array(cols * rows);

  for (let cr = 0; cr < rows; cr++) {
    for (let cc = 0; cc < cols; cc++) {
      // Gather the 2x3 pixel block's RGB values (6 subpixels)
      const px = cc * 2, py = cr * 3;
      const block: [number, number, number][] = [];

      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const x = px + dx, y = py + dy;
          if (x < pixelWidth && y < pixelHeight) {
            const i = (y * pixelWidth + x) * 4;
            if (pixels[i + 3] > 0) {
              block.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
            } else {
              block.push([bgR, bgG, bgB]);
            }
          } else {
            block.push([bgR, bgG, bgB]);
          }
        }
      }

      // Find two most distant colors among the 6 pixels (seed colors)
      let maxDist = -1;
      let c1 = 0, c2 = 0;
      for (let i = 0; i < 6; i++) {
        for (let j = i + 1; j < 6; j++) {
          const d = colorDistSq(block[i][0], block[i][1], block[i][2], block[j][0], block[j][1], block[j][2]);
          if (d > maxDist) {
            maxDist = d;
            c1 = i;
            c2 = j;
          }
        }
      }

      // Assign each pixel to the nearer seed → 6-bit pattern
      let pattern = 0;
      let g1r = 0, g1g = 0, g1b = 0, g1n = 0;
      let g2r = 0, g2g = 0, g2b = 0, g2n = 0;
      for (let i = 0; i < 6; i++) {
        const d1 = colorDistSq(block[i][0], block[i][1], block[i][2], block[c1][0], block[c1][1], block[c1][2]);
        const d2 = colorDistSq(block[i][0], block[i][1], block[i][2], block[c2][0], block[c2][1], block[c2][2]);
        if (d1 <= d2) {
          pattern |= (1 << i);
          g1r += block[i][0]; g1g += block[i][1]; g1b += block[i][2]; g1n++;
        } else {
          g2r += block[i][0]; g2g += block[i][1]; g2b += block[i][2]; g2n++;
        }
      }

      // Compute average color per group for true representative colors
      let r1: number, gg1: number, b1: number, r2: number, gg2: number, b2: number;
      if (g1n > 0) { r1 = g1r / g1n; gg1 = g1g / g1n; b1 = g1b / g1n; }
      else { r1 = block[c1][0]; gg1 = block[c1][1]; b1 = block[c1][2]; }
      if (g2n > 0) { r2 = g2r / g2n; gg2 = g2g / g2n; b2 = g2b / g2n; }
      else { r2 = block[c2][0]; gg2 = block[c2][1]; b2 = block[c2][2]; }

      // fg = darker color, bg = lighter color (convention for block chars)
      let fgR: number, fgG: number, fgB: number;
      let bgCR: number, bgCG: number, bgCB: number;
      if (luminance(r1, gg1, b1) <= luminance(r2, gg2, b2)) {
        fgR = r1; fgG = gg1; fgB = b1;
        bgCR = r2; bgCG = gg2; bgCB = b2;
      } else {
        fgR = r2; fgG = gg2; fgB = b2;
        bgCR = r1; bgCG = gg1; bgCB = b1;
        pattern = (~pattern) & 0x3F;
      }

      cells[cr * cols + cc] = {
        char: SEXTANT_CHARS[pattern],
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
