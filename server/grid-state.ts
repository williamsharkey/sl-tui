// grid-state.ts — 3D-to-2D projection, Z-slice, terrain/object/avatar layers, diffing

import type { AvatarMeshBundle } from './avatar-cache.js';
import {
  createRasterTarget, clearRasterTarget, rasterize,
  mat4Multiply, mat4LookAt, mat4Perspective, mat4ModelPosScale,
  mat4ModelPosScaleRot,
} from './soft-rasterizer.js';
import { pixelsToCells } from './pixel-to-cells.js';

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

  // 1. Terrain layer — sample in rotated screen space
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Screen offset: sx = right, sy = forward (up on screen)
      const sx = (col - cols / 2) * metersPerCell;
      const sy = (rows / 2 - row) * metersPerCell;
      // Inverse-rotate back to world coords
      // sx = dx*sinY - dy*cosY, sy = dx*cosY + dy*sinY
      const simX = selfX + sx * sinY + sy * cosY;
      const simY = selfY - sx * cosY + sy * sinY;
      if (simX >= 0 && simX < 256 && simY >= 0 && simY < 256) {
        const h = terrain(Math.floor(simX), Math.floor(simY));
        frame.cells[row * cols + col] = terrainCell(h, waterHeight);
      } else {
        frame.cells[row * cols + col] = { char: ' ', fg: '#333333', bg: BG };
      }
    }
  }

  // 1b. Sim border overlay — draw border chars where adjacent cell crosses 0 or 256
  const BORDER_COLOR = '#cc6600';
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = (col - cols / 2) * metersPerCell;
      const sy = (rows / 2 - row) * metersPerCell;
      const simX = selfX + sx * sinY + sy * cosY;
      const simY = selfY - sx * cosY + sy * sinY;
      // Check if this cell is near a sim boundary (within 1 cell width)
      const nearBorderX = simX < metersPerCell || simX > 256 - metersPerCell;
      const nearBorderY = simY < metersPerCell || simY > 256 - metersPerCell;
      if (nearBorderX || nearBorderY) {
        // Only draw on the in-bounds side
        if (simX >= 0 && simX < 256 && simY >= 0 && simY < 256) {
          const idx = row * cols + col;
          const existing = frame.cells[idx];
          // Don't overwrite avatars/objects/self
          if (existing.char !== '@' && existing.char !== '#' && existing.char !== 'T' &&
              !'^v<>'.includes(existing.char)) {
            frame.cells[idx] = { char: '│', fg: BORDER_COLOR, bg: BG };
          }
        }
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

// Smooth lerp between terrain color stops — every unique height gets a unique color
function terrainRGB(height: number, waterHeight: number): [number, number, number] {
  const h = height - waterHeight;
  // Clamp to range
  if (h <= TERRAIN_STOPS[0][0]) return [TERRAIN_STOPS[0][1], TERRAIN_STOPS[0][2], TERRAIN_STOPS[0][3]];
  const last = TERRAIN_STOPS[TERRAIN_STOPS.length - 1];
  if (h >= last[0]) return [last[1], last[2], last[3]];
  // Find the two bracketing stops and lerp
  for (let i = 0; i < TERRAIN_STOPS.length - 1; i++) {
    const a = TERRAIN_STOPS[i], b = TERRAIN_STOPS[i + 1];
    if (h >= a[0] && h < b[0]) {
      const t = (h - a[0]) / (b[0] - a[0]);
      return [
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
        Math.round(a[3] + (b[3] - a[3]) * t),
      ];
    }
  }
  return [last[1], last[2], last[3]];
}

// Water surface pixel: add wavelet pattern
function waterPixelRGB(height: number, waterHeight: number, wx: number, wy: number, depth: number): [number, number, number] {
  const [br, bg, bb] = terrainRGB(height, waterHeight);
  // Cheap wave pattern using sin
  const wave = Math.sin(wx * 0.8 + wy * 0.3) * Math.cos(wy * 0.6 - wx * 0.2);
  const highlight = wave > 0.3 ? 30 : wave < -0.3 ? -15 : 0;
  return [
    Math.max(0, Math.min(255, br + highlight)),
    Math.max(0, Math.min(255, bg + highlight)),
    Math.max(0, Math.min(255, bb + highlight)),
  ];
}

// Procedural terrain texture: adds visual detail based on terrain zone
export function terrainTexturedRGB(height: number, waterHeight: number, wx: number, wy: number): [number, number, number] {
  let [r, g, b] = terrainRGB(height, waterHeight);
  const h = height - waterHeight;

  if (h >= 0.3 && h < 3) {
    // Sand: speckle
    const speckle = Math.sin(wx * 12.3) * Math.sin(wy * 11.7) * 8;
    r = Math.max(0, Math.min(255, r + speckle));
    g = Math.max(0, Math.min(255, g + speckle));
    b = Math.max(0, Math.min(255, b + speckle));
  } else if (h >= 3 && h < 25) {
    // Grass: clumpy noise
    const noise = Math.sin(wx * 4.3) * Math.cos(wy * 3.7);
    const variation = noise * 12;
    const darkPatch = noise < -0.5 ? -15 : 0;
    r = Math.max(0, Math.min(255, r + variation + darkPatch));
    g = Math.max(0, Math.min(255, g + variation + darkPatch));
    b = Math.max(0, Math.min(255, b + variation + darkPatch));
  } else if (h >= 35 && h < 90) {
    // Rock: horizontal streaks
    const streak = Math.sin(wx * 2.1 + wy * 7.8) * 15;
    r = Math.max(0, Math.min(255, r + streak));
    g = Math.max(0, Math.min(255, g + streak));
    b = Math.max(0, Math.min(255, b + streak));
  } else if (h >= 90) {
    // Snow: sparkle
    const sparkle = Math.sin(wx * 20.1) * Math.sin(wy * 19.3) > 0.7 ? 25 : 0;
    r = Math.max(0, Math.min(255, r + sparkle));
    g = Math.max(0, Math.min(255, g + sparkle));
    b = Math.max(0, Math.min(255, b + sparkle));
  }

  return [r, g, b];
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

// Apply depth fog to RGB
function fogRGB(r: number, g: number, b: number, depth: number, maxDepth: number, fog?: [number, number, number]): [number, number, number] {
  const t = Math.min(1, depth / maxDepth);
  const f = fog ?? FOG_RGB;
  return [
    Math.round(r + (f[0] - r) * t),
    Math.round(g + (f[1] - g) * t),
    Math.round(b + (f[2] - b) * t),
  ];
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
  const z = zenith ?? SKY_RGB;
  const h = horizon ?? HORIZON_RGB;
  const halfH = buf.ph / 2;
  for (let py = 0; py < buf.ph; py++) {
    // Gradient: zenith at top → horizon at middle → slightly below for lower sky
    const t = Math.min(1, py / halfH); // 0 at top, 1 at horizon
    const sr = Math.round(z[0] + (h[0] - z[0]) * t);
    const sg = Math.round(z[1] + (h[1] - z[1]) * t);
    const sb = Math.round(z[2] + (h[2] - z[2]) * t);
    for (let px = 0; px < buf.pw; px++) {
      const idx = py * buf.pw + px;
      const ci = idx * 4;
      buf.pixels[ci]     = sr;
      buf.pixels[ci + 1] = sg;
      buf.pixels[ci + 2] = sb;
      buf.pixels[ci + 3] = 255;
      buf.oids[idx] = undefined;
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
  ditherPhase?: number; // 0 = off, >0 = animated phase for spatial dither
  meshLookup?: (uuid: string) => AvatarMeshBundle | null;
  avatarNames?: Map<string, string>; // uuid → display name
  chatBubbles?: Map<string, ChatBubble>; // uuid → most recent chat
  skyColors?: { zenith: [number, number, number]; horizon: [number, number, number] };
  renderMode?: RenderMode; // 'voxel' (default) or 'triangle' or 'hybrid'
  terrainTexture?: boolean;
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

// Spatial noise for dither — high-frequency, low-amplitude textural drift
function ditherNoise(x: number, y: number, phase: number): [number, number] {
  // Four octaves of high-frequency sin-based noise, small displacement
  const s1 = Math.sin(x * 2.8 + phase * 1.3) * Math.cos(y * 3.6 + phase * 0.7);
  const s2 = Math.sin(y * 2.4 - phase * 1.1) * Math.cos(x * 3.2 - phase * 0.9);
  const s3 = Math.sin((x + y) * 1.6 + phase * 2.1) * 0.5;
  const s4 = Math.cos((x - y) * 2.0 + phase * 1.7) * 0.5;
  return [
    (s1 + s3) * 0.6, // dx offset in meters (half amplitude)
    (s2 + s4) * 0.6, // dy offset in meters
  ];
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

// ─── Triangle-based terrain renderer ──────────────────────────────
// Builds a triangle mesh from terrain heights around the camera and
// rasterizes it using the soft rasterizer with proper perspective.

// Reusable terrain raster target
let terrainRasterTarget: ReturnType<typeof createRasterTarget> | null = null;

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
): void {
  // Ensure raster target matches FP pixel buffer size
  if (!terrainRasterTarget || terrainRasterTarget.width !== pw || terrainRasterTarget.height !== ph) {
    terrainRasterTarget = createRasterTarget(pw, ph);
  }
  clearRasterTarget(terrainRasterTarget);

  // Build view + projection matrices
  const fwdX = Math.cos(yaw), fwdY = Math.sin(yaw);
  const eye = [selfX, selfY, selfZ];
  const lookAt = [selfX + fwdX * 10, selfY + fwdY * 10, selfZ];
  const view = new Float32Array(16);
  mat4LookAt(view, eye, lookAt, [0, 0, 1]);
  const aspect = pw / ph;
  const proj = new Float32Array(16);
  // Use vertical FOV derived from horizontal FOV and aspect ratio
  const vFov = 2 * Math.atan(Math.tan(fov / 2) / aspect);
  mat4Perspective(proj, vFov, aspect, 0.5, maxDepth);
  const vp = new Float32Array(16);
  mat4Multiply(vp, proj, view);

  // Terrain mesh grid: sample around camera position
  // Use adaptive LOD: 1m cells near, 2m cells mid, 4m cells far
  const NEAR_RADIUS = 24;   // 1m cells within 24m
  const MID_RADIUS = 48;    // 2m cells within 48m
  const FAR_RADIUS = 96;    // 4m cells within 96m

  // Generate terrain patches at different LODs
  renderTerrainPatch(terrainRasterTarget, terrain, vp, selfX, selfY, waterHeight, fogColor, maxDepth, 1, NEAR_RADIUS, ditherPhase, skipWater, terrainTexture);
  renderTerrainPatch(terrainRasterTarget, terrain, vp, selfX, selfY, waterHeight, fogColor, maxDepth, 2, MID_RADIUS, ditherPhase, skipWater, terrainTexture);
  renderTerrainPatch(terrainRasterTarget, terrain, vp, selfX, selfY, waterHeight, fogColor, maxDepth, 4, FAR_RADIUS, ditherPhase, skipWater, terrainTexture);

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

  // Identity model matrix (terrain is in world coords)
  const model = new Float32Array(16);
  model[0] = 1; model[5] = 1; model[10] = 1; model[15] = 1;
  const mvp = new Float32Array(16);
  mat4Multiply(mvp, vp, model);

  // Rasterize each terrain cell as 2 triangles
  for (let dy = -halfR; dy < halfR; dy++) {
    for (let dx = -halfR; dx < halfR; dx++) {
      const wx = cx + dx * step;
      const wy = cy + dy * step;

      // Skip out-of-bounds
      if (wx < 0 || wx >= 255 || wy < 0 || wy >= 255) continue;

      // Skip cells in inner LOD range (already rendered at higher detail)
      if (step > 1) {
        const distX = Math.abs(wx + step / 2 - selfX);
        const distY = Math.abs(wy + step / 2 - selfY);
        const innerRadius = step === 2 ? 24 : 48; // skip if covered by finer LOD
        if (distX < innerRadius && distY < innerRadius) continue;
      }

      // 4 corners of the cell
      let x0 = wx, y0 = wy;
      const x1 = Math.min(wx + step, 255), y1 = Math.min(wy + step, 255);

      // Triangle dither: small coordinate offset for subtle animation
      if (ditherPhase !== undefined) {
        const dist0 = Math.sqrt((wx - selfX) ** 2 + (wy - selfY) ** 2);
        const scale = 0.075 * Math.max(0, 1 - dist0 / 30);
        if (scale > 0.001) {
          const [ddx, ddy] = ditherNoise(wx * 0.6, wy * 0.6, ditherPhase);
          x0 += ddx * scale;
          y0 += ddy * scale;
        }
      }

      const h00 = terrain(Math.min(255, Math.max(0, Math.floor(x0))), Math.min(255, Math.max(0, Math.floor(y0))));
      const h10 = terrain(x1, Math.min(255, Math.max(0, Math.floor(y0))));
      const h01 = terrain(Math.min(255, Math.max(0, Math.floor(x0))), y1);
      const h11 = terrain(x1, y1);

      // Average height for coloring
      const hAvg = (h00 + h10 + h01 + h11) / 4;

      // Skip water cells in hybrid mode
      if (skipWater && hAvg < waterHeight) continue;

      const dist = Math.sqrt((wx + step / 2 - selfX) ** 2 + (wy + step / 2 - selfY) ** 2);
      const centerWx = wx + step / 2, centerWy = wy + step / 2;
      let [r, g, b] = terrainTexture
        ? terrainTexturedRGB(hAvg, waterHeight, centerWx, centerWy)
        : terrainRGB(hAvg, waterHeight);
      // Water surface tint
      if (hAvg < waterHeight) {
        [r, g, b] = [0x44, 0x88, 0xbb];
      }
      [r, g, b] = fogRGB(r, g, b, dist, maxDepth, fogColor);

      // Two triangles per cell
      const positions = new Float32Array([
        x0, y0, h00,
        x1, y0, h10,
        x0, y1, h01,
        x1, y1, h11,
      ]);
      const indices = new Uint16Array([
        0, 1, 2, // lower-left triangle
        1, 3, 2, // upper-right triangle
      ]);

      rasterize(target, positions, indices, mvp, r, g, b);
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
): void {
  const HALF_FOV = fov / 2;
  const NEAR = 1;
  const CAMERA_HEIGHT = selfZ;

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
          const heightOnScreen = ((CAMERA_HEIGHT - waterHeight) / correctedDepth) * ph;
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
  const { selfX, selfY, selfZ, yaw, waterHeight, ditherPhase, skyColors, renderMode, terrainTexture } = params;
  const useTriangles = renderMode !== 'voxel';
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

  const fwdX = Math.cos(yaw);
  const fwdY = Math.sin(yaw);
  const rightX = Math.sin(yaw);
  const rightY = -Math.cos(yaw);

  const MAX_DEPTH = 96;
  const FOV = Math.PI / 3;           // 60° horizontal FOV
  const HALF_FOV = FOV / 2;
  const NEAR = 1;
  const CAMERA_HEIGHT = selfZ;       // eye height in world
  const PITCH = 0;                   // look straight ahead (radians, + = up)
  const HORIZON = Math.floor(ph / 2) - Math.round(PITCH * ph / FOV);

  if (useTriangles) {
    // ─── Triangle-based terrain rendering ───────────────────────────
    const triDither = dither ? ditherPhase : undefined;
    const isHybrid = renderMode === 'hybrid';
    renderTerrainTriangles(buf, pw, ph, terrain, selfX, selfY, selfZ, yaw, waterHeight, fogColor, MAX_DEPTH, FOV, triDither, isHybrid, terrainTexture);

    if (isHybrid) {
      // Voxel water overlay for hybrid mode
      renderVoxelWater(buf, pw, ph, terrain, selfX, selfY, selfZ, yaw, waterHeight, fogColor, MAX_DEPTH, FOV, HORIZON, dither ? ditherPhase! : 0, terrainTexture);
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
          const scale = Math.max(0, 1 - depth / 30);
          if (scale > 0.01) {
            const [ddx, ddy] = ditherNoise(wx * 0.6, wy * 0.6, ditherPhase!);
            sampleX += ddx * scale;
            sampleY += ddy * scale;
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
          const heightOnScreen = ((CAMERA_HEIGHT - h) / correctedDepth) * ph;
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
              const shade = 0.85 + 0.15 * Math.max(-1, Math.min(1, (-gx + gy) * 0.3));
              tr = Math.round(tr * shade);
              tg = Math.round(tg * shade);
              tb = Math.round(tb * shade);
            }

            [tr, tg, tb] = fogRGB(tr, tg, tb, depth, MAX_DEPTH, fogColor);

            const spanLen = drawTo - drawFrom;
            for (let py = drawFrom; py < drawTo; py++) {
              if (spanLen > 1) {
                const vt = (py - drawFrom) / (spanLen - 1);
                const vShade = 1.08 - 0.16 * vt;
                setFPPixel(buf, pcol, py,
                  Math.min(255, Math.round(tr * vShade)),
                  Math.min(255, Math.round(tg * vShade)),
                  Math.min(255, Math.round(tb * vShade)),
                  undefined, correctedDepth);
              } else {
                setFPPixel(buf, pcol, py, tr, tg, tb, undefined, correctedDepth);
              }
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
  // Shared projection for objects and avatars
  function worldToScreen(wx: number, wy: number, wz: number): { px: number; py: number; dist: number } | null {
    const dx = wx - selfX;
    const dy = wy - selfY;
    const forwardDist = dx * fwdX + dy * fwdY;
    if (forwardDist < NEAR || forwardDist > MAX_DEPTH) return null;

    const lateralDist = dx * rightX + dy * rightY;
    // Perspective projection: positive lateral = right in world → right on screen (high px)
    const angleOffset = Math.atan2(lateralDist, forwardDist);
    const screenFrac = 0.5 + angleOffset / FOV;
    const px = Math.round(screenFrac * pw);
    if (px < 0 || px >= pw) return null;

    const heightOnScreen = ((CAMERA_HEIGHT - wz) / forwardDist) * ph;
    const py = Math.round(HORIZON + heightOnScreen);

    return { px, py, dist: forwardDist };
  }

  // Objects: near objects rendered as 3D shapes, far objects as tinted rectangles
  // Sort by distance (far first) for correct occlusion via depth buffer
  const sortedObjects = objects
    .map(obj => {
      const dx = obj.x - selfX, dy = obj.y - selfY;
      const dist = dx * fwdX + dy * fwdY;
      return { obj, dist };
    })
    .filter(o => o.dist > NEAR && o.dist < MAX_DEPTH)
    .sort((a, b) => b.dist - a.dist);

  // Near-object 3D rendering (closest 200 prims within 40m)
  const nearObjects = sortedObjects.filter(o => o.dist < 40 && !o.obj.isTree).slice(-200);
  const nearSet = new Set(nearObjects.map(o => o.obj.uuid));

  // Build shared view/projection for object rasterization (same frustum as terrain triangles)
  const objEye = [selfX, selfY, selfZ];
  const objLookAt = [selfX + fwdX * 10, selfY + fwdY * 10, selfZ];
  const objView = new Float32Array(16);
  mat4LookAt(objView, objEye, objLookAt, [0, 0, 1]);
  const aspect = pw / ph;
  const vFovObj = 2 * Math.atan(Math.tan(FOV / 2) / aspect);
  const objProj = new Float32Array(16);
  mat4Perspective(objProj, vFovObj, aspect, 0.5, MAX_DEPTH);
  const objModel = new Float32Array(16);
  const objMV = new Float32Array(16);
  const objMVP = new Float32Array(16);

  // Rasterize all near objects into a single full-size target
  const objTarget = getObjFullTarget(pw, ph);
  clearObjFullTarget(objTarget);

  for (const { obj, dist: forwardDist } of nearObjects) {
    // Skip nearly transparent objects
    if (obj.alpha !== undefined && obj.alpha < 0.1) continue;
    const geo = getUnitGeometry(obj.pathCurve, obj.profileCurve);
    mat4ModelPosScaleRot(
      objModel,
      obj.x, obj.y, obj.z + obj.scaleZ / 2,
      obj.scaleX, obj.scaleY, obj.scaleZ,
      obj.rotX, obj.rotY, obj.rotZ, obj.rotW,
    );
    mat4Multiply(objMV, objView, objModel);
    mat4Multiply(objMVP, objProj, objMV);
    let [fr, fg, fb] = fogRGB(obj.colorR, obj.colorG, obj.colorB, forwardDist, MAX_DEPTH, fogColor);
    // Apply partial alpha
    if (obj.alpha !== undefined && obj.alpha < 1) {
      fr = Math.round(fr * obj.alpha);
      fg = Math.round(fg * obj.alpha);
      fb = Math.round(fb * obj.alpha);
    }
    rasterize(objTarget, geo.positions, geo.indices, objMVP, fr, fg, fb, obj.uuid, obj.fullbright);
  }

  // Copy rasterized object pixels to FP buffer with depth conversion
  const isVoxelMode = !useTriangles;
  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      const si = (py * pw + px) * 4;
      if (objTarget.color[si + 3] === 0) continue;
      const idx = py * pw + px;
      const ndcZ = objTarget.depth[idx];
      // In voxel mode, FP buffer depth is world distance — linearize NDC depth
      const pixDepth = isVoxelMode ? ndcDepthToWorldDist(ndcZ, 0.5, MAX_DEPTH) : ndcZ;
      const oid = objTarget.oids ? objTarget.oids[idx] : undefined;
      setFPPixel(buf, px, py, objTarget.color[si], objTarget.color[si + 1], objTarget.color[si + 2], oid, pixDepth);
    }
  }

  // Far/tree objects: tinted rectangles
  for (const { obj, dist: forwardDist } of sortedObjects) {
    if (nearSet.has(obj.uuid)) continue;
    if (obj.alpha !== undefined && obj.alpha < 0.1) continue;
    {
      const proj = worldToScreen(obj.x, obj.y, obj.z + obj.scaleZ / 2);
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

      // Tree silhouettes for near-ish trees
      if (obj.isTree && forwardDist < 50) {
        renderTreePixels(buf, pw, ph, obj.treeSpecies, obj.pcode, screenPx, screenPy, entityPxH, or, og, ob, obj.uuid, forwardDist);
      } else {
        for (let py = startPy; py <= screenPy && py < ph; py++) {
          for (let px = startPx; px < startPx + entityPxW && px < pw; px++) {
            setFPPixel(buf, px, py, or, og, ob, obj.uuid, forwardDist);
          }
        }
      }
    }
  }

  // Avatars: try mesh rasterization, fall back to pixel silhouettes
  // Track screen positions for name labels
  const avatarScreenPos: { uuid: string; cellCol: number; shoulderRow: number; dist: number }[] = [];
  const meshLookup = params.meshLookup;
  for (const av of avatars) {
    if (av.isSelf) continue;

    const headProj = worldToScreen(av.x, av.y, av.z + 2);
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
      const avBaseColor = avatarColorFromUUID(av.uuid);
      const [ar, ag, ab] = fogRGB(avBaseColor[0], avBaseColor[1], avBaseColor[2], forwardDist, MAX_DEPTH, fogColor);
      const velMag = Math.sqrt(av.velX * av.velX + av.velY * av.velY + av.velZ * av.velZ);
      renderPixelAvatar(buf, pw, ph, screenPx, headPy, figH, ar, ag, ab, av.uuid, forwardDist, velMag);
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

  // Proportional humanoid shape with more detail
  const headH = Math.max(2, Math.round(figH * 0.14));
  const neckH = Math.max(1, Math.round(figH * 0.03));
  const torsoH = Math.max(2, Math.round(figH * 0.32));
  const hipH = Math.max(1, Math.round(figH * 0.06));
  const legH = Math.max(1, figH - headH - neckH - torsoH - hipH);
  const headW = Math.max(1, Math.round(figH * 0.10));
  const neckW = Math.max(1, Math.round(headW * 0.5));
  const shoulderW = Math.max(2, Math.round(figH * 0.20));
  const waistW = Math.max(1, Math.round(shoulderW * 0.7));
  const hipW = Math.max(1, Math.round(shoulderW * 0.85));
  const armW = Math.max(1, Math.round(figH * 0.05));
  const legW = Math.max(1, Math.round(figH * 0.06));

  // Skin tone (lighter shade of base)
  const skinR = Math.min(255, r + 60), skinG = Math.min(255, g + 45), skinB = Math.min(255, b + 35);
  // Hair (darker)
  const hairR = Math.max(0, r - 20), hairG = Math.max(0, g - 20), hairB = Math.max(0, b - 15);
  // Shadow side (slightly darker body)
  const shadR = Math.max(0, r - 15), shadG = Math.max(0, g - 15), shadB = Math.max(0, b - 12);

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

  // Torso (tapers from shoulders to waist) + arms
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
        setFPPixel(buf, centerPx + dx, py, r, g, b, uuid, avDepth);
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

  // Hips (slightly wider, transition to legs)
  for (let dy = 0; dy < hipH && py < headPy + figH; dy++, py++) {
    for (let dx = -hipW; dx <= hipW; dx++) {
      setFPPixel(buf, centerPx + dx, py, shadR, shadG, shadB, uuid, avDepth);
    }
  }

  // Legs (two separate columns that splay slightly)
  for (let dy = 0; dy < legH && py < headPy + figH; dy++, py++) {
    const baseSplay = Math.min(dy, Math.round(figH * 0.04)) + 1;
    for (let side = -1; side <= 1; side += 2) {
      // Walking: alternate legs forward/back
      const walkOffset = walkFrame * side * Math.min(2, Math.round(figH * 0.03));
      const legSplay = baseSplay + (isWalking ? Math.abs(walkOffset) : 0);
      const legCenter = centerPx + side * legSplay + (isWalking ? walkOffset : 0);
      for (let dx = -legW; dx <= legW; dx++) {
        const isSkin = dy > legH * 0.7;
        if (isSkin) {
          setFPPixel(buf, legCenter + dx, py, skinR, skinG, skinB, uuid, avDepth);
        } else {
          setFPPixel(buf, legCenter + dx, py, shadR - 5, shadG - 5, shadB - 5, uuid, avDepth);
        }
      }
    }
  }
}

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

  const model = new Float32Array(16);
  mat4ModelPosScale(model, avX, avY, avZ, 1.0);

  const mv = new Float32Array(16);
  const mvp = new Float32Array(16);
  mat4Multiply(mv, view, model);
  mat4Multiply(mvp, proj, mv);

  const meshColor = avatarColorFromUUID(uuid);
  const mr = Math.min(255, meshColor[0] + 80);
  const mg = Math.min(255, meshColor[1] + 60);
  const mb = Math.min(255, meshColor[2] + 40);
  for (const mesh of bundle.meshes) {
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
    if (p.char !== n.char || p.fg !== n.fg || p.bg !== n.bg) {
      const row = Math.floor(i / next.cols);
      const col = i % next.cols;
      deltas.push({ idx: i, col, row, char: n.char, fg: n.fg, bg: n.bg, oid: n.oid });
    }
  }
  return deltas;
}
