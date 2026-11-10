import { addScaled } from "../geometry/vec3.js";
import type { Rect2 } from "../geometry/rect2.js";
import type { PixelJacobian, ResolvedView } from "../projection/view.js";
import type { LabelDimensions, Vec2, Vec3 } from "../types.js";
import type { BillboardFrame } from "./orienter.js";

/** World-space corners: top-left, top-right, bottom-right, bottom-left. */
export const billboardCorners = (center: Vec3, frame: BillboardFrame, size: LabelDimensions): [Vec3, Vec3, Vec3, Vec3] => {
  const hw = size.width / 2;
  const hh = size.height / 2;
  const at = (sx: number, sy: number): Vec3 => addScaled(addScaled(center, frame.right, sx * hw), frame.up, sy * hh);
  return [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)];
};

export interface ProjectedBillboard {
  /** Axis-aligned bounds of the four projected corners (pixels). */
  rect: Rect2;
  /** Projected corners in pixels (same order as `billboardCorners`). */
  corners: [Vec2, Vec2, Vec2, Vec2];
  center: Vec2;
  /** Depth of the center along the view forward axis. */
  depth: number;
  /** False when at least one corner is behind the camera: the rect is then meaningless. */
  valid: boolean;
  /** Exact pixel Jacobian at the center w.r.t. displacements along frame.right / frame.up (null when invalid). */
  jacobian: PixelJacobian | null;
}

const EPS = 1e-6;
const SIGNS: ReadonlyArray<readonly [number, number]> = [
  [-1, 1],
  [1, 1],
  [1, -1],
  [-1, -1],
];

/**
 * Projects a billboard into a view.
 *
 * Clip coordinates are affine in world position, so for corners
 * c +- r*hw +- u*hh we only need clip(c) and the clip-space images of the two
 * axis directions (3 matrix-vector products instead of 5 projections). The
 * same terms give the exact pixel Jacobian at the center (quotient rule on
 * x/w, y/w), used to convert pixel corrections back to world displacements.
 */
export const projectBillboard = (
  view: ResolvedView,
  center: Vec3,
  frame: BillboardFrame,
  size: LabelDimensions,
): ProjectedBillboard => {
  const m = view.viewProjection;
  const m0 = m[0] as number, m1 = m[1] as number, m3 = m[3] as number;
  const m4 = m[4] as number, m5 = m[5] as number, m7 = m[7] as number;
  const m8 = m[8] as number, m9 = m[9] as number, m11 = m[11] as number;
  const m12 = m[12] as number, m13 = m[13] as number, m15 = m[15] as number;

  // clip(center)
  const cx = m0 * center.x + m4 * center.y + m8 * center.z + m12;
  const cy = m1 * center.x + m5 * center.y + m9 * center.z + m13;
  const cw = m3 * center.x + m7 * center.y + m11 * center.z + m15;
  // clip-space images of the unit axis directions (w component 0 in homogeneous input)
  const r = frame.right, u = frame.up;
  const rx = m0 * r.x + m4 * r.y + m8 * r.z, ry = m1 * r.x + m5 * r.y + m9 * r.z, rw = m3 * r.x + m7 * r.y + m11 * r.z;
  const ux = m0 * u.x + m4 * u.y + m8 * u.z, uy = m1 * u.x + m5 * u.y + m9 * u.z, uw = m3 * u.x + m7 * u.y + m11 * u.z;

  const f = view.forward;
  const depth = (center.x - view.position.x) * f.x + (center.y - view.position.y) * f.y + (center.z - view.position.z) * f.z;
  const hw = size.width / 2;
  const hh = size.height / 2;
  const W = view.viewport.width;
  const H = view.viewport.height;
  const rDepth = (r.x * f.x + r.y * f.y + r.z * f.z) * hw;
  const uDepth = (u.x * f.x + u.y * f.y + u.z * f.z) * hh;

  let valid = view.perspective ? cw > EPS : depth > 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const corners: Vec2[] = [];
  for (const [sx, sy] of SIGNS) {
    const X = cx + rx * hw * sx + ux * hh * sy;
    const Y = cy + ry * hw * sx + uy * hh * sy;
    const Wc = cw + rw * hw * sx + uw * hh * sy;
    const inFront = view.perspective ? Wc > EPS : depth + rDepth * sx + uDepth * sy > 0;
    if (!inFront) valid = false;
    const w = inFront ? Wc : Math.max(Math.abs(Wc), EPS);
    const px = (X / w * 0.5 + 0.5) * W;
    const py = (0.5 - Y / w * 0.5) * H;
    corners.push({ x: px, y: py });
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  const wc = cw > EPS ? cw : Math.max(Math.abs(cw), EPS);
  const jacobian: PixelJacobian | null = valid
    ? {
        a: ((rx * cw - cx * rw) / (wc * wc)) * 0.5 * W,
        b: ((ux * cw - cx * uw) / (wc * wc)) * 0.5 * W,
        c: (-(ry * cw - cy * rw) / (wc * wc)) * 0.5 * H,
        d: (-(uy * cw - cy * uw) / (wc * wc)) * 0.5 * H,
      }
    : null;
  return {
    rect: { minX, minY, maxX, maxY },
    corners: corners as [Vec2, Vec2, Vec2, Vec2],
    center: { x: (cx / wc * 0.5 + 0.5) * W, y: (0.5 - cy / wc * 0.5) * H },
    depth,
    valid,
    jacobian,
  };
};
