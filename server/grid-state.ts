// grid-state.ts — 3D-to-2D projection, Z-slice, terrain/object/avatar layers, diffing

import type { AvatarMeshBundle } from './avatar-cache.js';
import {
  createRasterTarget, clearRasterTarget, rasterize,
  mat4Multiply, mat4LookAt, mat4Perspective, mat4ModelPosScale,
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
            existing !== 'T') {
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

  // 2. Objects layer (skip tiny ones)
  for (const obj of objects) {
    const dz = Math.abs(obj.z - selfZ);
    if (dz >= 30) continue;
    const maxDim = Math.max(obj.scaleX, obj.scaleY, obj.scaleZ);
    if (maxDim < 0.5) continue;

    const pos = simToGridRotated(obj.x, obj.y, params, cosY, sinY);
    if (!pos) continue;

    let fg = obj.isTree ? COLORS.tree : COLORS.object;
    const ch = obj.isTree ? 'T' : '#';

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

// Terrain type → RGB base color
function terrainRGB(height: number, waterHeight: number): [number, number, number] {
  if (height < waterHeight - 2) return [0x22, 0x66, 0xaa]; // deep water
  if (height < waterHeight)     return [0x44, 0x88, 0xbb]; // water
  if (height < waterHeight + 1) return [0x99, 0x88, 0x66]; // beach
  if (height < waterHeight + 15) return [0x33, 0x66, 0x33]; // ground
  if (height < waterHeight + 40) return [0x66, 0x66, 0x33]; // hills
  return [0x66, 0x66, 0x66]; // mountains
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

// Apply depth fog to RGB
function fogRGB(r: number, g: number, b: number, depth: number, maxDepth: number): [number, number, number] {
  const t = Math.min(1, depth / maxDepth);
  return [
    Math.round(r + (FOG_RGB[0] - r) * t),
    Math.round(g + (FOG_RGB[1] - g) * t),
    Math.round(b + (FOG_RGB[2] - b) * t),
  ];
}

// Pixel buffer + OID buffer for FP rendering
interface FPPixelBuffer {
  pixels: Uint8Array;   // RGBA, (pw * ph * 4)
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
      oids: new Array(pw * ph),
      pw, ph,
    };
  }
  return fpPixBuf;
}

function clearFPPixelBuffer(buf: FPPixelBuffer): void {
  // Fill with sky color
  for (let i = 0; i < buf.pw * buf.ph; i++) {
    const ci = i * 4;
    buf.pixels[ci]     = SKY_RGB[0];
    buf.pixels[ci + 1] = SKY_RGB[1];
    buf.pixels[ci + 2] = SKY_RGB[2];
    buf.pixels[ci + 3] = 255;
    buf.oids[i] = undefined;
  }
}

// Set a pixel in the FP buffer
function setFPPixel(buf: FPPixelBuffer, px: number, py: number, r: number, g: number, b: number, oid?: string): void {
  if (px < 0 || px >= buf.pw || py < 0 || py >= buf.ph) return;
  const idx = py * buf.pw + px;
  const ci = idx * 4;
  buf.pixels[ci]     = r;
  buf.pixels[ci + 1] = g;
  buf.pixels[ci + 2] = b;
  buf.pixels[ci + 3] = 255;
  if (oid) buf.oids[idx] = oid;
}

export interface ChatBubble {
  message: string;
  ts: number; // timestamp when said
}

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
}

// Shared raster target for avatar mesh rendering — reused across frames
let meshRasterTarget: ReturnType<typeof createRasterTarget> | null = null;
const MESH_PIXEL_W = 32;  // pixels per avatar render (doubled via quadrant)
const MESH_PIXEL_H = 64;

function getMeshRasterTarget() {
  if (!meshRasterTarget || meshRasterTarget.width !== MESH_PIXEL_W || meshRasterTarget.height !== MESH_PIXEL_H) {
    meshRasterTarget = createRasterTarget(MESH_PIXEL_W, MESH_PIXEL_H);
  }
  return meshRasterTarget;
}

// Cheap spatial hash noise for dither — blobby, flowing, spatially coherent
function ditherNoise(x: number, y: number, phase: number): [number, number] {
  // Two octaves of sin-based spatial noise, phase-shifted for flow
  const s1 = Math.sin(x * 0.7 + phase * 1.3) * Math.cos(y * 0.9 + phase * 0.7);
  const s2 = Math.sin(y * 0.6 - phase * 1.1) * Math.cos(x * 0.8 - phase * 0.9);
  const s3 = Math.sin((x + y) * 0.4 + phase * 2.1) * 0.5;
  const s4 = Math.cos((x - y) * 0.5 + phase * 1.7) * 0.5;
  return [
    (s1 + s3) * 1.2, // dx offset in meters
    (s2 + s4) * 1.2, // dy offset in meters
  ];
}

export function projectFirstPerson(
  terrain: (x: number, y: number) => number,
  avatars: AvatarData[],
  objects: ObjectData[],
  params: FirstPersonParams,
  cols: number,
  rows: number,
): GridFrame {
  const { selfX, selfY, selfZ, yaw, waterHeight, ditherPhase } = params;
  const dither = ditherPhase !== undefined && ditherPhase > 0;

  // Pixel buffer at 2x resolution
  const pw = cols * 2;
  const ph = rows * 2;
  const buf = getFPPixelBuffer(pw, ph);
  clearFPPixelBuffer(buf);

  // ─── Comanche-style voxel space raycasting ───────────────────────
  // Each pixel column casts a ray from the camera through the view
  // frustum with proper perspective fan-out. Rays march front-to-back,
  // projecting terrain height via perspective division, and fill
  // vertical spans with depth-fogged terrain color.

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

  // Per-pixel-column occlusion: highest (lowest py) drawn so far
  const topDrawn = new Int32Array(pw).fill(ph);

  // Cast one ray per pixel column
  for (let pcol = 0; pcol < pw; pcol++) {
    // Ray angle: fan out across the screen
    // pcol=0 → left of screen → avatar's left → yaw + HALF_FOV (CCW)
    // pcol=pw → right of screen → avatar's right → yaw - HALF_FOV (CW)
    const screenFrac = pcol / (pw - 1);  // 0 to 1
    const rayAngle = yaw + HALF_FOV - screenFrac * FOV;
    const rayDirX = Math.cos(rayAngle);
    const rayDirY = Math.sin(rayAngle);

    // Cosine correction to prevent fisheye distortion
    const cosCorrection = Math.cos(rayAngle - yaw);

    // March along the ray front-to-back with adaptive step size
    let depth = NEAR;
    let stepSize = 0.5;

    while (depth < MAX_DEPTH && topDrawn[pcol] > 0) {
      const wx = selfX + rayDirX * depth;
      const wy = selfY + rayDirY * depth;

      // Apply dither noise at distance
      let sampleX = wx, sampleY = wy;
      if (dither) {
        const scale = Math.min(1, depth / 20);
        const [ddx, ddy] = ditherNoise(wx * 0.15, wy * 0.15, ditherPhase!);
        sampleX += ddx * scale;
        sampleY += ddy * scale;
      }

      if (sampleX >= 0 && sampleX < 256 && sampleY >= 0 && sampleY < 256) {
        const h = terrain(Math.floor(sampleX), Math.floor(sampleY));

        // Perspective project: screen Y from height difference and corrected depth
        const correctedDepth = depth * cosCorrection;
        const heightOnScreen = ((CAMERA_HEIGHT - h) / correctedDepth) * ph;
        const screenPy = Math.round(HORIZON + heightOnScreen);

        if (screenPy < topDrawn[pcol]) {
          const drawFrom = Math.max(0, screenPy);
          const drawTo = topDrawn[pcol];

          let [tr, tg, tb] = (h < waterHeight)
            ? waterPixelRGB(h, waterHeight, sampleX, sampleY, depth)
            : terrainRGB(h, waterHeight);
          [tr, tg, tb] = fogRGB(tr, tg, tb, depth, MAX_DEPTH);

          for (let py = drawFrom; py < drawTo; py++) {
            setFPPixel(buf, pcol, py, tr, tg, tb);
          }

          topDrawn[pcol] = drawFrom;
        }
      }

      // Adaptive step: smaller steps close, larger far away
      depth += stepSize;
      if (depth > 8) stepSize = 1;
      if (depth > 30) stepSize = 2;
      if (depth > 60) stepSize = 3;
    }
  }

  // Horizon line through remaining sky columns
  const horizonPy = HORIZON;
  if (horizonPy >= 0 && horizonPy < ph) {
    for (let pcol = 0; pcol < pw; pcol++) {
      if (topDrawn[pcol] > horizonPy) {
        setFPPixel(buf, pcol, horizonPy, HORIZON_RGB[0], HORIZON_RGB[1], HORIZON_RGB[2]);
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

  // Objects (rendered as pixel rectangles with perspective sizing)
  for (const obj of objects) {
    const proj = worldToScreen(obj.x, obj.y, obj.z + obj.scaleZ / 2);
    if (!proj) continue;
    const { px: screenPx, py: screenPy, dist: forwardDist } = proj;
    if (screenPy < 0 || screenPy >= ph) continue;
    if (screenPy >= topDrawn[Math.max(0, Math.min(pw - 1, screenPx))]) continue;

    const baseRGB: [number, number, number] = obj.isTree ? [0x33, 0x66, 0x33] : [0x88, 0x55, 0x22];
    const [or, og, ob] = fogRGB(baseRGB[0], baseRGB[1], baseRGB[2], forwardDist, MAX_DEPTH);

    const entityPxH = Math.max(2, Math.round((obj.scaleZ || 2) / forwardDist * ph));
    const entityPxW = Math.max(2, Math.round((Math.max(obj.scaleX, obj.scaleY) || 1) / forwardDist * ph));
    const startPy = Math.max(0, screenPy - entityPxH + 1);
    const startPx = screenPx - Math.floor(entityPxW / 2);

    for (let py = startPy; py <= screenPy && py < ph; py++) {
      for (let px = startPx; px < startPx + entityPxW && px < pw; px++) {
        if (px < 0 || px >= pw) continue;
        if (py >= topDrawn[px]) continue;
        setFPPixel(buf, px, py, or, og, ob, obj.uuid);
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
      shoulderRow: Math.floor(shoulderPy / 2),
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
          topDrawn, av.uuid,
        );
      }
    }

    if (!rendered) {
      const [ar, ag, ab] = fogRGB(0x30, 0x30, 0x30, forwardDist, MAX_DEPTH);
      renderPixelAvatar(buf, pw, ph, screenPx, headPy, figH, ar, ag, ab, av.uuid, topDrawn);
    }
  }

  // Convert pixel buffer to cells via quadrant blocks
  const { cells, cols: cellCols, rows: cellRows } = pixelsToCells(
    buf.pixels, pw, ph,
    SKY_RGB[0], SKY_RGB[1], SKY_RGB[2],
  );

  // Overlay OIDs from pixel buffer onto cells
  // For each cell, pick the OID from the most prominent non-undefined pixel
  for (let cr = 0; cr < cellRows; cr++) {
    for (let cc = 0; cc < cellCols; cc++) {
      const px0 = cc * 2, py0 = cr * 2;
      let oid: string | undefined;
      for (let dy = 0; dy < 2 && !oid; dy++) {
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

// Render a humanoid pixel silhouette into the FP pixel buffer
function renderPixelAvatar(
  buf: FPPixelBuffer, pw: number, ph: number,
  centerPx: number, headPy: number, figH: number,
  r: number, g: number, b: number, uuid: string,
  topDrawn: Int32Array,
): void {
  if (figH <= 2) {
    // Tiny: just a dot
    for (let dy = 0; dy < figH; dy++) {
      const py = headPy + dy;
      if (py >= 0 && py < ph && centerPx >= 0 && centerPx < pw && py < topDrawn[centerPx]) {
        setFPPixel(buf, centerPx, py, r, g, b, uuid);
      }
    }
    return;
  }

  // Proportional humanoid shape
  const headH = Math.max(1, Math.round(figH * 0.15));
  const headW = Math.max(1, Math.round(figH * 0.12));
  const torsoH = Math.max(1, Math.round(figH * 0.35));
  const torsoW = Math.max(1, Math.round(figH * 0.18));
  const armW = Math.max(0, Math.round(figH * 0.12));
  const legH = figH - headH - torsoH;
  const legW = Math.max(1, Math.round(figH * 0.08));

  let py = headPy;

  // Head (circle-ish: narrower at top/bottom)
  for (let dy = 0; dy < headH; dy++, py++) {
    const w = dy === 0 || dy === headH - 1 ? Math.max(1, headW - 1) : headW;
    for (let dx = -w; dx <= w; dx++) {
      const px = centerPx + dx;
      if (py >= 0 && py < ph && px >= 0 && px < pw && py < topDrawn[px]) {
        setFPPixel(buf, px, py, r + 20, g + 15, b + 10, uuid); // slightly lighter head
      }
    }
  }

  // Torso + arms
  const armRow = py + Math.floor(torsoH * 0.3);
  for (let dy = 0; dy < torsoH && py < headPy + figH; dy++, py++) {
    // Torso
    for (let dx = -torsoW; dx <= torsoW; dx++) {
      const px = centerPx + dx;
      if (py >= 0 && py < ph && px >= 0 && px < pw && py < topDrawn[px]) {
        setFPPixel(buf, px, py, r, g, b, uuid);
      }
    }
    // Arms (at arm row, extending out)
    if (py >= armRow && py < armRow + Math.max(1, Math.round(torsoH * 0.4))) {
      for (let side = -1; side <= 1; side += 2) {
        for (let ax = 1; ax <= armW; ax++) {
          const px = centerPx + side * (torsoW + ax);
          if (py >= 0 && py < ph && px >= 0 && px < pw && py < topDrawn[px]) {
            setFPPixel(buf, px, py, r - 10, g - 10, b - 10, uuid);
          }
        }
      }
    }
  }

  // Legs (two columns with gap)
  for (let dy = 0; dy < legH && py < headPy + figH; dy++, py++) {
    const gap = Math.min(dy, Math.round(figH * 0.05)) + 1;
    for (let side = -1; side <= 1; side += 2) {
      const legCenter = centerPx + side * gap;
      for (let dx = -legW; dx <= legW; dx++) {
        const px = legCenter + dx;
        if (py >= 0 && py < ph && px >= 0 && px < pw && py < topDrawn[px]) {
          setFPPixel(buf, px, py, r - 5, g - 5, b - 5, uuid);
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
  topDrawn: Int32Array, uuid: string,
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

  for (const mesh of bundle.meshes) {
    rasterize(target, mesh.positions, mesh.indices, mvp, 180, 160, 140);
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
      if (dstPy >= topDrawn[dstPx]) continue;
      const srcX = Math.floor(dx * MESH_PIXEL_W / figW);
      const srcIdx = (srcY * MESH_PIXEL_W + srcX) * 4;
      if (target.color[srcIdx + 3] === 0) continue; // transparent
      setFPPixel(buf, dstPx, dstPy, target.color[srcIdx], target.color[srcIdx + 1], target.color[srcIdx + 2], uuid);
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
