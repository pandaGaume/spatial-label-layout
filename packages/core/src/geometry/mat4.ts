import type { Vec3 } from "../types.js";

/**
 * 4x4 matrix helpers.
 *
 * Storage: column-major, column vectors. Element (row r, column c) is m[c * 4 + r].
 * Translation lives at m[12], m[13], m[14]. This is the memory layout of WebGL,
 * three.js `Matrix4.elements` and Babylon.js `Matrix.m` (Babylon writes it as
 * row-major with row vectors, which is the same bytes).
 */
export type Mat4 = Float32Array | Float64Array | number[];
export type ReadonlyMat4 = ArrayLike<number>;

export const identity = (): Float64Array => {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

const at = (m: ReadonlyMat4, i: number): number => m[i] as number;

/** out = a * b (apply b first, then a). */
export const multiply = (a: ReadonlyMat4, b: ReadonlyMat4, out: Mat4 = new Float64Array(16)): Mat4 => {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += at(a, k * 4 + r) * at(b, c * 4 + k);
      out[c * 4 + r] = s;
    }
  }
  return out;
};

/** Transforms a point (w = 1) and performs no perspective divide. Returns [x, y, z, w]. */
export const transformPoint4 = (m: ReadonlyMat4, p: Vec3): [number, number, number, number] => [
  at(m, 0) * p.x + at(m, 4) * p.y + at(m, 8) * p.z + at(m, 12),
  at(m, 1) * p.x + at(m, 5) * p.y + at(m, 9) * p.z + at(m, 13),
  at(m, 2) * p.x + at(m, 6) * p.y + at(m, 10) * p.z + at(m, 14),
  at(m, 3) * p.x + at(m, 7) * p.y + at(m, 11) * p.z + at(m, 15),
];

/** Affine point transform (assumes the last row is 0 0 0 1). */
export const transformPoint = (m: ReadonlyMat4, p: Vec3): Vec3 => ({
  x: at(m, 0) * p.x + at(m, 4) * p.y + at(m, 8) * p.z + at(m, 12),
  y: at(m, 1) * p.x + at(m, 5) * p.y + at(m, 9) * p.z + at(m, 13),
  z: at(m, 2) * p.x + at(m, 6) * p.y + at(m, 10) * p.z + at(m, 14),
});

export const transformDirection = (m: ReadonlyMat4, d: Vec3): Vec3 => ({
  x: at(m, 0) * d.x + at(m, 4) * d.y + at(m, 8) * d.z,
  y: at(m, 1) * d.x + at(m, 5) * d.y + at(m, 9) * d.z,
  z: at(m, 2) * d.x + at(m, 6) * d.y + at(m, 10) * d.z,
});

export const translation = (x: number, y: number, z: number): Float64Array => {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};

export const scaling = (x: number, y: number, z: number): Float64Array => {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
};

/** Rotation around the Y axis (right-hand rule in a right-handed frame). */
export const rotationY = (angle: number): Float64Array => {
  const m = identity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
};

/** General 4x4 inverse. Returns null when the matrix is singular. */
export const invert = (m: ReadonlyMat4, out: Mat4 = new Float64Array(16)): Mat4 | null => {
  const a00 = at(m, 0), a01 = at(m, 1), a02 = at(m, 2), a03 = at(m, 3);
  const a10 = at(m, 4), a11 = at(m, 5), a12 = at(m, 6), a13 = at(m, 7);
  const a20 = at(m, 8), a21 = at(m, 9), a22 = at(m, 10), a23 = at(m, 11);
  const a30 = at(m, 12), a31 = at(m, 13), a32 = at(m, 14), a33 = at(m, 15);

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) return null;
  det = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
};

export const isFiniteMat4 = (m: ReadonlyMat4): boolean => {
  if (m.length < 16) return false;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(at(m, i))) return false;
  return true;
};
