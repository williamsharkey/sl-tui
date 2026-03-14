// grid-state.ts — 3D-to-2D projection, Z-slice, terrain/object/avatar layers, diffing

import type { AvatarMeshBundle, CachedMesh } from './avatar-cache.js';
import type { AvatarAppearanceData, BakedTextureColors } from './avatar-appearance.js';
import {
  createRasterTarget, clearRasterTarget, rasterize,
  mat4Multiply, mat4LookAt, mat4Perspective, mat4ModelPosScale,
  mat4ModelPosScaleRot,
} from './soft-rasterizer.js';
import { pixelsToCells } from './pixel-to-cells.js';
import type { CloudParams } from './cloud-cache.js';
import { sampleCloudAlpha } from './cloud-cache.js';

export interface Cell {
  char: string;
  fg: string;
  bg: string;
  oid?: string; // object/avatar UUID for inspect
}

export interface CellDelta {
  idx: number;
  col: number;
  row: number;
  char: string;
  fg: string;
  bg: string;
  oid?: string;
}

export interface GridFrame {
  cells: Cell[];
  cols: number;
  rows: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const BG = '#f0eedc';

// Color scheme
const COLORS = {
  deepWater:  '#2266aa',
  water:      '#4488bb',
  beach:      '#998866',
  ground:     '#336633',
  hills:      '#666633',
  mountains:  '#666666',
  object:     '#885522',
  tree:       '#336633',
  avatar:     '#000000',
  self:       '#cc0000',
  dimmed:     '#999999',
  faint:      '#cccccc',
  shadow:     '#888888',
  edge:       '#555555',
};

function emptyCell(): Cell {
  return { char: ' ', fg: COLORS.ground, bg: BG };
}

export function createEmptyFrame(cols: number, rows: number): GridFrame {
  const cells: Cell[] = new Array(cols * rows);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = emptyCell();
  }
  return { cells, cols, rows };
}

// Extract yaw from quaternion (SL uses Z-up)
function quaternionToYaw(x: number, y: number, z: number, w: number): number {
  // Yaw = rotation around Z axis
  const siny_cosp = 2 * (w * z + x * y);
  const cosy_cosp = 1 - 2 * (y * y + z * z);
  return Math.atan2(siny_cosp, cosy_cosp);
}

function yawToDirectionChar(yaw: number): string {
  // SL: 0 = east, pi/2 = north
  const deg = ((yaw * 180 / Math.PI) + 360) % 360;
  if (deg >= 315 || deg < 45) return '>';   // east
  if (deg >= 45 && deg < 135) return '^';   // north
  if (deg >= 135 && deg < 225) return '<';  // west
  return 'v';                                // south
}

// Classify terrain height into char + color
function terrainCell(height: number, waterHeight: number): Cell {
  if (height < waterHeight - 2) return { char: '~', fg: COLORS.deepWater, bg: BG };
  if (height < waterHeight) return { char: '~', fg: COLORS.water, bg: BG };
  if (height < waterHeight + 1) return { char: ',', fg: COLORS.beach, bg: BG };
  if (height < waterHeight + 15) return { char: '.', fg: COLORS.ground, bg: BG };
  if (height < waterHeight + 40) return { char: ':', fg: COLORS.hills, bg: BG };
  return { char: '^', fg: COLORS.mountains, bg: BG };
}

export interface AvatarData {
  uuid: string;
  firstName: string;
  lastName: string;
  x: number;
  y: number;
  z: number;
  yaw: number; // radians
  isSelf: boolean;
  velX: number;
  velY: number;
  velZ: number;
}

export interface ObjectData {
  uuid: string;
  name: string;
  x: number;
  y: number;
  z: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  isTree: boolean;
  pcode: number;        // 9=Prim, 95=Grass, 111=NewTree, 255=Tree
  treeSpecies: number;  // -1 if not tree
  pathCurve: number;    // 16=line(box), 32=circle(cyl/sphere)
  profileCurve: number; // 0=circle, 1=square, 2=triangle, 5=halfCircle
  rotX: number; rotY: number; rotZ: number; rotW: number;
  colorR: number; colorG: number; colorB: number; // 0-255
  alpha?: number;       // 0-1, undefined = opaque
  fullbright?: boolean;
  faceColors?: [number, number, number, number][]; // [r,g,b,alpha] per face
  meshUUID?: string;    // mesh asset UUID from extraParams.meshData
  // Prim shape modifiers
  profileHollow?: number;  // 0-1
  pathBegin?: number;      // 0-1 (cut start)
  pathEnd?: number;        // 0-1 (cut end)
  pathTwist?: number;      // radians
  pathTwistBegin?: number;
  pathTaperX?: number;     // -1 to 1
  pathTaperY?: number;
}

export interface ProjectionParams {
  cols: number;
  rows: number;
  selfX: number;
  selfY: number;
  selfZ: number;
  waterHeight: number;
  metersPerCell: number;
  yaw?: number; // facing direction — rotates the map so up = facing
}

// FOV arc: draw dots at radius 2-3 cells around self within a ~90° cone
const FOV_COLOR = '#cc0000';
const FOV_RADIUS_MIN = 2;
const FOV_RADIUS_MAX = 3;
const FOV_HALF_ANGLE = Math.PI / 4; // 45° each side = 90° total

function renderFovArc(
  frame: GridFrame,
  selfCol: number, selfRow: number,
  yaw: number,
  cols: number, rows: number,
): void {
  // Check cells in a box around self, test if they fall in the FOV cone
  for (let dr = -FOV_RADIUS_MAX; dr <= FOV_RADIUS_MAX; dr++) {
    for (let dc = -FOV_RADIUS_MAX; dc <= FOV_RADIUS_MAX; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = selfRow + dr;
      const c = selfCol + dc;
      if (r < 0 || r >= rows || c < 0 || c >= cols) continue;

      const dist = Math.sqrt(dc * dc + dr * dr);
      if (dist < FOV_RADIUS_MIN - 0.5 || dist > FOV_RADIUS_MAX + 0.5) continue;

      // Angle from self to this cell in screen coords
      // dc = east, -dr = north (screen row 0 is top = north)
      const cellAngle = Math.atan2(-dr, dc); // east=0, north=pi/2
      let diff = cellAngle - yaw;
      // Normalize to [-pi, pi]
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;

      if (Math.abs(diff) <= FOV_HALF_ANGLE) {
        const idx = r * cols + c;
        // Only overlay on terrain cells (don't overwrite avatars/objects)
        const existing = frame.cells[idx].char;
        if (existing !== '@' && existing !== '^' && existing !== 'v' &&
            existing !== '<' && existing !== '>' && existing !== '#' &&
            existing !== 'T' && existing !== '+' && existing !== '-') {
          frame.cells[idx] = { char: '·', fg: FOV_COLOR, bg: BG };
        }
      }
    }
  }
}

// Rotated sim-to-grid: applies yaw rotation so "up" on screen = facing direction
function simToGridRotated(
  simX: number, simY: number,
  params: ProjectionParams,
  cosY: number, sinY: number,
): { col: number; row: number } | null {
  const dx = simX - params.selfX;
  const dy = simY - params.selfY;
  // Project onto right (screen-col) and forward (screen-row-up) axes
  // Right = (sin(yaw), -cos(yaw)), Forward = (cos(yaw), sin(yaw))
  const rightComponent = dx * sinY - dy * cosY;
  const forwardComponent = dx * cosY + dy * sinY;
  const col = Math.round(params.cols / 2 + rightComponent / params.metersPerCell);
  const row = Math.round(params.rows / 2 - forwardComponent / params.metersPerCell);
  if (col < 0 || col >= params.cols || row < 0 || row >= params.rows) return null;
  return { col, row };
}

// Place a compass label at the edge of the map for a given world direction
function placeCompassLabel(
  frame: GridFrame, cols: number, rows: number,
  label: string, worldAngle: number, // radians, SL convention: 0=east, pi/2=north
  cosY: number, sinY: number,
): void {
  // Direction in rotated screen space
  const dx = Math.cos(worldAngle);
  const dy = Math.sin(worldAngle);
  const rx = dx * sinY - dy * cosY;   // right component
  const ry = dx * cosY + dy * sinY;   // forward component
  // Project to edge: find where ray hits border
  const halfC = cols / 2 - 1;
  const halfR = rows / 2 - 1;
  let t = Infinity;
  if (rx !== 0) t = Math.min(t, Math.abs(halfC / rx));
  if (ry !== 0) t = Math.min(t, Math.abs(halfR / ry));
  const ec = Math.round(cols / 2 + rx * t);
  const er = Math.round(rows / 2 - ry * t);
  const c = Math.max(0, Math.min(cols - 1, ec));
  const r = Math.max(0, Math.min(rows - 1, er));
  const idx = r * cols + c;
  frame.cells[idx] = { char: label, fg: '#ffffff', bg: BG };
}

export function projectFrame(
  terrain: (x: number, y: number) => number,
  avatars: AvatarData[],
  objects: ObjectData[],
  params: ProjectionParams,
  flying: boolean,
): GridFrame {
  const { cols, rows, selfX, selfY, selfZ, waterHeight, metersPerCell } = params;
  const frame = createEmptyFrame(cols, rows);

  // Rotation for yaw-oriented map (up = facing direction)
  const yaw = params.yaw ?? Math.PI / 2; // default: north up
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);

  // 1. Terrain layer + border overlay — compute world coords once
  const BORDER_COLOR = '#cc6600';
  const totalCells = cols * rows;
  const worldXs = new Float32Array(totalCells);
  const worldYs = new Float32Array(totalCells);
  for (let row = 0; row < rows; row++) {
    const sy = (rows / 2 - row) * metersPerCell;
    for (let col = 0; col < cols; col++) {
      const sx = (col - cols / 2) * metersPerCell;
      const idx = row * cols + col;
      worldXs[idx] = selfX + sx * sinY + sy * cosY;
      worldYs[idx] = selfY - sx * cosY + sy * sinY;
      const simX = worldXs[idx], simY = worldYs[idx];
      if (simX >= 0 && simX < 256 && simY >= 0 && simY < 256) {
        const h = terrain(Math.floor(simX), Math.floor(simY));
        frame.cells[idx] = terrainCell(h, waterHeight);
      } else {
        frame.cells[idx] = { char: ' ', fg: '#333333', bg: BG };
      }
    }
  }

  // 1b. Sim border overlay — reuse cached world coords
  for (let i = 0; i < totalCells; i++) {
    const simX = worldXs[i], simY = worldYs[i];
    const nearBorderX = simX < metersPerCell || simX > 256 - metersPerCell;
    const nearBorderY = simY < metersPerCell || simY > 256 - metersPerCell;
    if ((nearBorderX || nearBorderY) && simX >= 0 && simX < 256 && simY >= 0 && simY < 256) {
      const existing = frame.cells[i];
      if (existing.char !== '@' && existing.char !== '#' && existing.char !== 'T' &&
          !'^v<>'.includes(existing.char)) {
        frame.cells[i] = { char: '│', fg: BORDER_COLOR, bg: BG };
      }
    }
  }

  // 2. Objects layer (skip tiny ones)
  for (const obj of objects) {
    const dz = Math.abs(obj.z - selfZ);
    if (dz >= 30) continue;
    const maxDim = Math.max(obj.scaleX, obj.scaleY, obj.scaleZ);
    if (maxDim < 0.5) continue;

    const pos = simToGridRotated(obj.x, obj.y, params, cosY, sinY);
    if (!pos) continue;

    // Species-aware minimap char and use actual object color
    let ch: string;
    let fg: string;
    if (obj.pcode === 95) {
      ch = ','; // grass
    } else if (obj.isTree) {
      const sp = obj.treeSpecies;
      if (sp === 0 || sp === 7 || sp === 8 || sp === 9 || sp === 11 || sp === 13) ch = 'Y'; // pine
      else if (sp === 3 || sp === 6) ch = 'T'; // palm
      else if (sp === 1 || sp === 10) ch = '@'; // oak
      else ch = 'T';
    } else {
      ch = '#';
    }
    // Use actual color as fg hex
    fg = `#${obj.colorR.toString(16).padStart(2,'0')}${obj.colorG.toString(16).padStart(2,'0')}${obj.colorB.toString(16).padStart(2,'0')}`;
    if (obj.isTree && obj.colorR === 128 && obj.colorG === 128 && obj.colorB === 128) fg = COLORS.tree;

    if (dz >= 10) fg = COLORS.faint;
    else if (dz >= 3) fg = COLORS.dimmed;

    const idx = pos.row * cols + pos.col;
    frame.cells[idx] = { char: ch, fg, bg: BG, oid: obj.uuid };
  }

  // 3. Avatar layer
  for (const av of avatars) {
    if (av.isSelf) continue;
    const dz = av.z - selfZ;
    if (Math.abs(dz) >= 30) continue;

    const pos = simToGridRotated(av.x, av.y, params, cosY, sinY);
    if (!pos) continue;

    const ch = yawToDirectionChar(av.yaw);
    let fg = COLORS.avatar;
    if (Math.abs(dz) >= 10) fg = COLORS.faint;
    else if (Math.abs(dz) >= 3) fg = COLORS.dimmed;

    const idx = pos.row * cols + pos.col;
    frame.cells[idx] = { char: ch, fg, bg: BG, oid: av.uuid };

    // Altitude indicator: + above if significantly higher, - below if lower
    if (dz > 5 && pos.row > 0) {
      const aboveIdx = (pos.row - 1) * cols + pos.col;
      frame.cells[aboveIdx] = { char: '+', fg, bg: BG, oid: av.uuid };
    } else if (dz < -5 && pos.row < rows - 1) {
      const belowIdx = (pos.row + 1) * cols + pos.col;
      frame.cells[belowIdx] = { char: '-', fg, bg: BG, oid: av.uuid };
    }
  }

  // 4. Flying shadow
  if (flying && selfZ > waterHeight + 5) {
    const selfGrid = simToGridRotated(selfX, selfY, params, cosY, sinY);
    if (selfGrid) {
      const idx = selfGrid.row * cols + selfGrid.col;
      frame.cells[idx] = { char: '+', fg: COLORS.shadow, bg: BG };
    }
  }

  // 5. Self — always at center
  const selfCol = Math.round(cols / 2);
  const selfRow = Math.round(rows / 2);
  if (selfCol >= 0 && selfCol < cols && selfRow >= 0 && selfRow < rows) {
    const idx = selfRow * cols + selfCol;
    frame.cells[idx] = { char: '@', fg: COLORS.self, bg: BG };
  }

  // 5b. FOV arc — in rotated map, facing is always screen-up
  if (selfCol >= 0 && selfCol < cols && selfRow >= 0 && selfRow < rows) {
    renderFovArc(frame, selfCol, selfRow, Math.PI / 2, cols, rows); // always up
  }

  // 6. Compass labels on edges: N E S W
  placeCompassLabel(frame, cols, rows, 'N', Math.PI / 2, cosY, sinY);   // north
  placeCompassLabel(frame, cols, rows, 'E', 0, cosY, sinY);             // east
  placeCompassLabel(frame, cols, rows, 'S', -Math.PI / 2, cosY, sinY);  // south
  placeCompassLabel(frame, cols, rows, 'W', Math.PI, cosY, sinY);       // west

  // 7. Edge indicators for off-screen avatars
  for (const av of avatars) {
    if (av.isSelf) continue;
    const dz = Math.abs(av.z - selfZ);
    if (dz >= 30) continue;
    const pos = simToGridRotated(av.x, av.y, params, cosY, sinY);
    if (pos) continue; // on-screen

    const dx = av.x - selfX;
    const dy = av.y - selfY;
    // Project onto screen axes: right (col) and forward (row-up)
    const rx = dx * sinY - dy * cosY;   // right component → screen col
    const ry = dx * cosY + dy * sinY;   // forward component → screen up
    const angle = Math.atan2(ry, rx);
    const deg = ((angle * 180 / Math.PI) + 360) % 360;

    let edgeCol: number, edgeRow: number, arrow: string;
    if (deg >= 315 || deg < 45) { edgeCol = cols - 1; edgeRow = Math.round(rows / 2); arrow = '>'; }
    else if (deg >= 45 && deg < 135) { edgeCol = Math.round(cols / 2); edgeRow = 0; arrow = '^'; }
    else if (deg >= 135 && deg < 225) { edgeCol = 0; edgeRow = Math.round(rows / 2); arrow = '<'; }
    else { edgeCol = Math.round(cols / 2); edgeRow = rows - 1; arrow = 'v'; }

    edgeCol = Math.max(0, Math.min(cols - 1, edgeCol));
    edgeRow = Math.max(0, Math.min(rows - 1, edgeRow));
    const idx = edgeRow * cols + edgeCol;
    frame.cells[idx] = { char: arrow, fg: COLORS.edge, bg: BG, oid: av.uuid };
  }

  return frame;
}

// ─── First-person strip renderer ───────────────────────────────────
// Parallel-ray column renderer: no horizontal fan-out, vertical perspective only.
// Renders strips front-to-back with occlusion.

const SKY_BG = '#1a1a2e';
const SKY_COLORS = ['#2a2a4e', '#222244', '#1e1e3a']; // slight variation

// Depth-dimmed terrain color (cached — quantize to 32 levels)
const dimColorCache = new Map<string, string>();
function dimColor(hex: string, depth: number, maxDepth: number): string {
  const quantized = Math.round(Math.min(1, depth / maxDepth) * 32);
  const key = `${hex}|${quantized}`;
  let result = dimColorCache.get(key);
  if (result !== undefined) return result;

  const t = quantized / 32;
  const [r, g, b] = hexToRgbLocal(hex);
  const fogR = 0x66, fogG = 0x77, fogB = 0x88;
  const dr = Math.round(r + (fogR - r) * t);
  const dg = Math.round(g + (fogG - g) * t);
  const db = Math.round(b + (fogB - b) * t);
  result = `#${dr.toString(16).padStart(2,'0')}${dg.toString(16).padStart(2,'0')}${db.toString(16).padStart(2,'0')}`;
  dimColorCache.set(key, result);
  return result;
}

function hexToRgbLocal(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

// ─── RGB color constants for pixel-buffer FP renderer ─────────────

const SKY_RGB: [number, number, number] = [0x1a, 0x1a, 0x2e];
const HORIZON_RGB: [number, number, number] = [0x55, 0x55, 0x66];
const FOG_RGB: [number, number, number] = [0x66, 0x77, 0x88];

// Terrain color stops for smooth gradient interpolation
// Each stop: [height_offset_from_water, R, G, B]
const TERRAIN_STOPS: [number, number, number, number][] = [
  [-10, 0x10, 0x44, 0x88], // abyss
  [-5,  0x18, 0x55, 0x99], // deep ocean
  [-2,  0x22, 0x66, 0xaa], // deep water
  [0,   0x44, 0x88, 0xbb], // water surface
  [0.3, 0xaa, 0x99, 0x77], // wet sand
  [1.5, 0x99, 0x88, 0x66], // beach
  [3,   0x66, 0x88, 0x44], // scrub
  [8,   0x33, 0x77, 0x33], // lush grass
  [15,  0x44, 0x66, 0x33], // grass
  [25,  0x55, 0x66, 0x33], // dry grass
  [35,  0x66, 0x66, 0x44], // foothills
  [50,  0x77, 0x77, 0x55], // hills
  [70,  0x88, 0x88, 0x77], // rocky
  [90,  0x77, 0x77, 0x77], // mountain
  [120, 0xaa, 0xaa, 0xaa], // snow
];

// Precomputed terrain color LUT: 1 entry per 0.5m from TERRAIN_STOPS min to max
// Avoids per-pixel linear search through 15 stops
const TERRAIN_LUT_STEP = 0.5;
const TERRAIN_LUT_MIN = TERRAIN_STOPS[0][0];
const TERRAIN_LUT_MAX = TERRAIN_STOPS[TERRAIN_STOPS.length - 1][0];
const TERRAIN_LUT_SIZE = Math.ceil((TERRAIN_LUT_MAX - TERRAIN_LUT_MIN) / TERRAIN_LUT_STEP) + 1;
const TERRAIN_LUT_R = new Uint8Array(TERRAIN_LUT_SIZE);
const TERRAIN_LUT_G = new Uint8Array(TERRAIN_LUT_SIZE);
const TERRAIN_LUT_B = new Uint8Array(TERRAIN_LUT_SIZE);

function buildTerrainLUT(): void {
  for (let li = 0; li < TERRAIN_LUT_SIZE; li++) {
    const h = TERRAIN_LUT_MIN + li * TERRAIN_LUT_STEP;
    // Find bracketing stops
    let r: number, g: number, b: number;
    if (h <= TERRAIN_STOPS[0][0]) {
      r = TERRAIN_STOPS[0][1]; g = TERRAIN_STOPS[0][2]; b = TERRAIN_STOPS[0][3];
    } else if (h >= TERRAIN_LUT_MAX) {
      const last = TERRAIN_STOPS[TERRAIN_STOPS.length - 1];
      r = last[1]; g = last[2]; b = last[3];
    } else {
      r = 0; g = 0; b = 0;
      for (let i = 0; i < TERRAIN_STOPS.length - 1; i++) {
        const a = TERRAIN_STOPS[i], bn = TERRAIN_STOPS[i + 1];
        if (h >= a[0] && h < bn[0]) {
          const t = (h - a[0]) / (bn[0] - a[0]);
          r = a[1] + (bn[1] - a[1]) * t + 0.5 | 0;
          g = a[2] + (bn[2] - a[2]) * t + 0.5 | 0;
          b = a[3] + (bn[3] - a[3]) * t + 0.5 | 0;
          break;
        }
      }
    }
    TERRAIN_LUT_R[li] = r;
    TERRAIN_LUT_G[li] = g;
    TERRAIN_LUT_B[li] = b;
  }
}
buildTerrainLUT();

// Reusable tuple to avoid allocation in hot path (caller must consume immediately)
const _terrainRGBOut: [number, number, number] = [0, 0, 0];

// Smooth lerp between terrain color stops via LUT
function terrainRGB(height: number, waterHeight: number): [number, number, number] {
  const h = height - waterHeight;
  const fi = (h - TERRAIN_LUT_MIN) / TERRAIN_LUT_STEP;
  const i0 = Math.max(0, Math.min(TERRAIN_LUT_SIZE - 1, fi | 0));
  const i1 = Math.min(TERRAIN_LUT_SIZE - 1, i0 + 1);
  const frac = fi - i0;
  _terrainRGBOut[0] = TERRAIN_LUT_R[i0] + (TERRAIN_LUT_R[i1] - TERRAIN_LUT_R[i0]) * frac + 0.5 | 0;
  _terrainRGBOut[1] = TERRAIN_LUT_G[i0] + (TERRAIN_LUT_G[i1] - TERRAIN_LUT_G[i0]) * frac + 0.5 | 0;
  _terrainRGBOut[2] = TERRAIN_LUT_B[i0] + (TERRAIN_LUT_B[i1] - TERRAIN_LUT_B[i0]) * frac + 0.5 | 0;
  return _terrainRGBOut;
}

// Water surface pixel: add wavelet pattern (reuses _terrainRGBOut)
const _waterRGBOut: [number, number, number] = [0, 0, 0];
function waterPixelRGB(height: number, waterHeight: number, wx: number, wy: number, depth: number): [number, number, number] {
  const [br, bg, bb] = terrainRGB(height, waterHeight);
  const wave = Math.sin(wx * 0.8 + wy * 0.3) * Math.cos(wy * 0.6 - wx * 0.2);
  const highlight = wave > 0.3 ? 30 : wave < -0.3 ? -15 : 0;
  _waterRGBOut[0] = Math.max(0, Math.min(255, br + highlight));
  _waterRGBOut[1] = Math.max(0, Math.min(255, bg + highlight));
  _waterRGBOut[2] = Math.max(0, Math.min(255, bb + highlight));
  return _waterRGBOut;
}

// Procedural terrain texture: adds visual detail based on terrain zone
const _texRGBOut: [number, number, number] = [0, 0, 0];
export function terrainTexturedRGB(height: number, waterHeight: number, wx: number, wy: number): [number, number, number] {
  let [r, g, b] = terrainRGB(height, waterHeight);
  const h = height - waterHeight;

  if (h >= 0.3 && h < 3) {
    const speckle = Math.sin(wx * 12.3) * Math.sin(wy * 11.7) * 8;
    r = Math.max(0, Math.min(255, r + speckle));
    g = Math.max(0, Math.min(255, g + speckle));
    b = Math.max(0, Math.min(255, b + speckle));
  } else if (h >= 3 && h < 25) {
    const noise = Math.sin(wx * 4.3) * Math.cos(wy * 3.7);
    const variation = noise * 12;
    const darkPatch = noise < -0.5 ? -15 : 0;
    r = Math.max(0, Math.min(255, r + variation + darkPatch));
    g = Math.max(0, Math.min(255, g + variation + darkPatch));
    b = Math.max(0, Math.min(255, b + variation + darkPatch));
  } else if (h >= 35 && h < 90) {
    const streak = Math.sin(wx * 2.1 + wy * 7.8) * 15;
    r = Math.max(0, Math.min(255, r + streak));
    g = Math.max(0, Math.min(255, g + streak));
    b = Math.max(0, Math.min(255, b + streak));
  } else if (h >= 90) {
    const sparkle = Math.sin(wx * 20.1) * Math.sin(wy * 19.3) > 0.7 ? 25 : 0;
    r = Math.max(0, Math.min(255, r + sparkle));
    g = Math.max(0, Math.min(255, g + sparkle));
    b = Math.max(0, Math.min(255, b + sparkle));
  }

  _texRGBOut[0] = r; _texRGBOut[1] = g; _texRGBOut[2] = b;
  return _texRGBOut;
}

// Avatar color from UUID hash — muted clothing tones
export function avatarColorFromUUID(uuid: string): [number, number, number] {
  let hash = 0;
  for (let i = 0; i < uuid.length; i++) {
    hash = ((hash << 5) - hash + uuid.charCodeAt(i)) | 0;
  }
  const hue = ((hash & 0xFFFF) % 360);
  // HSL to RGB with S=0.3 L=0.35
  const s = 0.3, l = 0.35;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = l - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if (hue < 60) { r1 = c; g1 = x; }
  else if (hue < 120) { r1 = x; g1 = c; }
  else if (hue < 180) { g1 = c; b1 = x; }
  else if (hue < 240) { g1 = x; b1 = c; }
  else if (hue < 300) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

// Apply depth fog to RGB (reuses output tuple to reduce GC pressure)
const _fogRGBOut: [number, number, number] = [0, 0, 0];
function fogRGB(r: number, g: number, b: number, depth: number, maxDepth: number, fog?: [number, number, number]): [number, number, number] {
  const t = Math.min(1, depth / maxDepth);
  const f = fog ?? FOG_RGB;
  _fogRGBOut[0] = r + (f[0] - r) * t + 0.5 | 0;
  _fogRGBOut[1] = g + (f[1] - g) * t + 0.5 | 0;
  _fogRGBOut[2] = b + (f[2] - b) * t + 0.5 | 0;
  return _fogRGBOut;
}

// Pixel buffer + depth buffer + OID buffer for FP rendering
interface FPPixelBuffer {
  pixels: Uint8Array;   // RGBA, (pw * ph * 4)
  depth: Float32Array;  // per-pixel depth for occlusion
  oids: (string | undefined)[];  // per-pixel object/avatar UUID
  pw: number;
  ph: number;
}

// Reusable pixel buffer (resized as needed)
let fpPixBuf: FPPixelBuffer | null = null;

function getFPPixelBuffer(pw: number, ph: number): FPPixelBuffer {
  if (!fpPixBuf || fpPixBuf.pw !== pw || fpPixBuf.ph !== ph) {
    fpPixBuf = {
      pixels: new Uint8Array(pw * ph * 4),
      depth: new Float32Array(pw * ph),
      oids: new Array(pw * ph),
      pw, ph,
    };
  }
  return fpPixBuf;
}

function clearFPPixelBuffer(
  buf: FPPixelBuffer,
  zenith?: [number, number, number],
  horizon?: [number, number, number],
): void {
  buf.depth.fill(Infinity);
  buf.oids.fill(undefined);
  const z = zenith ?? SKY_RGB;
  const h = horizon ?? HORIZON_RGB;
  const { pw, ph, pixels } = buf;
  const invHalfH = 2 / ph;
  for (let py = 0; py < ph; py++) {
    const t = Math.min(1, py * invHalfH);
    const sr = z[0] + (h[0] - z[0]) * t + 0.5 | 0;
    const sg = z[1] + (h[1] - z[1]) * t + 0.5 | 0;
    const sb = z[2] + (h[2] - z[2]) * t + 0.5 | 0;
    let ci = py * pw * 4;
    for (let px = 0; px < pw; px++) {
      pixels[ci]     = sr;
      pixels[ci + 1] = sg;
      pixels[ci + 2] = sb;
      pixels[ci + 3] = 255;
      ci += 4;
    }
  }
}

// Render two scrolling cloud layers over sky gradient (SNES-style parallax)
function renderCloudLayers(buf: FPPixelBuffer, cp: CloudParams, yaw: number, fov: number, time: number): void {
  const { pw, ph, pixels } = buf;
  const skyLimit = Math.floor(ph * 0.6); // clouds only in upper 60%
  const tex = cp.texture;

  for (let py = 0; py < skyLimit; py++) {
    // Vertical factor: 1.0 at top, 0.0 at sky limit
    const vFactor = 1.0 - py / (ph * 0.5);
    // Horizon fade: smoothstep from 0.05 to 0.3
    const t = Math.max(0, Math.min(1, (vFactor - 0.05) / 0.25));
    const horizonFade = t * t * (3 - 2 * t);

    for (let px = 0; px < pw; px++) {
      const uAngle = yaw + (px - pw / 2) * (fov / pw);

      // Layer 1 (far, slow)
      const u1 = (uAngle * cp.scale + cp.scrollRateX * time * 0.3) % 1.0;
      const v1 = (vFactor * cp.scale + cp.scrollRateY * time * 0.3) % 1.0;
      const a1 = sampleCloudAlpha(tex, u1, v1) * cp.density1Z * cp.shadow * horizonFade;

      // Layer 2 (near, fast — parallax offset)
      const u2 = (uAngle * cp.scale * 0.7 + cp.scrollRateX * time * 0.7) % 1.0;
      const v2 = (vFactor * cp.scale * 0.7 + cp.scrollRateY * time * 0.7 + 0.37) % 1.0;
      const a2 = sampleCloudAlpha(tex, u2, v2) * cp.density2Z * cp.shadow * 0.6 * horizonFade;

      // Combined alpha (additive blend of two layers, clamped)
      const alpha = Math.min(1, a1 + a2);
      if (alpha < 0.02) continue;

      const ci = (py * pw + px) * 4;
      // Alpha-blend cloud color over existing sky pixel
      pixels[ci]     = pixels[ci]     + (cp.colorR - pixels[ci])     * alpha + 0.5 | 0;
      pixels[ci + 1] = pixels[ci + 1] + (cp.colorG - pixels[ci + 1]) * alpha + 0.5 | 0;
      pixels[ci + 2] = pixels[ci + 2] + (cp.colorB - pixels[ci + 2]) * alpha + 0.5 | 0;
    }
  }
}

// Set a pixel in the FP buffer with optional depth test
function setFPPixel(buf: FPPixelBuffer, px: number, py: number, r: number, g: number, b: number, oid?: string, pixDepth?: number): void {
  if (px < 0 || px >= buf.pw || py < 0 || py >= buf.ph) return;
  const idx = py * buf.pw + px;
  // Depth test: reject if farther than existing pixel
  if (pixDepth !== undefined && pixDepth >= buf.depth[idx]) return;
  const ci = idx * 4;
  buf.pixels[ci]     = r;
  buf.pixels[ci + 1] = g;
  buf.pixels[ci + 2] = b;
  buf.pixels[ci + 3] = 255;
  if (oid) buf.oids[idx] = oid;
  if (pixDepth !== undefined) buf.depth[idx] = pixDepth;
}

export interface ChatBubble {
  message: string;
  ts: number; // timestamp when said
}

export type RenderMode = 'voxel' | 'triangle' | 'hybrid';

export interface FirstPersonParams {
  selfX: number;
  selfY: number;
  selfZ: number;  // eye height
  yaw: number;
  waterHeight: number;
  flying?: boolean;     // enables dynamic pitch and extended draw distance
  terrainHeight?: number; // terrain height at camera position (for altitude-based pitch)
  ditherPhase?: number; // 0 = off, >0 = animated phase for spatial dither
  meshLookup?: (uuid: string) => AvatarMeshBundle | null;
  appearanceLookup?: (uuid: string) => AvatarAppearanceData | null;
  bakedColorsLookup?: (uuid: string) => BakedTextureColors | null;
  sceneMeshLookup?: (uuid: string) => CachedMesh[] | null;
  sceneMeshTrigger?: (uuids: string[]) => void;
  avatarNames?: Map<string, string>; // uuid → display name
  chatBubbles?: Map<string, ChatBubble>; // uuid → most recent chat
  skyColors?: { zenith: [number, number, number]; horizon: [number, number, number] };
  sunDir?: [number, number, number]; // normalized sun light direction for shading
  renderMode?: RenderMode; // 'voxel' (default) or 'triangle' or 'hybrid'
  terrainTexture?: boolean;
  cameraMode?: 'first-person' | 'third-person'; // third-person = helicopter chase cam
  cameraOrbitYaw?: number;   // radians offset for orbit camera
  cameraOrbitPitch?: number; // radians offset for orbit camera
  selfAvatarPos?: { x: number; y: number; z: number }; // avatar feet position for third-person rendering
  cloudParams?: CloudParams; // SNES-style parallax cloud layers
  cloudTime?: number;        // animation time for cloud scrolling
}

// Shared raster target for avatar mesh rendering — reused across frames
let meshRasterTarget: ReturnType<typeof createRasterTarget> | null = null;
const MESH_PIXEL_W = 64;  // pixels per avatar render
const MESH_PIXEL_H = 128;

function getMeshRasterTarget() {
  if (!meshRasterTarget || meshRasterTarget.width !== MESH_PIXEL_W || meshRasterTarget.height !== MESH_PIXEL_H) {
    meshRasterTarget = createRasterTarget(MESH_PIXEL_W, MESH_PIXEL_H);
  }
  return meshRasterTarget;
}

// Spatial noise for dither — high-frequency, very low-amplitude vertex wobble
// Returns ±1 range; caller controls amplitude via scale factor
function ditherNoise(x: number, y: number, phase: number): number {
  // High-frequency sin hash — each vertex gets a distinct wobble
  return Math.sin(x * 7.3 + phase * 1.3) * Math.cos(y * 11.1 + phase * 0.9)
       + Math.sin((x + y) * 5.7 - phase * 1.7) * 0.5;
}

// ─── Unit geometry generators (cached) ────────────────────────────
interface UnitGeometry {
  positions: Float32Array;
  indices: Uint16Array;
}

// Geometry cache
const _geoCache = new Map<string, UnitGeometry>();

function cachedGeo(key: string, build: () => UnitGeometry): UnitGeometry {
  let g = _geoCache.get(key);
  if (!g) { g = build(); _geoCache.set(key, g); }
  return g;
}

function getBoxGeometry(): UnitGeometry {
  return cachedGeo('box', () => {
    const p = new Float32Array([
      -0.5,-0.5,-0.5,  0.5,-0.5,-0.5,  0.5,0.5,-0.5,  -0.5,0.5,-0.5, // bottom
      -0.5,-0.5, 0.5,  0.5,-0.5, 0.5,  0.5,0.5, 0.5,  -0.5,0.5, 0.5, // top
    ]);
    const i = new Uint16Array([
      0,1,2, 0,2,3, // bottom
      4,6,5, 4,7,6, // top
      0,5,1, 0,4,5, // front
      2,7,3, 2,6,7, // back
      0,3,7, 0,7,4, // left
      1,5,6, 1,6,2, // right
    ]);
    return { positions: p, indices: i };
  });
}

function getCylinderGeometry(): UnitGeometry {
  return cachedGeo('cyl', () => {
    const segs = 12;
    const verts: number[] = [];
    const idx: number[] = [];
    verts.push(0, 0, -0.5); // 0: bottom center
    verts.push(0, 0, 0.5);  // 1: top center
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      verts.push(Math.cos(a) * 0.5, Math.sin(a) * 0.5, -0.5);
    }
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      verts.push(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0.5);
    }
    const bBase = 2, tBase = 2 + segs;
    for (let i = 0; i < segs; i++) {
      const n = (i + 1) % segs;
      idx.push(0, bBase + n, bBase + i); // bottom cap
      idx.push(1, tBase + i, tBase + n); // top cap
      idx.push(bBase + i, bBase + n, tBase + i);
      idx.push(tBase + i, bBase + n, tBase + n);
    }
    return { positions: new Float32Array(verts), indices: new Uint16Array(idx) };
  });
}

function getSphereGeometry(): UnitGeometry {
  return cachedGeo('sphere', () => {
    const stacks = 6, slices = 8;
    const verts: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= stacks; i++) {
      const phi = (i / stacks) * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let j = 0; j <= slices; j++) {
        const theta = (j / slices) * Math.PI * 2;
        verts.push(sp * Math.cos(theta) * 0.5, sp * Math.sin(theta) * 0.5, cp * 0.5);
      }
    }
    const w = slices + 1;
    for (let i = 0; i < stacks; i++) {
      for (let j = 0; j < slices; j++) {
        const a = i * w + j, b = a + 1, c = a + w, d = c + 1;
        idx.push(a, c, b);
        idx.push(b, c, d);
      }
    }
    return { positions: new Float32Array(verts), indices: new Uint16Array(idx) };
  });
}

function getPrismGeometry(): UnitGeometry {
  return cachedGeo('prism', () => {
    // Isometric triangular prism
    const h = 0.5, r = 0.5;
    const verts: number[] = [];
    for (let z = -1; z <= 1; z += 2) {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        verts.push(Math.cos(a) * r, Math.sin(a) * r, z * h);
      }
    }
    const idx = new Uint16Array([
      0,2,1, 3,4,5, // caps
      0,1,4, 0,4,3, // sides
      1,2,5, 1,5,4,
      2,0,3, 2,3,5,
    ]);
    return { positions: new Float32Array(verts), indices: idx };
  });
}

// Right triangle prism (wedge) — right angle at vertex 0
function getWedgeGeometry(): UnitGeometry {
  return cachedGeo('wedge', () => {
    const verts = new Float32Array([
      // bottom face (z=-0.5): right triangle
      -0.5, -0.5, -0.5,  // 0: right-angle vertex
       0.5, -0.5, -0.5,  // 1
      -0.5,  0.5, -0.5,  // 2
      // top face (z=0.5)
      -0.5, -0.5,  0.5,  // 3
       0.5, -0.5,  0.5,  // 4
      -0.5,  0.5,  0.5,  // 5
    ]);
    const idx = new Uint16Array([
      0,2,1, 3,4,5,       // caps
      0,1,4, 0,4,3,       // front
      1,2,5, 1,5,4,       // hypotenuse
      2,0,3, 2,3,5,       // left side
    ]);
    return { positions: verts, indices: idx };
  });
}

// Cone (half-circle profile extruded linearly — tapers from circle base to point)
function getConeGeometry(): UnitGeometry {
  return cachedGeo('cone', () => {
    const segs = 12;
    const verts: number[] = [];
    const idx: number[] = [];
    // Apex at top
    verts.push(0, 0, 0.5); // 0: apex
    // Bottom center
    verts.push(0, 0, -0.5); // 1: base center
    // Bottom ring
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      verts.push(Math.cos(a) * 0.5, Math.sin(a) * 0.5, -0.5);
    }
    const bBase = 2;
    for (let i = 0; i < segs; i++) {
      const n = (i + 1) % segs;
      idx.push(1, bBase + n, bBase + i); // base cap
      idx.push(0, bBase + i, bBase + n); // side to apex
    }
    return { positions: new Float32Array(verts), indices: new Uint16Array(idx) };
  });
}

// Torus (circle profile revolved around circle path)
function getTorusGeometry(): UnitGeometry {
  return cachedGeo('torus', () => {
    const ringSegs = 12; // segments around the ring (path)
    const tubeSegs = 8;  // segments around the tube (profile)
    const R = 0.35;      // major radius (center of tube to center of torus)
    const r = 0.15;      // minor radius (tube radius)
    const verts: number[] = [];
    const idx: number[] = [];

    for (let i = 0; i <= ringSegs; i++) {
      const u = (i / ringSegs) * Math.PI * 2;
      const cu = Math.cos(u), su = Math.sin(u);
      for (let j = 0; j <= tubeSegs; j++) {
        const v = (j / tubeSegs) * Math.PI * 2;
        const cv = Math.cos(v), sv = Math.sin(v);
        verts.push(
          (R + r * cv) * cu,
          (R + r * cv) * su,
          r * sv,
        );
      }
    }
    const w = tubeSegs + 1;
    for (let i = 0; i < ringSegs; i++) {
      for (let j = 0; j < tubeSegs; j++) {
        const a = i * w + j, b = a + 1;
        const c = a + w, d = c + 1;
        idx.push(a, c, b);
        idx.push(b, c, d);
      }
    }
    return { positions: new Float32Array(verts), indices: new Uint16Array(idx) };
  });
}

// Tube (square profile revolved around circle path)
function getTubeGeometry(): UnitGeometry {
  return cachedGeo('tube', () => {
    const ringSegs = 12;
    const R = 0.35;       // major radius
    const halfW = 0.15;   // half-width of the square tube
    const verts: number[] = [];
    const idx: number[] = [];
    // 4 corners of square profile at each ring segment
    const profileOffsets = [
      [-halfW, -halfW], [halfW, -halfW], [halfW, halfW], [-halfW, halfW],
    ];
    for (let i = 0; i <= ringSegs; i++) {
      const u = (i / ringSegs) * Math.PI * 2;
      const cu = Math.cos(u), su = Math.sin(u);
      for (const [pr, pz] of profileOffsets) {
        verts.push((R + pr) * cu, (R + pr) * su, pz);
      }
    }
    const pn = profileOffsets.length; // 4 verts per ring
    for (let i = 0; i < ringSegs; i++) {
      const base = i * pn;
      const next = base + pn;
      for (let j = 0; j < pn; j++) {
        const j2 = (j + 1) % pn;
        idx.push(base + j, next + j, base + j2);
        idx.push(base + j2, next + j, next + j2);
      }
    }
    return { positions: new Float32Array(verts), indices: new Uint16Array(idx) };
  });
}

// Ring (triangle profile revolved around circle path)
function getRingGeometry(): UnitGeometry {
  return cachedGeo('ring', () => {
    const ringSegs = 12;
    const R = 0.35;
    const r = 0.18;
    const verts: number[] = [];
    const idx: number[] = [];
    // 3 corners of equilateral triangle profile
    const profileOffsets: [number, number][] = [];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 - Math.PI / 2;
      profileOffsets.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    for (let i = 0; i <= ringSegs; i++) {
      const u = (i / ringSegs) * Math.PI * 2;
      const cu = Math.cos(u), su = Math.sin(u);
      for (const [pr, pz] of profileOffsets) {
        verts.push((R + pr) * cu, (R + pr) * su, pz);
      }
    }
    const pn = 3;
    for (let i = 0; i < ringSegs; i++) {
      const base = i * pn;
      const next = base + pn;
      for (let j = 0; j < pn; j++) {
        const j2 = (j + 1) % pn;
        idx.push(base + j, next + j, base + j2);
        idx.push(base + j2, next + j, next + j2);
      }
    }
    return { positions: new Float32Array(verts), indices: new Uint16Array(idx) };
  });
}

// Hemisphere (half sphere, flat on bottom)
function getHemisphereGeometry(): UnitGeometry {
  return cachedGeo('hemi', () => {
    const stacks = 4, slices = 8;
    const verts: number[] = [];
    const idx: number[] = [];
    // Bottom center for cap
    verts.push(0, 0, 0); // vertex 0
    // Only upper hemisphere (phi from 0 to PI/2)
    for (let i = 0; i <= stacks; i++) {
      const phi = (i / stacks) * Math.PI / 2;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let j = 0; j <= slices; j++) {
        const theta = (j / slices) * Math.PI * 2;
        verts.push(sp * Math.cos(theta) * 0.5, sp * Math.sin(theta) * 0.5, cp * 0.5);
      }
    }
    const w = slices + 1;
    // Bottom cap: connect center to bottom ring (stack 4 = equator, widest)
    const eqBase = 1 + stacks * w; // equator ring start
    for (let j = 0; j < slices; j++) {
      idx.push(0, eqBase + j + 1, eqBase + j);
    }
    // Hemisphere surface
    for (let i = 0; i < stacks; i++) {
      for (let j = 0; j < slices; j++) {
        const a = 1 + i * w + j, b = a + 1, c = a + w, d = c + 1;
        idx.push(a, c, b);
        idx.push(b, c, d);
      }
    }
    return { positions: new Float32Array(verts), indices: new Uint16Array(idx) };
  });
}

// ─── Face index mapping for per-face colors ──────────────────────
// Maps triangle index to face index for each geometry type

function boxFaceIndex(triIdx: number): number {
  return Math.floor(triIdx / 2); // 2 tris per face, 6 faces: bottom,top,front,back,left,right
}

function cylinderFaceIndex(triIdx: number, segs: number): number {
  // Bottom cap: 0..segs-1, top cap: segs..2*segs-1, sides: 2*segs..4*segs-1
  if (triIdx < segs) return 0;       // bottom cap
  if (triIdx < segs * 2) return 1;   // top cap
  return 2;                            // sides
}

function sphereFaceIndex(_triIdx: number): number {
  return 0; // sphere is one face
}

function getFaceIndexFn(pathCurve: number, profileCurve: number): ((triIdx: number) => number) | undefined {
  const profileShape = profileCurve & 0x0F;
  if (pathCurve === 32 || pathCurve === 48) return sphereFaceIndex;
  if (profileShape === 1) return boxFaceIndex;
  if (profileShape === 0) return (triIdx: number) => cylinderFaceIndex(triIdx, 12);
  return undefined;
}

// ─── Parameterized geometry (hollow, cut, taper, twist) ──────────

interface ShapeParams {
  hollow?: number;   // 0-1
  begin?: number;    // 0-1
  end?: number;      // 0-1
  twist?: number;    // radians
  twistBegin?: number;
  taperX?: number;   // -1 to 1
  taperY?: number;
}

function hasShapeParams(p: ShapeParams): boolean {
  return (p.hollow != null && p.hollow > 0.01) ||
         (p.begin != null && p.begin > 0.01) ||
         (p.end != null && p.end < 0.99) ||
         (p.twist != null && Math.abs(p.twist) > 0.01) ||
         (p.taperX != null && Math.abs(p.taperX) > 0.01) ||
         (p.taperY != null && Math.abs(p.taperY) > 0.01);
}

// ─── Hollow / Path-cut geometry builders ──────────────────────────

/** Build hollow box geometry: outer shell + inner shell + annular caps */
function buildHollowBox(hollow: number): UnitGeometry {
  const inner = 0.5 * (1 - hollow);
  const o = 0.5; // outer half-extent
  const verts: number[] = [];
  const idx: number[] = [];

  // Outer box: 8 verts (0-7), bottom: 0-3, top: 4-7
  verts.push(-o, -o, -o);  // 0
  verts.push( o, -o, -o);  // 1
  verts.push( o,  o, -o);  // 2
  verts.push(-o,  o, -o);  // 3
  verts.push(-o, -o,  o);  // 4
  verts.push( o, -o,  o);  // 5
  verts.push( o,  o,  o);  // 6
  verts.push(-o,  o,  o);  // 7

  // Inner box: 8 verts (8-15), same layout but scaled inward on X/Y
  const n = inner;
  verts.push(-n, -n, -o);  // 8
  verts.push( n, -n, -o);  // 9
  verts.push( n,  n, -o);  // 10
  verts.push(-n,  n, -o);  // 11
  verts.push(-n, -n,  o);  // 12
  verts.push( n, -n,  o);  // 13
  verts.push( n,  n,  o);  // 14
  verts.push(-n,  n,  o);  // 15

  // Outer side faces
  idx.push(0, 5, 1, 0, 4, 5); // front (-Y)
  idx.push(2, 7, 3, 2, 6, 7); // back (+Y)
  idx.push(0, 3, 7, 0, 7, 4); // left (-X)
  idx.push(1, 5, 6, 1, 6, 2); // right (+X)

  // Inner side faces (reversed winding — facing inward)
  idx.push(8, 9, 13, 8, 13, 12);   // front inner
  idx.push(10, 11, 15, 10, 15, 14); // back inner
  idx.push(8, 12, 15, 8, 15, 11);   // left inner
  idx.push(9, 10, 14, 9, 14, 13);   // right inner

  // Bottom annulus (z = -0.5): outer edge to inner edge
  idx.push(0, 1, 9, 0, 9, 8);
  idx.push(1, 2, 10, 1, 10, 9);
  idx.push(2, 3, 11, 2, 11, 10);
  idx.push(3, 0, 8, 3, 8, 11);

  // Top annulus (z = 0.5): outer edge to inner edge
  idx.push(4, 12, 13, 4, 13, 5);
  idx.push(5, 13, 14, 5, 14, 6);
  idx.push(6, 14, 15, 6, 15, 7);
  idx.push(7, 15, 12, 7, 12, 4);

  return { positions: new Float32Array(verts), indices: new Uint16Array(idx) };
}

/** Build hollow and/or path-cut cylinder geometry */
function buildHollowCylinder(hollow: number, beginFrac: number, endFrac: number): UnitGeometry {
  const outerR = 0.5;
  const innerR = outerR * (1 - hollow);
  const hasHollow = hollow > 0.01;
  const hasCut = beginFrac > 0.01 || endFrac < 0.99;

  const theta0 = beginFrac * Math.PI * 2;
  const theta1 = endFrac * Math.PI * 2;
  const arcLen = theta1 - theta0;

  // Segment count scaled to arc length
  const fullSegs = 12;
  const segs = hasCut ? Math.max(3, Math.ceil(fullSegs * arcLen / (Math.PI * 2))) : fullSegs;

  const verts: number[] = [];
  const idx: number[] = [];

  // Outer bottom ring: verts [0 .. segs]
  for (let i = 0; i <= segs; i++) {
    const a = theta0 + (i / segs) * arcLen;
    verts.push(Math.cos(a) * outerR, Math.sin(a) * outerR, -0.5);
  }
  // Outer top ring: verts [otBase .. otBase+segs]
  const otBase = segs + 1;
  for (let i = 0; i <= segs; i++) {
    const a = theta0 + (i / segs) * arcLen;
    verts.push(Math.cos(a) * outerR, Math.sin(a) * outerR, 0.5);
  }

  // Outer wall quads
  for (let i = 0; i < segs; i++) {
    const ob0 = i, ob1 = i + 1;
    const ot0 = otBase + i, ot1 = otBase + i + 1;
    idx.push(ob0, ob1, ot0);
    idx.push(ot0, ob1, ot1);
  }

  if (hasHollow) {
    // Inner bottom ring
    const ibBase = verts.length / 3;
    for (let i = 0; i <= segs; i++) {
      const a = theta0 + (i / segs) * arcLen;
      verts.push(Math.cos(a) * innerR, Math.sin(a) * innerR, -0.5);
    }
    // Inner top ring
    const itBase = verts.length / 3;
    for (let i = 0; i <= segs; i++) {
      const a = theta0 + (i / segs) * arcLen;
      verts.push(Math.cos(a) * innerR, Math.sin(a) * innerR, 0.5);
    }

    // Inner wall (reversed winding)
    for (let i = 0; i < segs; i++) {
      const ib0 = ibBase + i, ib1 = ibBase + i + 1;
      const it0 = itBase + i, it1 = itBase + i + 1;
      idx.push(ib0, it0, ib1);
      idx.push(it0, it1, ib1);
    }

    // Bottom annulus: outer ring to inner ring
    for (let i = 0; i < segs; i++) {
      const ob0 = i, ob1 = i + 1;
      const ib0 = ibBase + i, ib1 = ibBase + i + 1;
      idx.push(ob0, ib0, ob1);
      idx.push(ob1, ib0, ib1);
    }

    // Top annulus: outer ring to inner ring
    for (let i = 0; i < segs; i++) {
      const ot0 = otBase + i, ot1 = otBase + i + 1;
      const it0 = itBase + i, it1 = itBase + i + 1;
      idx.push(ot0, ot1, it0);
      idx.push(it0, ot1, it1);
    }

    // Cut faces at theta0 and theta1 — stitch outer to inner
    if (hasCut) {
      idx.push(0, ibBase, itBase);
      idx.push(0, itBase, otBase);

      const oEnd = segs, otEnd = otBase + segs;
      const ibEnd = ibBase + segs, itEnd = itBase + segs;
      idx.push(oEnd, itEnd, ibEnd);
      idx.push(oEnd, otEnd, itEnd);
    }
  } else {
    // No hollow: solid caps with center vertex
    const bcIdx = verts.length / 3;
    verts.push(0, 0, -0.5);
    const tcIdx = verts.length / 3;
    verts.push(0, 0, 0.5);

    // Fan caps
    for (let i = 0; i < segs; i++) {
      idx.push(bcIdx, i + 1, i);                       // bottom
      idx.push(tcIdx, otBase + i, otBase + i + 1);     // top
    }

    if (hasCut) {
      // Radial cut face at theta0
      idx.push(bcIdx, 0, otBase);
      idx.push(bcIdx, otBase, tcIdx);
      // Radial cut face at theta1
      idx.push(bcIdx, tcIdx, otBase + segs);
      idx.push(bcIdx, otBase + segs, segs);
    }
  }

  return { positions: new Float32Array(verts), indices: new Uint16Array(idx) };
}

function getParameterizedGeometry(
  pathCurve: number, profileCurve: number, params: ShapeParams,
): UnitGeometry {
  const profileShape = profileCurve & 0x0F;

  // Only generate parameterized geometry if there are modifiers
  if (!hasShapeParams(params)) {
    return getUnitGeometry(pathCurve, profileCurve);
  }

  // Quantized cache key to prevent cache explosion
  const hq = Math.round((params.hollow ?? 0) * 20);
  const bq = Math.round((params.begin ?? 0) * 20);
  const eq = Math.round((params.end ?? 1) * 20);
  const twq = Math.round(((params.twist ?? 0) + Math.PI) * 5);
  const txq = Math.round(((params.taperX ?? 0) + 1) * 10);
  const tyq = Math.round(((params.taperY ?? 0) + 1) * 10);
  const key = `p|${pathCurve}|${profileShape}|${hq}|${bq}|${eq}|${twq}|${txq}|${tyq}`;

  return cachedGeo(key, () => {
    const hollowVal = params.hollow ?? 0;
    const beginVal = params.begin ?? 0;
    const endVal = params.end ?? 1;
    const needsHollow = hollowVal > 0.01;
    const needsCut = beginVal > 0.01 || endVal < 0.99;

    // Build from scratch for hollow/cut shapes on linear path (pathCurve=16)
    let positions: Float32Array;
    let indices: Uint16Array;

    if ((needsHollow || needsCut) && pathCurve === 16) {
      if (profileShape === 1 && needsHollow && !needsCut) {
        // Hollow box
        const geo = buildHollowBox(hollowVal);
        positions = new Float32Array(geo.positions);
        indices = new Uint16Array(geo.indices);
      } else if (profileShape === 0) {
        // Hollow and/or cut cylinder
        const geo = buildHollowCylinder(
          needsHollow ? hollowVal : 0,
          needsCut ? beginVal : 0,
          needsCut ? endVal : 1,
        );
        positions = new Float32Array(geo.positions);
        indices = new Uint16Array(geo.indices);
      } else {
        // Other shapes: fall back to clone+modify
        const base = getUnitGeometry(pathCurve, profileCurve);
        positions = new Float32Array(base.positions);
        indices = new Uint16Array(base.indices);
      }
    } else {
      // No hollow/cut or non-linear path: clone base geometry
      const base = getUnitGeometry(pathCurve, profileCurve);
      positions = new Float32Array(base.positions);
      indices = new Uint16Array(base.indices);
    }

    // Apply taper: scale X/Y based on Z position
    if (params.taperX || params.taperY) {
      const tx = params.taperX ?? 0;
      const ty = params.taperY ?? 0;
      for (let i = 0; i < positions.length; i += 3) {
        const z = positions[i + 2]; // -0.5 to 0.5
        const t = z + 0.5; // 0 to 1 (bottom to top)
        const scaleX = 1 - tx * t;
        const scaleY = 1 - ty * t;
        positions[i] *= scaleX;
        positions[i + 1] *= scaleY;
      }
    }

    // Apply twist: rotate X/Y around Z axis proportional to Z position
    if (params.twist || params.twistBegin) {
      const twEnd = params.twist ?? 0;
      const twBegin = params.twistBegin ?? 0;
      for (let i = 0; i < positions.length; i += 3) {
        const z = positions[i + 2];
        const t = z + 0.5; // 0 to 1
        const angle = twBegin + (twEnd - twBegin) * t;
        if (Math.abs(angle) > 0.001) {
          const cosA = Math.cos(angle), sinA = Math.sin(angle);
          const x = positions[i], y = positions[i + 1];
          positions[i] = x * cosA - y * sinA;
          positions[i + 1] = x * sinA + y * cosA;
        }
      }
    }

    return { positions, indices };
  });
}

function getUnitGeometry(pathCurve: number, profileCurve: number): UnitGeometry {
  // ProfileCurve encodes ProfileShape in low nibble, HoleType in high nibble
  const profileShape = profileCurve & 0x0F;

  // Circular path (revolved shapes): pathCurve=32 or 48
  if (pathCurve === 32 || pathCurve === 48) {
    if (profileShape === 5) return getSphereGeometry();     // half-circle revolved = sphere
    if (profileShape === 0) return getTorusGeometry();      // circle revolved = torus
    if (profileShape === 1) return getTubeGeometry();       // square revolved = tube
    if (profileShape === 2 || profileShape === 3 || profileShape === 4) return getRingGeometry(); // triangle revolved = ring
    return getTorusGeometry(); // fallback for circular path
  }

  // Linear path (extruded shapes): pathCurve=16 (default)
  if (profileShape === 0) return getCylinderGeometry();     // circle extruded = cylinder
  if (profileShape === 5) return getConeGeometry();         // half-circle extruded = cone
  if (profileShape === 1) return getBoxGeometry();          // square extruded = box
  if (profileShape === 2) return getPrismGeometry();        // isometric triangle
  if (profileShape === 3) return getPrismGeometry();        // equilateral triangle (same mesh)
  if (profileShape === 4) return getWedgeGeometry();        // right triangle = wedge
  // default: box
  return getBoxGeometry();
}

// Shared full-size raster target for object rendering (matches FP pixel buffer)
let objFullTarget: ReturnType<typeof createRasterTarget> | null = null;

// Reusable matrix buffers for object rendering
const _objView = new Float32Array(16);
const _objProj = new Float32Array(16);
const _objModel = new Float32Array(16);
const _objMV = new Float32Array(16);
const _objMVP = new Float32Array(16);
const _wsVP = new Float32Array(16);

function getObjFullTarget(pw: number, ph: number): ReturnType<typeof createRasterTarget> {
  if (!objFullTarget || objFullTarget.width !== pw || objFullTarget.height !== ph) {
    objFullTarget = createRasterTarget(pw, ph);
    objFullTarget.oids = new Array(pw * ph);
  }
  return objFullTarget;
}

function clearObjFullTarget(target: ReturnType<typeof createRasterTarget>): void {
  clearRasterTarget(target);
  if (target.oids) target.oids.fill(undefined);
}

/** Convert NDC depth to world distance (linearize perspective depth) */
function ndcDepthToWorldDist(ndcZ: number, near: number, far: number): number {
  return (2 * near * far) / (far + near - ndcZ * (far - near));
}

/** Convert world distance to NDC depth (inverse of ndcDepthToWorldDist) */
function worldDistToNdcDepth(dist: number, near: number, far: number): number {
  return (far + near - 2 * near * far / dist) / (far - near);
}

// ─── Triangle-based terrain renderer ──────────────────────────────
// Builds a triangle mesh from terrain heights around the camera and
// rasterizes it using the soft rasterizer with proper perspective.

// Reusable terrain raster target and matrix buffers
let terrainRasterTarget: ReturnType<typeof createRasterTarget> | null = null;
const _terrainView = new Float32Array(16);
const _terrainProj = new Float32Array(16);
const _terrainVP = new Float32Array(16);

function renderTerrainTriangles(
  buf: FPPixelBuffer, pw: number, ph: number,
  terrain: (x: number, y: number) => number,
  selfX: number, selfY: number, selfZ: number, yaw: number,
  waterHeight: number,
  fogColor: [number, number, number],
  maxDepth: number,
  fov: number,
  ditherPhase?: number,
  skipWater?: boolean,
  terrainTexture?: boolean,
  pitch?: number,
): void {
  // Ensure raster target matches FP pixel buffer size
  if (!terrainRasterTarget || terrainRasterTarget.width !== pw || terrainRasterTarget.height !== ph) {
    terrainRasterTarget = createRasterTarget(pw, ph);
  }
  clearRasterTarget(terrainRasterTarget);

  // Build view + projection matrices with pitch
  const p = pitch ?? 0;
  const fwdX = Math.cos(yaw) * Math.cos(p), fwdY = Math.sin(yaw) * Math.cos(p);
  const fwdZ = Math.sin(p); // negative pitch = look down
  const eye = [selfX, selfY, selfZ];
  const lookAt = [selfX + fwdX * 10, selfY + fwdY * 10, selfZ + fwdZ * 10];
  mat4LookAt(_terrainView, eye, lookAt, [0, 0, 1]);
  // Aspect ratio for perspective: pw/ph treats sextant pixels as square,
  // but terminal cells are ~1:2 (w:h). Each sextant pixel (cell/2 × cell/3)
  // is ~0.75:1 in display units, so the vertical extent is taller than
  // the pixel count implies. We compensate by widening vFov.
  const aspect = pw / ph;
  const CELL_RATIO = 0.75; // sextant pixel display width / height
  const vFov = 2 * Math.atan(Math.tan(fov / 2) / (aspect * CELL_RATIO));
  mat4Perspective(_terrainProj, vFov, aspect, 0.5, maxDepth);
  mat4Multiply(_terrainVP, _terrainProj, _terrainView);

  // Terrain mesh grid: sample around camera position
  // Use adaptive LOD: 1m cells near, 2m cells mid, 4m cells far, 8m cells ultra-far
  // When flying high, shift to coarser LOD (detail not visible from altitude)
  const altScale = Math.max(1, 1 + (Math.max(0, eye[2] - 30)) / 40); // 1 at ground, ~3 at 100m
  const NEAR_RADIUS = Math.round(24 * Math.min(altScale, 1.5));
  const MID_RADIUS = Math.round(48 * Math.min(altScale, 2));
  const FAR_RADIUS = Math.round(Math.min(maxDepth, 96 * altScale));

  // Generate terrain patches at different LODs
  // At altitude, use coarser base step (skip fine detail not visible from above)
  const baseStep = altScale > 1.5 ? 2 : 1;
  renderTerrainPatch(terrainRasterTarget, terrain, _terrainVP, selfX, selfY, waterHeight, fogColor, maxDepth, baseStep, NEAR_RADIUS, ditherPhase, skipWater, terrainTexture);
  renderTerrainPatch(terrainRasterTarget, terrain, _terrainVP, selfX, selfY, waterHeight, fogColor, maxDepth, baseStep * 2, MID_RADIUS, ditherPhase, skipWater, terrainTexture);
  renderTerrainPatch(terrainRasterTarget, terrain, _terrainVP, selfX, selfY, waterHeight, fogColor, maxDepth, baseStep * 4, FAR_RADIUS, ditherPhase, skipWater, terrainTexture);
  // Ultra-far ring for high altitude — 8m cells out to max depth
  if (maxDepth > 96) {
    renderTerrainPatch(terrainRasterTarget, terrain, _terrainVP, selfX, selfY, waterHeight, fogColor, maxDepth, 8, Math.round(maxDepth), ditherPhase, skipWater, terrainTexture);
  }

  // Copy rasterized terrain into the FP pixel buffer
  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      const si = (py * pw + px) * 4;
      if (terrainRasterTarget.color[si + 3] === 0) continue;
      const depth = terrainRasterTarget.depth[py * pw + px];
      // Convert NDC depth to approximate world distance for fog
      setFPPixel(buf, px, py,
        terrainRasterTarget.color[si],
        terrainRasterTarget.color[si + 1],
        terrainRasterTarget.color[si + 2],
        undefined, depth);
    }
  }
}

// Vertex smoothing for near-field terrain: average with 4 neighbors
function smoothedTerrain(terrain: (x: number, y: number) => number, x: number, y: number): number {
  const ix = Math.min(255, Math.max(0, Math.floor(x)));
  const iy = Math.min(255, Math.max(0, Math.floor(y)));
  const h = terrain(ix, iy);
  const n = terrain(ix, Math.min(255, iy + 1));
  const s = terrain(ix, Math.max(0, iy - 1));
  const e = terrain(Math.min(255, ix + 1), iy);
  const w = terrain(Math.max(0, ix - 1), iy);
  return h * 0.5 + (n + s + e + w) * 0.125;
}

// Reusable scratch buffers for terrain patch rendering (avoid per-cell allocation)
const _patchPositions = new Float32Array(12); // 4 vertices * 3 components
const _patchIndices = new Uint16Array([0, 1, 2, 1, 3, 2]); // constant quad indices

function renderTerrainPatch(
  target: ReturnType<typeof createRasterTarget>,
  terrain: (x: number, y: number) => number,
  vp: Float32Array,
  selfX: number, selfY: number,
  waterHeight: number,
  fogColor: [number, number, number],
  maxDepth: number,
  step: number,
  radius: number,
  ditherPhase?: number,
  skipWater?: boolean,
  terrainTexture?: boolean,
): void {
  // Grid centered on camera, snapped to step size
  const cx = Math.floor(selfX / step) * step;
  const cy = Math.floor(selfY / step) * step;
  const halfR = Math.floor(radius / step);

  // Terrain is in world coords — vp is the mvp (identity model matrix)

  const innerRadius = step > 1 ? radius * 0.45 : 0;
  const hasDither = ditherPhase !== undefined;

  // Rasterize each terrain cell as 2 triangles
  for (let dy = -halfR; dy < halfR; dy++) {
    for (let dx = -halfR; dx < halfR; dx++) {
      const wx = cx + dx * step;
      const wy = cy + dy * step;

      // Skip out-of-bounds
      if (wx < 0 || wx >= 255 || wy < 0 || wy >= 255) continue;

      // Skip cells in inner LOD range (already rendered at higher detail)
      if (innerRadius > 0) {
        const distX = Math.abs(wx + step / 2 - selfX);
        const distY = Math.abs(wy + step / 2 - selfY);
        if (distX < innerRadius && distY < innerRadius) continue;
      }

      // 4 corners of the cell — compute center-to-camera distance once
      const cdx = wx + step / 2 - selfX, cdy = wy + step / 2 - selfY;
      const distSq = cdx * cdx + cdy * cdy;
      let x0 = wx, y0 = wy;
      let x1 = Math.min(wx + step, 255), y1 = Math.min(wy + step, 255);

      // Triangle dither: tiny per-vertex wobble (~1% of cell) for subtle temporal info
      if (hasDither && distSq < 1600) { // 40*40 = 1600, skip sqrt for range check
        const dist0 = Math.sqrt(distSq);
        const jitter = step * 0.012 * (1 - dist0 / 40);
        if (jitter > 0.0001) {
          const ph = ditherPhase!;
          x0 += ditherNoise(wx, wy, ph) * jitter;
          y0 += ditherNoise(wy, wx, ph) * jitter;
          x1 += ditherNoise(wx + step, wy, ph) * jitter;
          y1 += ditherNoise(wy + step, wx + step, ph) * jitter;
        }
      }

      const ix0 = Math.min(255, Math.max(0, Math.floor(x0)));
      const iy0 = Math.min(255, Math.max(0, Math.floor(y0)));
      const h00 = step === 1 ? smoothedTerrain(terrain, ix0, iy0) : terrain(ix0, iy0);
      const h10 = step === 1 ? smoothedTerrain(terrain, x1, iy0) : terrain(x1, iy0);
      const h01 = step === 1 ? smoothedTerrain(terrain, ix0, y1) : terrain(ix0, y1);
      const h11 = step === 1 ? smoothedTerrain(terrain, x1, y1) : terrain(x1, y1);

      // Average height for coloring
      const hAvg = (h00 + h10 + h01 + h11) * 0.25;

      // Skip water cells in hybrid mode
      if (skipWater && hAvg < waterHeight) continue;

      const dist = Math.sqrt(distSq);
      const centerWx = wx + step / 2, centerWy = wy + step / 2;
      let [r, g, b] = terrainTexture
        ? terrainTexturedRGB(hAvg, waterHeight, centerWx, centerWy)
        : terrainRGB(hAvg, waterHeight);
      // Water surface tint
      if (hAvg < waterHeight) {
        [r, g, b] = [0x44, 0x88, 0xbb];
      }
      [r, g, b] = fogRGB(r, g, b, dist, maxDepth, fogColor);

      // Write vertex positions into reusable buffer
      _patchPositions[0] = x0; _patchPositions[1] = y0; _patchPositions[2] = h00;
      _patchPositions[3] = x1; _patchPositions[4] = y0; _patchPositions[5] = h10;
      _patchPositions[6] = x0; _patchPositions[7] = y1; _patchPositions[8] = h01;
      _patchPositions[9] = x1; _patchPositions[10] = y1; _patchPositions[11] = h11;

      rasterize(target, _patchPositions, _patchIndices, vp, r, g, b);
    }
  }
}

// Voxel water renderer for hybrid mode — only draws water surface
function renderVoxelWater(
  buf: FPPixelBuffer, pw: number, ph: number,
  terrain: (x: number, y: number) => number,
  selfX: number, selfY: number, selfZ: number, yaw: number,
  waterHeight: number,
  fogColor: [number, number, number],
  maxDepth: number,
  fov: number,
  horizon: number,
  ditherPhase: number,
  terrainTexture?: boolean,
  heightScale?: number,
): void {
  const HALF_FOV = fov / 2;
  const NEAR = 1;
  const CAMERA_HEIGHT = selfZ;
  const H_SCALE = heightScale ?? ph; // fall back to old behavior if not provided

  for (let pcol = 0; pcol < pw; pcol++) {
    const screenFrac = pcol / (pw - 1);
    const rayAngle = yaw + HALF_FOV - screenFrac * fov;
    const rayDirX = Math.cos(rayAngle);
    const rayDirY = Math.sin(rayAngle);
    const cosCorrection = Math.cos(rayAngle - yaw);

    let depth = NEAR;
    while (depth < maxDepth) {
      const wx = selfX + rayDirX * depth;
      const wy = selfY + rayDirY * depth;

      if (wx >= 0 && wx < 256 && wy >= 0 && wy < 256) {
        const ix = Math.floor(wx), iy = Math.floor(wy);
        const fx = wx - ix, fy = wy - iy;
        const ix1 = Math.min(ix + 1, 255), iy1 = Math.min(iy + 1, 255);
        const h00 = terrain(ix, iy), h10 = terrain(ix1, iy);
        const h01 = terrain(ix, iy1), h11 = terrain(ix1, iy1);
        const h = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy)
                + h01 * (1 - fx) * fy + h11 * fx * fy;

        // Only draw water pixels
        if (h < waterHeight) {
          const correctedDepth = depth * cosCorrection;
          const heightOnScreen = ((CAMERA_HEIGHT - waterHeight) / correctedDepth) * H_SCALE;
          const screenPy = Math.round(horizon + heightOnScreen);

          if (screenPy >= 0 && screenPy < ph) {
            // Check depth buffer — only write if closer
            const existingDepth = buf.depth[screenPy * pw + pcol];
            if (correctedDepth < existingDepth) {
              let [wr, wg, wb] = waterPixelRGB(h, waterHeight, wx, wy, depth);
              [wr, wg, wb] = fogRGB(wr, wg, wb, depth, maxDepth, fogColor);
              setFPPixel(buf, pcol, screenPy, wr, wg, wb, undefined, correctedDepth);

              // Fill water column below
              for (let py = screenPy + 1; py < ph; py++) {
                const exD = buf.depth[py * pw + pcol];
                if (correctedDepth >= exD) break;
                setFPPixel(buf, pcol, py, wr, wg, wb, undefined, correctedDepth);
              }
            }
          }
        }
      }

      depth += Math.max(0.4, depth * 0.04);
    }
  }

  // Horizon line for water continuity
  if (horizon >= 0 && horizon < ph) {
    const skyHorizon = fogColor;
    for (let pcol = 0; pcol < pw; pcol++) {
      const idx = horizon * pw + pcol;
      if (buf.depth[idx] === Infinity) {
        setFPPixel(buf, pcol, horizon, skyHorizon[0], skyHorizon[1], skyHorizon[2]);
      }
    }
  }
}

export function projectFirstPerson(
  terrain: (x: number, y: number) => number,
  avatars: AvatarData[],
  objects: ObjectData[],
  params: FirstPersonParams,
  cols: number,
  rows: number,
): GridFrame {
  const { yaw, waterHeight, ditherPhase, skyColors, sunDir, renderMode, terrainTexture, flying, terrainHeight, cameraMode, cameraOrbitYaw, cameraOrbitPitch, selfAvatarPos, cloudParams, cloudTime } = params;
  const isThirdPerson = cameraMode === 'third-person';

  // In third-person mode, offset camera behind and above the avatar
  // selfX/Y/Z from params is already at eye height (feet + 1.8m)
  // For helicopter view: pull camera 8m back and 6m up, tilt down
  // Camera orbit: yaw offset rotates camera position around the avatar
  let selfX: number, selfY: number, selfZ: number;
  const TP_BACK = 8;   // meters behind avatar
  const TP_UP = 5;     // meters above avatar eye height
  if (isThirdPerson) {
    const effectiveYaw = yaw + (cameraOrbitYaw ?? 0);
    const baseFwdX = Math.cos(effectiveYaw);
    const baseFwdY = Math.sin(effectiveYaw);
    selfX = params.selfX - baseFwdX * TP_BACK;
    selfY = params.selfY - baseFwdY * TP_BACK;
    selfZ = params.selfZ + TP_UP;
  } else {
    selfX = params.selfX;
    selfY = params.selfY;
    selfZ = params.selfZ;
  }

  const useTriangles = renderMode !== 'voxel' || isThirdPerson; // force triangles for third-person (voxel raycaster doesn't handle large pitch)
  const dither = ditherPhase !== undefined && ditherPhase > 0;

  // Sky colors from region environment, or defaults
  const skyZenith: [number, number, number] = skyColors?.zenith ?? SKY_RGB;
  const skyHorizon: [number, number, number] = skyColors?.horizon ?? HORIZON_RGB;
  // Fog color matches the horizon for natural fade
  const fogColor: [number, number, number] = skyHorizon;

  // Pixel buffer at 2x3 resolution (sextant characters: 2 wide x 3 tall per cell)
  const pw = cols * 2;
  const ph = rows * 3;
  const buf = getFPPixelBuffer(pw, ph);
  clearFPPixelBuffer(buf, skyZenith, skyHorizon);

  const camYaw = isThirdPerson ? yaw + (cameraOrbitYaw ?? 0) : yaw;
  const fwdX = Math.cos(camYaw);
  const fwdY = Math.sin(camYaw);
  const rightX = Math.sin(camYaw);
  const rightY = -Math.cos(camYaw);

  // Dynamic draw distance: extend when flying high (can see further from altitude)
  const altAboveTerrain = (terrainHeight != null) ? Math.max(0, selfZ - terrainHeight) : 0;
  const altAboveWater = Math.max(0, selfZ - waterHeight);
  const effectiveAlt = Math.max(altAboveTerrain, altAboveWater);
  // Scale draw distance: 96m at ground, up to 192m at 100m+ altitude
  const BASE_DEPTH = 96;
  const MAX_DEPTH = flying && effectiveAlt > 5
    ? Math.min(192, BASE_DEPTH + effectiveAlt * 1.5)
    : BASE_DEPTH;

  const FOV = isThirdPerson ? Math.PI / 2 : Math.PI / 3; // 90° third-person, 60° first-person
  const HALF_FOV = FOV / 2;
  if (cloudParams) renderCloudLayers(buf, cloudParams, yaw, FOV, cloudTime ?? 0);
  const NEAR = 1;
  const CAMERA_HEIGHT = selfZ;       // eye height in world

  // Vertical projection constant: maps world-space height/distance ratio to pixel rows
  // Matches the perspective matrix used by the triangle renderer
  const aspect = pw / ph;
  const CELL_RATIO = 0.75; // sextant pixel display w/h ratio (terminal cells ~1:2)
  const vFov = 2 * Math.atan(Math.tan(HALF_FOV) / (aspect * CELL_RATIO));
  const HEIGHT_SCALE = (ph / 2) / Math.tan(vFov / 2); // pixels per unit height at unit distance

  // Dynamic pitch: tilt camera down when flying high above terrain
  // At ground level: PITCH=0 (straight ahead)
  // At 20m above terrain: PITCH ≈ -0.2 rad (slight tilt)
  // At 100m+: PITCH ≈ -0.5 rad (strong downward tilt, ~28°)
  // Smoothly interpolated so it feels natural
  let PITCH = 0;
  if (isThirdPerson) {
    // Third-person helicopter cam: tilt down to look at avatar (~30° down)
    PITCH = -Math.atan2(TP_UP, TP_BACK) + (cameraOrbitPitch ?? 0);
    PITCH = Math.max(-Math.PI / 3, Math.min(Math.PI / 6, PITCH)); // clamp
  } else if (flying && effectiveAlt > 3) {
    // Sigmoid-like curve: ramps from 0 to -0.55 rad as altitude increases
    const t = Math.min(1, (effectiveAlt - 3) / 80); // 0→1 over 3-83m
    PITCH = -0.55 * t * t * (3 - 2 * t); // smoothstep
  }
  const HORIZON = Math.floor(ph / 2) - Math.round(PITCH * ph / FOV);

  if (useTriangles) {
    // ─── Triangle-based terrain rendering ───────────────────────────
    const triDither = dither ? ditherPhase : undefined;
    const isHybrid = renderMode === 'hybrid';
    renderTerrainTriangles(buf, pw, ph, terrain, selfX, selfY, selfZ, yaw, waterHeight, fogColor, MAX_DEPTH, FOV, triDither, isHybrid, terrainTexture, PITCH);

    if (isHybrid) {
      // Voxel water overlay for hybrid mode
      renderVoxelWater(buf, pw, ph, terrain, selfX, selfY, selfZ, yaw, waterHeight, fogColor, MAX_DEPTH, FOV, HORIZON, dither ? ditherPhase! : 0, terrainTexture, HEIGHT_SCALE);
    }
  } else {
    // ─── Comanche-style voxel space raycasting ───────────────────────

    // Per-pixel-column occlusion: highest (lowest py) drawn so far
    const topDrawn = new Int32Array(pw).fill(ph);

    // Cast one ray per pixel column
    for (let pcol = 0; pcol < pw; pcol++) {
      const screenFrac = pcol / (pw - 1);
      const rayAngle = yaw + HALF_FOV - screenFrac * FOV;
      const rayDirX = Math.cos(rayAngle);
      const rayDirY = Math.sin(rayAngle);
      const cosCorrection = Math.cos(rayAngle - yaw);

      let depth = NEAR;
      let prevScreenPy = ph;
      let prevH = 0;
      let prevDepth = NEAR;
      let prevInBounds = false;

      while (depth < MAX_DEPTH && topDrawn[pcol] > 0) {
        const wx = selfX + rayDirX * depth;
        const wy = selfY + rayDirY * depth;

        let sampleX = wx, sampleY = wy;
        if (dither) {
          const jitter = 0.15 * Math.max(0, 1 - depth / 30);
          if (jitter > 0.001) {
            sampleX += ditherNoise(wx, wy, ditherPhase!) * jitter;
            sampleY += ditherNoise(wy, wx, ditherPhase!) * jitter;
          }
        }

        if (sampleX >= 0 && sampleX < 256 && sampleY >= 0 && sampleY < 256) {
          const ix = Math.floor(sampleX), iy = Math.floor(sampleY);
          const fx = sampleX - ix, fy = sampleY - iy;
          const ix1 = Math.min(ix + 1, 255), iy1 = Math.min(iy + 1, 255);
          const h00 = terrain(ix, iy), h10 = terrain(ix1, iy);
          const h01 = terrain(ix, iy1), h11 = terrain(ix1, iy1);
          const h = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy)
                  + h01 * (1 - fx) * fy + h11 * fx * fy;

          const correctedDepth = depth * cosCorrection;
          const heightOnScreen = ((CAMERA_HEIGHT - h) / correctedDepth) * HEIGHT_SCALE;
          const screenPy = Math.round(HORIZON + heightOnScreen);

          let drawTop = screenPy;
          if (prevInBounds && prevScreenPy < topDrawn[pcol] && drawTop > prevScreenPy) {
            drawTop = prevScreenPy;
          }

          if (drawTop < topDrawn[pcol]) {
            const drawFrom = Math.max(0, drawTop);
            const drawTo = topDrawn[pcol];

            let [tr, tg, tb] = (h < waterHeight)
              ? waterPixelRGB(h, waterHeight, sampleX, sampleY, depth)
              : (terrainTexture ? terrainTexturedRGB(h, waterHeight, sampleX, sampleY) : terrainRGB(h, waterHeight));

            if (h >= waterHeight) {
              const gx = h10 - h00;
              const gy = h01 - h00;
              let shade: number;
              if (sunDir) {
                // Normal = (-gx, -gy, 1). Terrain slopes are small so |N| ≈ 1.
                // Skip sqrt: use unnormalized dot directly (error < 5% for slopes < 45°)
                const dot = -gx * sunDir[0] - gy * sunDir[1] + sunDir[2];
                shade = 0.55 + 0.45 * Math.max(0, Math.min(1, dot));
              } else {
                shade = 0.85 + 0.15 * Math.max(-1, Math.min(1, (-gx + gy) * 0.3));
              }
              tr = tr * shade + 0.5 | 0;
              tg = tg * shade + 0.5 | 0;
              tb = tb * shade + 0.5 | 0;
            }

            // Inline fog (avoid tuple allocation)
            const fogT = Math.min(1, depth / MAX_DEPTH);
            tr = tr + (fogColor[0] - tr) * fogT + 0.5 | 0;
            tg = tg + (fogColor[1] - tg) * fogT + 0.5 | 0;
            tb = tb + (fogColor[2] - tb) * fogT + 0.5 | 0;

            // Write pixel column directly (bounds already clamped above)
            const bufPixels = buf.pixels;
            const bufDepth = buf.depth;
            const spanLen = drawTo - drawFrom;
            if (spanLen > 1) {
              const invSpan = 1 / (spanLen - 1);
              for (let py = drawFrom; py < drawTo; py++) {
                const vShade = 1.08 - 0.16 * ((py - drawFrom) * invSpan);
                const idx = py * pw + pcol;
                const ci = idx * 4;
                bufPixels[ci]     = Math.min(255, tr * vShade + 0.5 | 0);
                bufPixels[ci + 1] = Math.min(255, tg * vShade + 0.5 | 0);
                bufPixels[ci + 2] = Math.min(255, tb * vShade + 0.5 | 0);
                bufPixels[ci + 3] = 255;
                bufDepth[idx] = correctedDepth;
              }
            } else {
              const idx = drawFrom * pw + pcol;
              const ci = idx * 4;
              bufPixels[ci] = tr; bufPixels[ci + 1] = tg;
              bufPixels[ci + 2] = tb; bufPixels[ci + 3] = 255;
              bufDepth[idx] = correctedDepth;
            }

            topDrawn[pcol] = drawFrom;
          }

          prevScreenPy = screenPy;
          prevH = h;
          prevDepth = depth;
          prevInBounds = true;
        } else {
          prevInBounds = false;
        }

        depth += Math.max(0.4, depth * 0.04);
      }
    }

    // Horizon line through remaining sky columns
    const horizonPy = HORIZON;
    if (horizonPy >= 0 && horizonPy < ph) {
      for (let pcol = 0; pcol < pw; pcol++) {
        if (topDrawn[pcol] > horizonPy) {
          setFPPixel(buf, pcol, horizonPy, skyHorizon[0], skyHorizon[1], skyHorizon[2]);
        }
      }
    }
  }

  // ─── Project world position to screen pixel coords ────────────
  // _wsVP is computed lazily after _objView/_objProj are populated
  let _wsVPReady = false;

  function worldToScreen(wx: number, wy: number, wz: number): { px: number; py: number; dist: number } | null {
    if (!_wsVPReady) {
      mat4Multiply(_wsVP, _objProj, _objView);
      _wsVPReady = true;
    }
    const dx = wx - selfX;
    const dy = wy - selfY;
    const forwardDist = dx * fwdX + dy * fwdY;
    if (forwardDist < NEAR || forwardDist > MAX_DEPTH) return null;

    // Transform through view-projection matrix
    const cx = _wsVP[0] * wx + _wsVP[4] * wy + _wsVP[8] * wz + _wsVP[12];
    const cy = _wsVP[1] * wx + _wsVP[5] * wy + _wsVP[9] * wz + _wsVP[13];
    const cw = _wsVP[3] * wx + _wsVP[7] * wy + _wsVP[11] * wz + _wsVP[15];
    if (cw <= 0) return null;

    const ndcX = cx / cw;
    const ndcY = cy / cw;
    // NDC: x in [-1,1] left to right, y in [-1,1] bottom to top
    const px = Math.round((ndcX + 1) * 0.5 * pw);
    const py = Math.round((1 - ndcY) * 0.5 * ph); // flip Y: screen top = 0
    if (px < 0 || px >= pw) return null;

    return { px, py, dist: forwardDist };
  }

  // Objects: near objects rendered as 3D shapes, far objects as tinted rectangles
  // Single-pass: compute distance, filter, and partition into near/far
  const nearObjRange = flying && effectiveAlt > 10 ? Math.min(80, 40 + effectiveAlt * 0.5) : 40;
  const sortedObjects: { obj: ObjectData; dist: number }[] = [];
  const nearObjects: { obj: ObjectData; dist: number }[] = [];
  const nearSet = new Set<string>();

  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    const dx = obj.x - selfX, dy = obj.y - selfY;
    const dist = dx * fwdX + dy * fwdY;
    if (dist <= NEAR || dist >= MAX_DEPTH) continue;
    const entry = { obj, dist };
    sortedObjects.push(entry);
    if (dist < nearObjRange && !obj.isTree) {
      nearObjects.push(entry);
    }
  }
  sortedObjects.sort((a, b) => b.dist - a.dist);

  // Cap near objects at 200, preferring closest
  if (nearObjects.length > 200) {
    nearObjects.sort((a, b) => a.dist - b.dist);
    nearObjects.length = 200;
  }
  for (const o of nearObjects) nearSet.add(o.obj.uuid);

  // Build shared view/projection for object rasterization (same frustum as terrain, with pitch)
  const objFwdX = Math.cos(yaw) * Math.cos(PITCH), objFwdY = Math.sin(yaw) * Math.cos(PITCH);
  const objFwdZ = Math.sin(PITCH);
  const objEye = [selfX, selfY, selfZ];
  const objLookAt = [selfX + objFwdX * 10, selfY + objFwdY * 10, selfZ + objFwdZ * 10];
  mat4LookAt(_objView, objEye, objLookAt, [0, 0, 1]);
  const vFovObj = 2 * Math.atan(Math.tan(FOV / 2) / (aspect * CELL_RATIO));
  mat4Perspective(_objProj, vFovObj, aspect, 0.5, MAX_DEPTH);

  // Rasterize all near objects into a single full-size target
  const objTarget = getObjFullTarget(pw, ph);
  clearObjFullTarget(objTarget);

  // Collect mesh UUIDs from visible objects for async download
  const sceneMeshLookup = params.sceneMeshLookup;
  const sceneMeshTrigger = params.sceneMeshTrigger;
  const meshUUIDsToFetch: string[] = [];

  for (const { obj, dist: forwardDist } of nearObjects) {
    // Skip nearly transparent objects
    if (obj.alpha !== undefined && obj.alpha < 0.1) continue;

    // Projected-size culling: estimate pixel height on screen
    const projectedH = Math.max(obj.scaleX, obj.scaleY, obj.scaleZ) / forwardDist * ph;
    if (projectedH < 2) {
      // Too small for rasterization — render as a few pixels directly (like far objects)
      const proj = worldToScreen(obj.x, obj.y, obj.z);
      if (proj) {
        const [or, og, ob] = fogRGB(obj.colorR, obj.colorG, obj.colorB, forwardDist, MAX_DEPTH, fogColor);
        for (let dy = -1; dy <= 0; dy++) {
          setFPPixel(buf, proj.px, proj.py + dy, or, og, ob, obj.uuid, forwardDist);
        }
      }
      continue;
    }

    // For objects projecting < 4 pixels, use simpler box geometry
    const useSimpleGeo = projectedH < 4;

    // Try mesh prim rendering first
    if (obj.meshUUID && sceneMeshLookup && !useSimpleGeo) {
      const meshes = sceneMeshLookup(obj.meshUUID);
      if (meshes && meshes.length > 0) {
        mat4ModelPosScaleRot(
          _objModel,
          obj.x, obj.y, obj.z,
          obj.scaleX, obj.scaleY, obj.scaleZ,
          obj.rotX, obj.rotY, obj.rotZ, obj.rotW,
        );
        mat4Multiply(_objMV, _objView, _objModel);
        mat4Multiply(_objMVP, _objProj, _objMV);
        let [fr, fg, fb] = fogRGB(obj.colorR, obj.colorG, obj.colorB, forwardDist, MAX_DEPTH, fogColor);
        if (obj.alpha !== undefined && obj.alpha < 1) {
          fr = Math.round(fr * obj.alpha);
          fg = Math.round(fg * obj.alpha);
          fb = Math.round(fb * obj.alpha);
        }
        for (const mesh of meshes) {
          rasterize(objTarget, mesh.positions, mesh.indices, _objMVP, fr, fg, fb, obj.uuid, obj.fullbright, undefined, undefined, sunDir);
        }
        continue; // skip prim fallback
      } else if (!meshes) {
        // Queue for download
        meshUUIDsToFetch.push(obj.meshUUID);
      }
    }

    // Use parameterized geometry if shape modifiers are present
    // For tiny projected objects (<4px), use a simple box instead of complex geometry
    let geo: UnitGeometry;
    if (useSimpleGeo) {
      geo = getBoxGeometry();
    } else {
      const shapeParams: ShapeParams = {
        hollow: obj.profileHollow,
        begin: obj.pathBegin,
        end: obj.pathEnd,
        twist: obj.pathTwist,
        twistBegin: obj.pathTwistBegin,
        taperX: obj.pathTaperX,
        taperY: obj.pathTaperY,
      };
      geo = hasShapeParams(shapeParams)
        ? getParameterizedGeometry(obj.pathCurve, obj.profileCurve, shapeParams)
        : getUnitGeometry(obj.pathCurve, obj.profileCurve);
    }

    mat4ModelPosScaleRot(
      _objModel,
      obj.x, obj.y, obj.z,
      obj.scaleX, obj.scaleY, obj.scaleZ,
      obj.rotX, obj.rotY, obj.rotZ, obj.rotW,
    );
    mat4Multiply(_objMV, _objView, _objModel);
    mat4Multiply(_objMVP, _objProj, _objMV);
    let [fr, fg, fb] = fogRGB(obj.colorR, obj.colorG, obj.colorB, forwardDist, MAX_DEPTH, fogColor);
    // Apply partial alpha
    if (obj.alpha !== undefined && obj.alpha < 1) {
      fr = Math.round(fr * obj.alpha);
      fg = Math.round(fg * obj.alpha);
      fb = Math.round(fb * obj.alpha);
    }

    // Per-face colors: fog each face color individually
    let foggedFaceColors: [number, number, number, number][] | undefined;
    const faceIdxFn = obj.faceColors ? getFaceIndexFn(obj.pathCurve, obj.profileCurve) : undefined;
    if (obj.faceColors && faceIdxFn) {
      foggedFaceColors = obj.faceColors.map(fc => {
        const [fcr, fcg, fcb] = fogRGB(fc[0], fc[1], fc[2], forwardDist, MAX_DEPTH, fogColor);
        return [fcr, fcg, fcb, fc[3]] as [number, number, number, number];
      });
    }

    rasterize(objTarget, geo.positions, geo.indices, _objMVP, fr, fg, fb, obj.uuid, obj.fullbright, foggedFaceColors, faceIdxFn, sunDir);
  }

  // Trigger mesh downloads for visible objects
  if (sceneMeshTrigger && meshUUIDsToFetch.length > 0) {
    sceneMeshTrigger(meshUUIDsToFetch);
  }

  // Copy rasterized object pixels to FP buffer with depth conversion
  const isVoxelMode = !useTriangles;
  const objColor = objTarget.color;
  const objDepth = objTarget.depth;
  const objOids = objTarget.oids;
  const bufPixels = buf.pixels;
  const bufDepth = buf.depth;
  const bufOids = buf.oids;
  const totalPx = pw * ph;
  for (let idx = 0; idx < totalPx; idx++) {
    const si = idx * 4;
    if (objColor[si + 3] === 0) continue;
    const ndcZ = objDepth[idx];
    const pixDepth = isVoxelMode ? ndcDepthToWorldDist(ndcZ, 0.5, MAX_DEPTH) : ndcZ;
    if (pixDepth >= bufDepth[idx]) continue;
    bufPixels[si]     = objColor[si];
    bufPixels[si + 1] = objColor[si + 1];
    bufPixels[si + 2] = objColor[si + 2];
    bufPixels[si + 3] = 255;
    bufDepth[idx] = pixDepth;
    if (objOids) bufOids[idx] = objOids[idx];
  }

  // Far/tree objects: tinted rectangles
  for (const { obj, dist: forwardDist } of sortedObjects) {
    if (nearSet.has(obj.uuid)) continue;
    if (obj.alpha !== undefined && obj.alpha < 0.1) continue;
    {
      const proj = worldToScreen(obj.x, obj.y, obj.z);
      if (!proj) continue;
      const { px: screenPx, py: screenPy } = proj;
      if (screenPy < 0 || screenPy >= ph) continue;

      // Use actual object color (or tree green for trees)
      const baseR = obj.isTree ? 0x33 : obj.colorR;
      const baseG = obj.isTree ? 0x66 : obj.colorG;
      const baseB = obj.isTree ? 0x33 : obj.colorB;
      const [or, og, ob] = fogRGB(baseR, baseG, baseB, forwardDist, MAX_DEPTH, fogColor);

      const entityPxH = Math.max(2, Math.round((obj.scaleZ || 2) / forwardDist * ph));
      const entityPxW = Math.max(2, Math.round((Math.max(obj.scaleX, obj.scaleY) || 1) / forwardDist * ph));
      const startPy = Math.max(0, screenPy - entityPxH + 1);
      const startPx = screenPx - Math.floor(entityPxW / 2);

      // In triangle mode, convert world distance to NDC depth for depth buffer compatibility
      const objPixDepth = useTriangles
        ? worldDistToNdcDepth(forwardDist, 0.5, MAX_DEPTH)
        : forwardDist;
      // Tree silhouettes for near-ish trees
      if (obj.isTree && forwardDist < 50) {
        renderTreePixels(buf, pw, ph, obj.treeSpecies, obj.pcode, screenPx, screenPy, entityPxH, or, og, ob, obj.uuid, objPixDepth);
      } else {
        for (let py = startPy; py <= screenPy && py < ph; py++) {
          for (let px = startPx; px < startPx + entityPxW && px < pw; px++) {
            setFPPixel(buf, px, py, or, og, ob, obj.uuid, objPixDepth);
          }
        }
      }
    }
  }

  // Avatars: try mesh rasterization, fall back to pixel silhouettes
  // Track screen positions for name labels
  const avatarScreenPos: { uuid: string; cellCol: number; shoulderRow: number; dist: number }[] = [];
  const meshLookup = params.meshLookup;
  const appearanceLookup = params.appearanceLookup;
  const bakedColorsLookup = params.bakedColorsLookup;
  for (const av of avatars) {
    if (av.isSelf && !isThirdPerson) continue;

    // Look up appearance data for height adjustment
    const appearance = appearanceLookup ? appearanceLookup(av.uuid) : null;
    const heightFactor = appearance ? lerp(1.1, 2.3, appearance.height / 255) / 1.8 : 1;
    const avatarHeight = 2 * heightFactor;

    const headProj = worldToScreen(av.x, av.y, av.z + avatarHeight);
    const feetProj = worldToScreen(av.x, av.y, av.z);
    if (!headProj && !feetProj) continue;

    const forwardDist = (headProj?.dist ?? feetProj!.dist);
    const screenPx = (headProj?.px ?? feetProj!.px);
    const headPy = headProj ? headProj.py : 0;
    const feetPy = feetProj ? feetProj.py : ph - 1;
    if (headPy >= ph || feetPy < 0) continue;

    const figH = Math.max(1, feetPy - headPy + 1);

    // Track screen position for name label (shoulder = ~30% down from head)
    const shoulderPy = headPy + Math.round(figH * 0.3);
    avatarScreenPos.push({
      uuid: av.uuid,
      cellCol: Math.floor(screenPx / 2),
      shoulderRow: Math.floor(shoulderPy / 3),
      dist: forwardDist,
    });

    // Try mesh rasterization
    let rendered = false;
    if (meshLookup && figH >= 6) {
      const bundle = meshLookup(av.uuid);
      if (bundle && bundle.meshes.length > 0) {
        rendered = renderMeshToPixels(
          buf, pw, ph, bundle,
          screenPx, headPy, figH,
          selfX, selfY, selfZ, yaw,
          av.x, av.y, av.z,
          forwardDist, av.uuid,
        );
      }
    }

    if (!rendered) {
      // Get baked texture colors or fall back to UUID-based color
      const bakedColors = bakedColorsLookup ? bakedColorsLookup(av.uuid) : null;
      const avBaseColor = bakedColors ? bakedColors.upperBody : avatarColorFromUUID(av.uuid);
      const [ar, ag, ab] = fogRGB(avBaseColor[0], avBaseColor[1], avBaseColor[2], forwardDist, MAX_DEPTH, fogColor);
      const velMag = Math.sqrt(av.velX * av.velX + av.velY * av.velY + av.velZ * av.velZ);
      // In triangle mode, depth buffer uses NDC values; convert world distance to NDC depth
      // Use slightly closer depth so avatar wins against terrain it stands on
      const avDepth = useTriangles
        ? worldDistToNdcDepth(forwardDist * 0.98, 0.5, MAX_DEPTH)
        : forwardDist * 0.98;
      renderPixelAvatar(buf, pw, ph, screenPx, headPy, figH, ar, ag, ab, av.uuid, avDepth, velMag, appearance, bakedColors, fogColor, MAX_DEPTH);
    }
  }

  // Convert pixel buffer to cells via quadrant blocks
  const { cells, cols: cellCols, rows: cellRows } = pixelsToCells(
    buf.pixels, pw, ph,
    SKY_RGB[0], SKY_RGB[1], SKY_RGB[2],
  );

  // Overlay OIDs from pixel buffer onto cells (2x3 sextant blocks)
  for (let cr = 0; cr < cellRows; cr++) {
    for (let cc = 0; cc < cellCols; cc++) {
      const px0 = cc * 2, py0 = cr * 3;
      let oid: string | undefined;
      for (let dy = 0; dy < 3 && !oid; dy++) {
        for (let dx = 0; dx < 2 && !oid; dx++) {
          const x = px0 + dx, y = py0 + dy;
          if (x < pw && y < ph) {
            oid = buf.oids[y * pw + x];
          }
        }
      }
      if (oid) cells[cr * cellCols + cc].oid = oid;
    }
  }

  // Overlay name labels and chat bubbles on the cell grid
  const avatarNames = params.avatarNames;
  const chatBubbles = params.chatBubbles;
  const now = Date.now();
  for (const asp of avatarScreenPos) {
    const name = avatarNames?.get(asp.uuid);
    if (!name) continue;

    // Build label: "Name" or "Name: message"
    let label = name;
    const bubble = chatBubbles?.get(asp.uuid);
    if (bubble && now - bubble.ts < 10000) {
      const msg = bubble.message.length > 30 ? bubble.message.slice(0, 27) + '...' : bubble.message;
      label = `${name}: ${msg}`;
    }

    // Place label to the right of the avatar at shoulder level
    const labelRow = Math.max(0, Math.min(cellRows - 1, asp.shoulderRow));
    const startCol = asp.cellCol + 2; // 2 cells right of avatar center
    if (startCol >= cellCols) continue;

    // Dim color based on distance
    const dimT = Math.min(1, asp.dist / MAX_DEPTH);
    const lr = Math.round(255 - dimT * 100);
    const lg = Math.round(255 - dimT * 100);
    const lb = Math.round(200 - dimT * 100);
    const labelFg = `#${lr.toString(16).padStart(2,'0')}${lg.toString(16).padStart(2,'0')}${lb.toString(16).padStart(2,'0')}`;

    for (let i = 0; i < label.length && startCol + i < cellCols; i++) {
      const ci = labelRow * cellCols + startCol + i;
      cells[ci] = { char: label[i], fg: labelFg, bg: cells[ci].bg, oid: asp.uuid };
    }
  }

  return { cells, cols: cellCols, rows: cellRows };
}

// Render a tree/grass silhouette into the FP pixel buffer
function renderTreePixels(
  buf: FPPixelBuffer, pw: number, ph: number,
  species: number, pcode: number,
  centerPx: number, basePy: number, figH: number,
  r: number, g: number, b: number, uuid: string, depth: number,
): void {
  if (figH < 2) {
    setFPPixel(buf, centerPx, basePy, r, g, b, uuid, depth);
    return;
  }

  // Grass (PCode=95): short vertical strokes
  if (pcode === 95) {
    const bladeCount = Math.max(2, Math.min(6, Math.round(figH * 0.8)));
    for (let i = 0; i < bladeCount; i++) {
      const bx = centerPx - Math.floor(bladeCount / 2) + i;
      const bladeH = Math.max(1, Math.round(figH * (0.5 + Math.sin(i * 2.3) * 0.3)));
      for (let dy = 0; dy < bladeH; dy++) {
        const shade = 0.8 + 0.2 * (1 - dy / bladeH);
        setFPPixel(buf, bx, basePy - dy, Math.round(r * shade), Math.round(g * shade), Math.round(b * shade), uuid, depth);
      }
    }
    return;
  }

  const trunkR = Math.max(0, r - 30), trunkG = Math.max(0, g - 40), trunkB = Math.max(0, b - 20);
  const trunkW = Math.max(1, Math.round(figH * 0.04));

  // Pine/Cypress (species 0,7,8,9,11,13): triangular/conical
  if (species === 0 || species === 7 || species === 8 || species === 9 || species === 11 || species === 13) {
    const trunkH = Math.round(figH * 0.25);
    const canopyH = figH - trunkH;
    // Trunk
    for (let dy = 0; dy < trunkH; dy++) {
      for (let dx = -trunkW; dx <= trunkW; dx++) {
        setFPPixel(buf, centerPx + dx, basePy - dy, trunkR, trunkG, trunkB, uuid, depth);
      }
    }
    // Conical canopy (widest at bottom, point at top)
    for (let dy = 0; dy < canopyH; dy++) {
      const t = dy / Math.max(1, canopyH - 1);
      const w = Math.max(1, Math.round((figH * 0.2) * (1 - t)));
      const shade = 0.7 + 0.3 * t;
      for (let dx = -w; dx <= w; dx++) {
        setFPPixel(buf, centerPx + dx, basePy - trunkH - dy,
          Math.round(r * shade), Math.round(g * shade), Math.round(b * shade), uuid, depth);
      }
    }
    return;
  }

  // Palm (species 3,6): tall trunk + fronds at top
  if (species === 3 || species === 6) {
    const trunkH = Math.round(figH * 0.7);
    const frondH = figH - trunkH;
    // Trunk
    for (let dy = 0; dy < trunkH; dy++) {
      for (let dx = -trunkW; dx <= trunkW; dx++) {
        setFPPixel(buf, centerPx + dx, basePy - dy, trunkR, trunkG, trunkB, uuid, depth);
      }
    }
    // Fronds (wider at center, taper to edges)
    const frondW = Math.max(2, Math.round(figH * 0.25));
    for (let dy = 0; dy < frondH; dy++) {
      const t = dy / Math.max(1, frondH - 1);
      const w = Math.round(frondW * (1 - Math.abs(t - 0.5) * 2));
      for (let dx = -w; dx <= w; dx++) {
        setFPPixel(buf, centerPx + dx, basePy - trunkH - dy, r, g, b, uuid, depth);
      }
    }
    return;
  }

  // Bush (species 2,5): short, wide
  if (species === 2 || species === 5) {
    const bushW = Math.max(2, Math.round(figH * 0.4));
    for (let dy = 0; dy < figH; dy++) {
      const t = dy / Math.max(1, figH - 1);
      const w = Math.round(bushW * Math.sin((t + 0.1) * Math.PI * 0.8));
      const shade = 0.75 + 0.25 * t;
      for (let dx = -w; dx <= w; dx++) {
        setFPPixel(buf, centerPx + dx, basePy - dy,
          Math.round(r * shade), Math.round(g * shade), Math.round(b * shade), uuid, depth);
      }
    }
    return;
  }

  // Default: Oak-style (species 1,10 and others) — round canopy on trunk
  const trunkH = Math.round(figH * 0.35);
  const canopyH = figH - trunkH;
  const canopyW = Math.max(2, Math.round(figH * 0.25));
  // Trunk
  for (let dy = 0; dy < trunkH; dy++) {
    for (let dx = -trunkW; dx <= trunkW; dx++) {
      setFPPixel(buf, centerPx + dx, basePy - dy, trunkR, trunkG, trunkB, uuid, depth);
    }
  }
  // Round canopy
  for (let dy = 0; dy < canopyH; dy++) {
    const t = dy / Math.max(1, canopyH - 1);
    const w = Math.round(canopyW * Math.sin((t + 0.1) * Math.PI * 0.9));
    const shade = 0.7 + 0.3 * t;
    for (let dx = -w; dx <= w; dx++) {
      setFPPixel(buf, centerPx + dx, basePy - trunkH - dy,
        Math.round(r * shade), Math.round(g * shade), Math.round(b * shade), uuid, depth);
    }
  }
}

// Render a humanoid pixel silhouette into the FP pixel buffer
function renderPixelAvatar(
  buf: FPPixelBuffer, pw: number, ph: number,
  centerPx: number, headPy: number, figH: number,
  r: number, g: number, b: number, uuid: string,
  avDepth: number,
  velMag = 0,
  appearance?: AvatarAppearanceData | null,
  bakedColors?: BakedTextureColors | null,
  fogColor?: [number, number, number],
  maxDepth?: number,
): void {
  if (figH <= 3) {
    // Tiny: just a dot
    for (let dy = 0; dy < figH; dy++) {
      setFPPixel(buf, centerPx, headPy + dy, r, g, b, uuid, avDepth);
    }
    return;
  }

  // Walking animation state
  const isWalking = velMag > 0.5;
  const walkFrame = isWalking ? (Date.now() % 600 < 300 ? 1 : -1) : 0;

  // Shape-morphed proportions from appearance data
  const hs = appearance ? lerp(0.8, 1.3, appearance.headSize / 255) : 1;
  const sw = appearance ? lerp(0.7, 1.4, appearance.shoulderWidth / 255) : 1;
  const hw = appearance ? lerp(0.7, 1.3, appearance.hipWidth / 255) : 1;
  const tl = appearance ? lerp(0.8, 1.2, appearance.torsoLength / 255) : 1;
  const bt = appearance ? lerp(0.85, 1.15, (appearance.bodyThickness ?? 128) / 255) : 1;

  // Proportional humanoid shape with more detail
  const headH = Math.max(2, Math.round(figH * 0.14 * hs));
  const neckH = Math.max(1, Math.round(figH * 0.03));
  const torsoH = Math.max(2, Math.round(figH * 0.32 * tl));
  const hipH = Math.max(1, Math.round(figH * 0.06));
  const legH = Math.max(1, figH - headH - neckH - torsoH - hipH);
  const headW = Math.max(1, Math.round(figH * 0.10 * hs));
  const neckW = Math.max(1, Math.round(headW * 0.5));
  const shoulderW = Math.max(2, Math.round(figH * 0.20 * sw * bt));
  const waistW = Math.max(1, Math.round(shoulderW * 0.7));
  const hipW = Math.max(1, Math.round(shoulderW * 0.85 * hw));
  const armW = Math.max(1, Math.round(figH * 0.05 * bt));
  const legW = Math.max(1, Math.round(figH * 0.06));

  // Zone-mapped colors from baked textures, or fallback to base color
  let skinR: number, skinG: number, skinB: number;
  let hairR: number, hairG: number, hairB: number;
  let upperR: number, upperG: number, upperB: number;
  let lowerR: number, lowerG: number, lowerB: number;

  if (bakedColors) {
    // Use baked texture colors with fog applied
    const md = maxDepth ?? 96;
    const fc = fogColor ?? [0x66, 0x77, 0x88];
    [skinR, skinG, skinB] = fogRGB(bakedColors.head[0], bakedColors.head[1], bakedColors.head[2], avDepth, md, fc);
    [hairR, hairG, hairB] = fogRGB(bakedColors.hair[0], bakedColors.hair[1], bakedColors.hair[2], avDepth, md, fc);
    [upperR, upperG, upperB] = fogRGB(bakedColors.upperBody[0], bakedColors.upperBody[1], bakedColors.upperBody[2], avDepth, md, fc);
    [lowerR, lowerG, lowerB] = fogRGB(bakedColors.lowerBody[0], bakedColors.lowerBody[1], bakedColors.lowerBody[2], avDepth, md, fc);
  } else if (appearance) {
    // Use skin color from visual params
    const sc = appearance.skinColor;
    const md = maxDepth ?? 96;
    const fc = fogColor ?? [0x66, 0x77, 0x88];
    [skinR, skinG, skinB] = fogRGB(sc[0], sc[1], sc[2], avDepth, md, fc);
    hairR = Math.max(0, skinR - 40);
    hairG = Math.max(0, skinG - 40);
    hairB = Math.max(0, skinB - 30);
    upperR = r; upperG = g; upperB = b;
    lowerR = Math.max(0, r - 10); lowerG = Math.max(0, g - 10); lowerB = Math.max(0, b - 8);
  } else {
    // Fallback: derive from base color
    skinR = Math.min(255, r + 60); skinG = Math.min(255, g + 45); skinB = Math.min(255, b + 35);
    hairR = Math.max(0, r - 20); hairG = Math.max(0, g - 20); hairB = Math.max(0, b - 15);
    upperR = r; upperG = g; upperB = b;
    lowerR = Math.max(0, r - 10); lowerG = Math.max(0, g - 10); lowerB = Math.max(0, b - 8);
  }

  // Shadow side (slightly darker body)
  const shadR = Math.max(0, upperR - 15), shadG = Math.max(0, upperG - 15), shadB = Math.max(0, upperB - 12);

  let py = headPy;

  // Head (oval: narrow top, wide middle, narrow chin)
  for (let dy = 0; dy < headH; dy++, py++) {
    const t = dy / Math.max(1, headH - 1);
    // Oval profile: wider in middle
    const w = Math.max(1, Math.round(headW * (1 - 1.5 * (t - 0.45) * (t - 0.45))));
    for (let dx = -w; dx <= w; dx++) {
      // Hair at top 30%, skin below
      const isHair = t < 0.3;
      const isShadow = dx > 0; // right side slightly darker (directional light)
      if (isHair) {
        setFPPixel(buf, centerPx + dx, py, hairR, hairG, hairB, uuid, avDepth);
      } else if (isShadow) {
        setFPPixel(buf, centerPx + dx, py, Math.max(0, skinR - 15), Math.max(0, skinG - 12), Math.max(0, skinB - 10), uuid, avDepth);
      } else {
        setFPPixel(buf, centerPx + dx, py, skinR, skinG, skinB, uuid, avDepth);
      }
    }
  }

  // Neck
  for (let dy = 0; dy < neckH; dy++, py++) {
    for (let dx = -neckW; dx <= neckW; dx++) {
      setFPPixel(buf, centerPx + dx, py, skinR, skinG, skinB, uuid, avDepth);
    }
  }

  // Torso (tapers from shoulders to waist) + arms — uses upperBody color
  const armStartDy = Math.round(torsoH * 0.05);
  const armEndDy = Math.round(torsoH * 0.55);
  for (let dy = 0; dy < torsoH && py < headPy + figH; dy++, py++) {
    const t = dy / Math.max(1, torsoH - 1);
    // Taper from shoulder to waist
    const tw = Math.round(shoulderW + (waistW - shoulderW) * t);
    for (let dx = -tw; dx <= tw; dx++) {
      const isShadow = dx > 0;
      if (isShadow) {
        setFPPixel(buf, centerPx + dx, py, shadR, shadG, shadB, uuid, avDepth);
      } else {
        setFPPixel(buf, centerPx + dx, py, upperR, upperG, upperB, uuid, avDepth);
      }
    }
    // Arms (swing opposite to legs when walking)
    if (dy >= armStartDy && dy < armEndDy) {
      const armLen = Math.max(1, Math.round(armW + (armEndDy - dy) * 0.2));
      for (let side = -1; side <= 1; side += 2) {
        // Arm swing: opposite direction to same-side leg
        const armSwing = isWalking ? -walkFrame * side * Math.min(1, Math.round(figH * 0.015)) : 0;
        for (let ax = 1; ax <= armLen; ax++) {
          const apx = centerPx + side * (tw + ax) + armSwing;
          const isForearm = dy > armStartDy + (armEndDy - armStartDy) * 0.6;
          if (isForearm) {
            setFPPixel(buf, apx, py, skinR, skinG, skinB, uuid, avDepth);
          } else {
            setFPPixel(buf, apx, py, shadR, shadG, shadB, uuid, avDepth);
          }
        }
      }
    }
  }

  // Hips (slightly wider, transition to legs) — uses lowerBody color
  const lShadR = Math.max(0, lowerR - 15), lShadG = Math.max(0, lowerG - 15), lShadB = Math.max(0, lowerB - 12);
  for (let dy = 0; dy < hipH && py < headPy + figH; dy++, py++) {
    for (let dx = -hipW; dx <= hipW; dx++) {
      setFPPixel(buf, centerPx + dx, py, lShadR, lShadG, lShadB, uuid, avDepth);
    }
  }

  // Legs (two separate columns that splay slightly) — uses lowerBody color
  for (let dy = 0; dy < legH && py < headPy + figH; dy++, py++) {
    const baseSplay = Math.min(dy, Math.round(figH * 0.04)) + 1;
    for (let side = -1; side <= 1; side += 2) {
      // Walking: alternate legs forward/back
      const walkOffset = walkFrame * side * Math.min(2, Math.round(figH * 0.03));
      const legSplay = baseSplay + (isWalking ? Math.abs(walkOffset) : 0);
      const legCenter = centerPx + side * legSplay + (isWalking ? walkOffset : 0);
      for (let dx = -legW; dx <= legW; dx++) {
        const isSkin = dy > legH * 0.7; // calves visible below pants
        if (isSkin) {
          setFPPixel(buf, legCenter + dx, py, skinR, skinG, skinB, uuid, avDepth);
        } else {
          setFPPixel(buf, legCenter + dx, py, lShadR - 5, lShadG - 5, lShadB - 5, uuid, avDepth);
        }
      }
    }
  }
}

// Attachment point offset table — body-relative offsets for common SL attachment points
const ATTACH_OFFSETS: Record<number, [number, number, number]> = {
  0:  [0, 0, 0],        // Default
  1:  [0, 0, 0.8],      // Chest
  2:  [0, 0, 1.6],      // Skull
  3:  [-0.25, 0, 0.75], // Left shoulder
  4:  [0.25, 0, 0.75],  // Right shoulder
  5:  [-0.35, 0, 0.3],  // Left hand
  6:  [0.35, 0, 0.3],   // Right hand
  7:  [-0.15, 0, -0.3], // Left foot
  8:  [0.15, 0, -0.3],  // Right foot
  9:  [0, 0.2, 0.7],    // Spine (back)
  10: [0, 0, 1.0],      // Pelvis
  11: [0, 0, 1.3],      // Mouth
  12: [0, 0, 1.45],     // Chin
  13: [0, 0, 1.55],     // Left ear
  14: [0, 0, 1.55],     // Right ear
  15: [-0.25, 0, 1.55], // Left eyeball
  16: [0.25, 0, 1.55],  // Right eyeball
  17: [0, 0, 1.6],      // Nose
  18: [0, 0, 1.4],      // R upper arm
  19: [0, 0, 0.5],      // R forearm
  20: [0, 0, 1.4],      // L upper arm
  21: [0, 0, 0.5],      // L forearm
  22: [0, 0, 0.2],      // R hip
  23: [-0.1, 0, -0.1],  // R upper leg
  24: [0, 0, 0.2],      // L hip
  25: [0.1, 0, -0.1],   // L upper leg
  26: [0, 0, 0.75],     // Stomach
  27: [-0.15, 0, 0.55], // Left pec
  28: [0.15, 0, 0.55],  // Right pec
  29: [0, 0, 1.65],     // Center 2 (head)
  30: [0, 0, 1.65],     // Top right (head)
  31: [0, 0, 1.65],     // Top left (head)
  39: [0, 0, 1.6],      // Neck
  40: [0, 0, 1.6],      // Avatar Center
};

// Rasterize 3D mesh into the FP pixel buffer at the avatar's screen position
function renderMeshToPixels(
  buf: FPPixelBuffer, pw: number, ph: number,
  bundle: AvatarMeshBundle,
  centerPx: number, headPy: number, figH: number,
  selfX: number, selfY: number, selfZ: number, yaw: number,
  avX: number, avY: number, avZ: number,
  avDepth: number, uuid: string,
): boolean {
  // Determine render size based on figure height
  const renderH = Math.min(figH * 2, MESH_PIXEL_H);
  const renderW = Math.min(Math.round(renderH * 0.5), MESH_PIXEL_W);

  const target = getMeshRasterTarget();
  clearRasterTarget(target);

  const fwdX = Math.cos(yaw), fwdY = Math.sin(yaw);
  const eye = [selfX, selfY, selfZ];
  const lookAt = [selfX + fwdX * 10, selfY + fwdY * 10, selfZ];

  const view = new Float32Array(16);
  mat4LookAt(view, eye, lookAt, [0, 0, 1]);

  const aspect = MESH_PIXEL_W / MESH_PIXEL_H;
  const proj = new Float32Array(16);
  mat4Perspective(proj, Math.PI / 3, aspect, 0.5, 100);

  const mv = new Float32Array(16);
  const mvp = new Float32Array(16);

  const meshColor = avatarColorFromUUID(uuid);
  const mr = Math.min(255, meshColor[0] + 80);
  const mg = Math.min(255, meshColor[1] + 60);
  const mb = Math.min(255, meshColor[2] + 40);

  const model = new Float32Array(16);
  for (const mesh of bundle.meshes) {
    // Apply attachment offset if available
    const ap = mesh.attachmentPoint ?? 0;
    const offset = ATTACH_OFFSETS[ap] ?? [0, 0, 0];
    mat4ModelPosScale(model, avX + offset[0], avY + offset[1], avZ + offset[2], 1.0);
    mat4Multiply(mv, view, model);
    mat4Multiply(mvp, proj, mv);
    rasterize(target, mesh.positions, mesh.indices, mvp, mr, mg, mb);
  }

  // Check if anything was drawn
  let hasPixels = false;
  for (let i = 3; i < target.color.length; i += 4) {
    if (target.color[i] > 0) { hasPixels = true; break; }
  }
  if (!hasPixels) return false;

  // Copy rasterized pixels into the FP buffer, scaled to fit figH
  const figW = Math.max(1, Math.round(figH * MESH_PIXEL_W / MESH_PIXEL_H));
  const startPx = centerPx - Math.floor(figW / 2);

  for (let dy = 0; dy < figH; dy++) {
    const dstPy = headPy + dy;
    if (dstPy < 0 || dstPy >= ph) continue;
    const srcY = Math.floor(dy * MESH_PIXEL_H / figH);
    for (let dx = 0; dx < figW; dx++) {
      const dstPx = startPx + dx;
      if (dstPx < 0 || dstPx >= pw) continue;
      const srcX = Math.floor(dx * MESH_PIXEL_W / figW);
      const srcIdx = (srcY * MESH_PIXEL_W + srcX) * 4;
      if (target.color[srcIdx + 3] === 0) continue; // transparent
      setFPPixel(buf, dstPx, dstPy, target.color[srcIdx], target.color[srcIdx + 1], target.color[srcIdx + 2], uuid, avDepth);
    }
  }

  return true;
}

export function diffFrames(prev: GridFrame, next: GridFrame): CellDelta[] {
  const deltas: CellDelta[] = [];
  const len = Math.min(prev.cells.length, next.cells.length);
  for (let i = 0; i < len; i++) {
    const p = prev.cells[i];
    const n = next.cells[i];
    if (p.char !== n.char || p.fg !== n.fg || p.bg !== n.bg || p.oid !== n.oid) {
      const row = Math.floor(i / next.cols);
      const col = i % next.cols;
      deltas.push({ idx: i, col, row, char: n.char, fg: n.fg, bg: n.bg, oid: n.oid });
    }
  }
  return deltas;
}
