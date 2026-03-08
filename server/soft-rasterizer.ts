// soft-rasterizer.ts — Minimal CPU triangle rasterizer with depth buffer
//
// Renders triangles into an RGBA pixel buffer. Solid color with
// depth-based shading (lighter = farther). No textures, no lighting model.

export interface RasterTarget {
  width: number;
  height: number;
  color: Uint8Array;   // RGBA, length = width * height * 4
  depth: Float32Array;  // per-pixel depth, length = width * height
  oids?: (string | undefined)[];  // optional per-pixel object ID
}

export function createRasterTarget(width: number, height: number): RasterTarget {
  const pixels = width * height;
  const color = new Uint8Array(pixels * 4);
  const depth = new Float32Array(pixels);
  depth.fill(Infinity);
  return { width, height, color, depth };
}

export function clearRasterTarget(target: RasterTarget): void {
  target.color.fill(0);
  target.depth.fill(Infinity);
}

// 4x4 matrix multiply: out = a * b (column-major)
export function mat4Multiply(out: Float32Array, a: Float32Array, b: Float32Array): void {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
}

// Build a look-at view matrix (column-major)
export function mat4LookAt(out: Float32Array, eye: number[], target: number[], up: number[]): void {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  const fLen = Math.sqrt(fx * fx + fy * fy + fz * fz);
  fx /= fLen; fy /= fLen; fz /= fLen;

  // side = forward x up
  let sx = fy * up[2] - fz * up[1];
  let sy = fz * up[0] - fx * up[2];
  let sz = fx * up[1] - fy * up[0];
  const sLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
  sx /= sLen; sy /= sLen; sz /= sLen;

  // recompute up = side x forward
  const ux = sy * fz - sz * fy;
  const uy = sz * fx - sx * fz;
  const uz = sx * fy - sy * fx;

  out[0] = sx;  out[4] = sy;  out[8]  = sz;  out[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
  out[1] = ux;  out[5] = uy;  out[9]  = uz;  out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  out[2] = -fx; out[6] = -fy; out[10] = -fz; out[14] = (fx * eye[0] + fy * eye[1] + fz * eye[2]);
  out[3] = 0;   out[7] = 0;   out[11] = 0;   out[15] = 1;
}

// Build a perspective projection matrix (column-major)
export function mat4Perspective(out: Float32Array, fovY: number, aspect: number, near: number, far: number): void {
  out.fill(0);
  const f = 1.0 / Math.tan(fovY / 2);
  out[0]  = f / aspect;
  out[5]  = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
}

// Build a model matrix from position + scale (no rotation for MVP)
export function mat4ModelPosScale(out: Float32Array, px: number, py: number, pz: number, scale: number): void {
  out.fill(0);
  out[0]  = scale;
  out[5]  = scale;
  out[10] = scale;
  out[12] = px;
  out[13] = py;
  out[14] = pz;
  out[15] = 1;
}

// Build a model matrix: M = T * R * S with quaternion rotation and non-uniform scale
export function mat4ModelPosScaleRot(
  out: Float32Array,
  px: number, py: number, pz: number,
  sx: number, sy: number, sz: number,
  qx: number, qy: number, qz: number, qw: number,
): void {
  // Rotation matrix from quaternion
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  // R * S (multiply each column of R by scale component)
  out[0]  = (1 - yy - zz) * sx;
  out[1]  = (xy + wz) * sx;
  out[2]  = (xz - wy) * sx;
  out[3]  = 0;
  out[4]  = (xy - wz) * sy;
  out[5]  = (1 - xx - zz) * sy;
  out[6]  = (yz + wx) * sy;
  out[7]  = 0;
  out[8]  = (xz + wy) * sz;
  out[9]  = (yz - wx) * sz;
  out[10] = (1 - xx - yy) * sz;
  out[11] = 0;
  out[12] = px;
  out[13] = py;
  out[14] = pz;
  out[15] = 1;
}

// Transform a vertex by MVP, returning NDC (x,y,z,w)
function transformVertex(
  mvp: Float32Array,
  x: number, y: number, z: number,
): [number, number, number, number] {
  const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
  const nx = (mvp[0] * x + mvp[4] * y + mvp[8]  * z + mvp[12]) / w;
  const ny = (mvp[1] * x + mvp[5] * y + mvp[9]  * z + mvp[13]) / w;
  const nz = (mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14]) / w;
  return [nx, ny, nz, w];
}

// Rasterize triangles with MVP matrix. Color is solid RGB, shaded by depth.
export function rasterize(
  target: RasterTarget,
  positions: Float32Array,   // flat xyz
  indices: Uint16Array,
  mvp: Float32Array,         // 4x4 column-major
  baseR: number, baseG: number, baseB: number,
  oid?: string,
  fullbright?: boolean,
): void {
  const { width, height, color, depth } = target;
  const hw = width / 2;
  const hh = height / 2;

  for (let t = 0; t + 2 < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];

    // World-space positions for normal calculation
    const p0x = positions[i0 * 3], p0y = positions[i0 * 3 + 1], p0z = positions[i0 * 3 + 2];
    const p1x = positions[i1 * 3], p1y = positions[i1 * 3 + 1], p1z = positions[i1 * 3 + 2];
    const p2x = positions[i2 * 3], p2y = positions[i2 * 3 + 1], p2z = positions[i2 * 3 + 2];

    const [x0, y0, z0, w0] = transformVertex(mvp, p0x, p0y, p0z);
    const [x1, y1, z1, w1] = transformVertex(mvp, p1x, p1y, p1z);
    const [x2, y2, z2, w2] = transformVertex(mvp, p2x, p2y, p2z);

    // Clip: skip if any vertex is behind camera
    if (w0 <= 0 || w1 <= 0 || w2 <= 0) continue;
    // Clip NDC
    if (x0 < -1.5 && x1 < -1.5 && x2 < -1.5) continue;
    if (x0 > 1.5 && x1 > 1.5 && x2 > 1.5) continue;
    if (y0 < -1.5 && y1 < -1.5 && y2 < -1.5) continue;
    if (y0 > 1.5 && y1 > 1.5 && y2 > 1.5) continue;

    // Face normal for directional lighting
    const e1x = p1x - p0x, e1y = p1y - p0y, e1z = p1z - p0z;
    const e2x = p2x - p0x, e2y = p2y - p0y, e2z = p2z - p0z;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nLen > 0) { nx /= nLen; ny /= nLen; nz /= nLen; }
    // Directional light from upper-left-forward
    const lightDot = Math.max(0, nx * -0.4 + ny * 0.3 + nz * 0.7);
    const ambient = 0.35;
    const faceShade = fullbright ? 1.0 : ambient + (1 - ambient) * lightDot;

    // Screen coordinates
    const sx0 = (x0 + 1) * hw, sy0 = (1 - y0) * hh;
    const sx1 = (x1 + 1) * hw, sy1 = (1 - y1) * hh;
    const sx2 = (x2 + 1) * hw, sy2 = (1 - y2) * hh;

    // Bounding box
    let minX = Math.floor(Math.min(sx0, sx1, sx2));
    let maxX = Math.ceil(Math.max(sx0, sx1, sx2));
    let minY = Math.floor(Math.min(sy0, sy1, sy2));
    let maxY = Math.ceil(Math.max(sy0, sy1, sy2));
    minX = Math.max(0, minX);
    maxX = Math.min(width - 1, maxX);
    minY = Math.max(0, minY);
    maxY = Math.min(height - 1, maxY);

    // Skip degenerate triangles
    const area = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);
    if (Math.abs(area) < 0.5) continue;
    const invArea = 1 / area;

    // Pre-compute shaded color for this face
    const sr = Math.round(baseR * faceShade);
    const sg = Math.round(baseG * faceShade);
    const sb = Math.round(baseB * faceShade);

    // Scanline rasterization with barycentric interpolation (edge function)
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5, cy = py + 0.5;

        // Edge functions — weights are positive inside for both windings
        const w_0 = ((sx1 - cx) * (sy2 - cy) - (sy1 - cy) * (sx2 - cx)) * invArea;
        const w_1 = ((sx2 - cx) * (sy0 - cy) - (sy2 - cy) * (sx0 - cx)) * invArea;
        const w_2 = 1 - w_0 - w_1;

        if (w_0 < 0 || w_1 < 0 || w_2 < 0) continue;

        const pz = w_0 * z0 + w_1 * z1 + w_2 * z2;
        const idx = py * width + px;

        if (pz < depth[idx]) {
          depth[idx] = pz;
          const ci = idx * 4;
          color[ci]     = sr;
          color[ci + 1] = sg;
          color[ci + 2] = sb;
          color[ci + 3] = 255;
          if (oid && target.oids) target.oids[idx] = oid;
        }
      }
    }
  }
}
