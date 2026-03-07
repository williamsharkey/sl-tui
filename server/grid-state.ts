// grid-state.ts — 3D-to-2D projection, Z-slice, terrain/object/avatar layers, diffing

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
}

// Convert sim coords to grid coords, centered on self
function simToGrid(
  simX: number, simY: number,
  params: ProjectionParams
): { col: number; row: number } | null {
  const halfCols = params.cols / 2;
  const halfRows = params.rows / 2;
  const dx = simX - params.selfX;
  const dy = simY - params.selfY;
  const col = Math.round(halfCols + dx / params.metersPerCell);
  // Y is inverted: north (higher Y) = lower row index (top of screen)
  const row = Math.round(halfRows - dy / params.metersPerCell);
  if (col < 0 || col >= params.cols || row < 0 || row >= params.rows) return null;
  return { col, row };
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

export function projectFrame(
  terrain: (x: number, y: number) => number,
  avatars: AvatarData[],
  objects: ObjectData[],
  params: ProjectionParams,
  flying: boolean,
): GridFrame {
  const { cols, rows, selfX, selfY, selfZ, waterHeight, metersPerCell } = params;
  const frame = createEmptyFrame(cols, rows);

  // 1. Terrain layer
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const simX = selfX + (col - cols / 2) * metersPerCell;
      const simY = selfY + (rows / 2 - row) * metersPerCell;
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

    const pos = simToGrid(obj.x, obj.y, params);
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
    const dz = Math.abs(av.z - selfZ);
    if (dz >= 30) continue;

    const pos = simToGrid(av.x, av.y, params);
    if (!pos) continue;

    const ch = yawToDirectionChar(av.yaw);
    let fg = COLORS.avatar;
    if (dz >= 10) fg = COLORS.faint;
    else if (dz >= 3) fg = COLORS.dimmed;

    const idx = pos.row * cols + pos.col;
    frame.cells[idx] = { char: ch, fg, bg: BG, oid: av.uuid };
  }

  // 4. Flying shadow
  if (flying && selfZ > waterHeight + 5) {
    const selfGrid = simToGrid(selfX, selfY, params);
    if (selfGrid) {
      const idx = selfGrid.row * cols + selfGrid.col;
      // Only place shadow if self won't overwrite it (self always at center anyway)
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

  // 5b. FOV arc — show facing direction around self
  const selfAv = avatars.find(a => a.isSelf);
  if (selfAv && selfCol >= 0 && selfCol < cols && selfRow >= 0 && selfRow < rows) {
    renderFovArc(frame, selfCol, selfRow, selfAv.yaw, cols, rows);
  }

  // 6. Edge indicators for off-screen avatars
  for (const av of avatars) {
    if (av.isSelf) continue;
    const dz = Math.abs(av.z - selfZ);
    if (dz >= 30) continue;
    const pos = simToGrid(av.x, av.y, params);
    if (pos) continue; // on-screen

    const dx = av.x - selfX;
    const dy = av.y - selfY;
    let edgeCol: number, edgeRow: number, arrow: string;
    const angle = Math.atan2(dy, dx);
    const deg = ((angle * 180 / Math.PI) + 360) % 360;

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

// Classify terrain into a FP-view char: use full-block with bg color to fill cell
function fpTerrainChar(height: number, waterHeight: number): { char: string; fg: string; bg: string } {
  if (height < waterHeight - 2) return { char: '~', fg: '#88bbee', bg: COLORS.deepWater };
  if (height < waterHeight)     return { char: '≈', fg: '#88ccdd', bg: COLORS.water };
  if (height < waterHeight + 1) return { char: ' ', fg: COLORS.beach, bg: COLORS.beach };
  if (height < waterHeight + 15) return { char: ' ', fg: COLORS.ground, bg: COLORS.ground };
  if (height < waterHeight + 40) return { char: ' ', fg: COLORS.hills, bg: COLORS.hills };
  return { char: ' ', fg: COLORS.mountains, bg: COLORS.mountains };
}

export interface FirstPersonParams {
  selfX: number;
  selfY: number;
  selfZ: number;  // eye height
  yaw: number;
  waterHeight: number;
}

// Stick figure: scales with perspective distance
// height=1: just 'o'  height=2: 'o' + '|'  height>=3: head, torso, arms, legs
function renderStickFigure(
  frame: GridFrame, cols: number, rows: number,
  centerCol: number, topRow: number, height: number,
  fg: string, uuid: string, topDrawn: Int32Array, facingViewer: number,
): void {
  const setCell = (r: number, c: number, ch: string) => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    if (r >= topDrawn[c]) return; // behind terrain
    frame.cells[r * cols + c] = { char: ch, fg, bg: SKY_BG, oid: uuid };
  };

  if (height <= 1) {
    setCell(topRow, centerCol, 'o');
    return;
  }

  if (height === 2) {
    setCell(topRow, centerCol, 'o');
    setCell(topRow + 1, centerCol, '|');
    return;
  }

  // height >= 3: proportional stick figure
  // Head (top ~20%), torso+arms (middle ~40%), legs (bottom ~40%)
  const headEnd = topRow;
  const torsoStart = topRow + 1;
  const torsoEnd = topRow + Math.max(1, Math.floor(height * 0.5));
  const armRow = torsoStart + Math.floor((torsoEnd - torsoStart) / 2);
  const legsStart = torsoEnd + 1;
  const legsEnd = topRow + height - 1;

  // Head
  setCell(headEnd, centerCol, 'O');

  // Torso
  for (let r = torsoStart; r <= torsoEnd && r < topRow + height; r++) {
    setCell(r, centerCol, '|');
  }

  // Arms (at mid-torso)
  if (height >= 4) {
    const armWidth = Math.max(1, Math.floor(height / 4));
    for (let w = 1; w <= armWidth; w++) {
      setCell(armRow, centerCol - w, facingViewer > 0.5 ? '-' : '/');
      setCell(armRow, centerCol + w, facingViewer > 0.5 ? '-' : '\\');
    }
  }

  // Legs
  if (legsStart <= legsEnd) {
    for (let r = legsStart; r <= legsEnd; r++) {
      const spread = r - legsStart + 1;
      setCell(r, centerCol - Math.min(spread, Math.floor(height / 5) + 1), '/');
      setCell(r, centerCol + Math.min(spread, Math.floor(height / 5) + 1), '\\');
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
  const { selfX, selfY, selfZ, yaw, waterHeight } = params;
  const frame = createEmptyFrame(cols, rows);

  // Fill with sky
  const skyFg = SKY_COLORS[0];
  for (let i = 0; i < cols * rows; i++) {
    frame.cells[i] = { char: ' ', fg: skyFg, bg: SKY_BG };
  }

  const horizonRow = Math.floor(rows / 2);
  const fwdX = Math.cos(yaw);
  const fwdY = Math.sin(yaw);
  const rightX = Math.sin(yaw);   // perpendicular right
  const rightY = -Math.cos(yaw);

  const MAX_DEPTH = 96;
  const DEPTH_STEPS = 48;
  const DEPTH_STEP = MAX_DEPTH / DEPTH_STEPS;
  const LATERAL_SCALE = 1.5; // meters per column
  const VSCALE = horizonRow > 0 ? horizonRow : 1;

  // Per-column occlusion: highest (lowest row index) drawn so far
  const topDrawn = new Int32Array(cols).fill(rows);

  // Front-to-back: near strips occlude far ones
  for (let di = 0; di < DEPTH_STEPS; di++) {
    const depth = (di + 1) * DEPTH_STEP;

    for (let col = 0; col < cols; col++) {
      if (topDrawn[col] <= 0) continue; // fully occluded

      const lateralOffset = (col - cols / 2) * LATERAL_SCALE;
      const wx = selfX + fwdX * depth + rightX * lateralOffset;
      const wy = selfY + fwdY * depth + rightY * lateralOffset;

      // Out of region
      if (wx < 0 || wx >= 256 || wy < 0 || wy >= 256) continue;

      const h = terrain(Math.floor(wx), Math.floor(wy));
      const heightDiff = h - selfZ;

      // Screen row: above horizon = negative diff (terrain above us)
      // row = horizon - (heightDiff / depth) * vscale
      const screenRow = Math.round(horizonRow - (heightDiff / depth) * VSCALE);

      if (screenRow >= topDrawn[col]) continue; // behind existing strip

      const drawFrom = Math.max(0, screenRow);
      const drawTo = topDrawn[col];

      const tc = fpTerrainChar(h, waterHeight);
      const dimFg = dimColor(tc.fg, depth, MAX_DEPTH);
      const dimBg = dimColor(tc.bg, depth, MAX_DEPTH);

      for (let r = drawFrom; r < drawTo; r++) {
        frame.cells[r * cols + col] = { char: tc.char, fg: dimFg, bg: dimBg };
      }

      topDrawn[col] = drawFrom;
    }
  }

  // Draw horizon line through any remaining sky columns
  if (horizonRow >= 0 && horizonRow < rows) {
    for (let col = 0; col < cols; col++) {
      if (topDrawn[col] > horizonRow) {
        frame.cells[horizonRow * cols + col] = { char: '─', fg: '#555566', bg: SKY_BG };
      }
    }
  }

  // Overlay objects
  for (const obj of objects) {
    const dx = obj.x - selfX;
    const dy = obj.y - selfY;
    const forwardDist = dx * fwdX + dy * fwdY;
    if (forwardDist < 2 || forwardDist > MAX_DEPTH) continue;

    const lateralDist = dx * rightX + dy * rightY;
    const screenCol = Math.round(cols / 2 + lateralDist / LATERAL_SCALE);
    if (screenCol < 0 || screenCol >= cols) continue;

    const heightDiff = (obj.z + obj.scaleZ / 2) - selfZ;
    const screenRow = Math.round(horizonRow - (heightDiff / forwardDist) * VSCALE);
    if (screenRow < 0 || screenRow >= rows) continue;
    if (screenRow >= topDrawn[screenCol]) continue;

    const ch = obj.isTree ? '♣' : '■';
    const fg = obj.isTree ? COLORS.tree : COLORS.object;
    const entityRows = Math.max(1, Math.round((obj.scaleZ || 2) / forwardDist * VSCALE));
    const startRow = Math.max(0, screenRow - entityRows + 1);

    for (let r = startRow; r <= screenRow && r < rows; r++) {
      if (r < topDrawn[screenCol]) {
        frame.cells[r * cols + screenCol] = {
          char: ch,
          fg: dimColor(fg, forwardDist, MAX_DEPTH),
          bg: SKY_BG,
          oid: obj.uuid,
        };
      }
    }
  }

  // Overlay avatars as stick figures with perspective scaling
  for (const av of avatars) {
    if (av.isSelf) continue;
    const dx = av.x - selfX;
    const dy = av.y - selfY;
    const forwardDist = dx * fwdX + dy * fwdY;
    if (forwardDist < 2 || forwardDist > MAX_DEPTH) continue;

    const lateralDist = dx * rightX + dy * rightY;
    const screenCol = Math.round(cols / 2 + lateralDist / LATERAL_SCALE);
    if (screenCol < 0 || screenCol >= cols) continue;

    // Avatar feet at ground, ~2m tall
    const feetZ = av.z;
    const headZ = av.z + 2;
    const feetRow = Math.round(horizonRow - ((feetZ - selfZ) / forwardDist) * VSCALE);
    const headRow = Math.round(horizonRow - ((headZ - selfZ) / forwardDist) * VSCALE);
    if (headRow >= rows || feetRow < 0) continue;

    const figHeight = Math.max(1, feetRow - headRow + 1);
    const figFg = dimColor(COLORS.avatar, forwardDist, MAX_DEPTH);

    // Determine facing relative to viewer for stick figure pose
    const facingViewer = Math.abs(Math.cos(av.yaw - yaw));

    // Draw stick figure proportional to height
    renderStickFigure(frame, cols, rows, screenCol, headRow, figHeight, figFg, av.uuid, topDrawn, facingViewer);
  }

  return frame;
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
