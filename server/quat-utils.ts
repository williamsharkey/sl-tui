// quat-utils.ts — Quaternion math for composing child prim transforms

/** Rotate a vector by a quaternion: q * v * q^-1 */
export function quatRotateVec3(
  qx: number, qy: number, qz: number, qw: number,
  vx: number, vy: number, vz: number,
): [number, number, number] {
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // result = v + w * t + cross(q.xyz, t)
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Multiply two quaternions: result = a * b (apply b first, then a) */
export function quatMultiply(
  ax: number, ay: number, az: number, aw: number,
  bx: number, by: number, bz: number, bw: number,
): [number, number, number, number] {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
