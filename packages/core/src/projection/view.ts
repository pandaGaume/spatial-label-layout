import { invert, isFiniteMat4, multiply, transformPoint, transformPoint4, type ReadonlyMat4 } from "../geometry/mat4.js";
import { dot, normalize, scale, sub, addScaled } from "../geometry/vec3.js";
import type { Rect2 } from "../geometry/rect2.js";
import type { CameraView, Vec2, Vec3, Viewport } from "../types.js";

/**
 * A `CameraView` with everything the solver derives from it once per solve.
 * Handedness-agnostic: `forward` is deduced from the projection matrix so that
 * moving along it always increases clip-space `w` (perspective) or NDC depth
 * (orthographic, assuming a non-reversed depth range).
 */
export interface ResolvedView {
  readonly index: number;
  readonly id?: string;
  readonly source: CameraView;
  readonly viewMatrix: ReadonlyMat4;
  readonly projectionMatrix: ReadonlyMat4;
  readonly viewProjection: ReadonlyMat4;
  readonly viewport: Viewport;
  readonly bounds: Rect2;
  /** Camera position in world space. */
  readonly position: Vec3;
  /** Camera axes in world space (unit vectors). `right`/`up` match screen +x / screen -y (pixels grow downward). */
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
  readonly perspective: boolean;
}

export interface ProjectedPoint {
  /** Pixel coordinates, origin top-left, y downward. */
  x: number;
  y: number;
  /** Distance along `forward` from the camera (world units). */
  depth: number;
  /** Clip-space w. */
  w: number;
  /** True when the point is in front of the camera. */
  inFront: boolean;
}

export class InvalidViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidViewError";
  }
}

const IN_FRONT_EPS = 1e-6;

export const resolveView = (view: CameraView, index: number): ResolvedView => {
  const V = view.viewMatrix;
  const P = view.projectionMatrix;
  if (!isFiniteMat4(V) || !isFiniteMat4(P)) throw new InvalidViewError(`view ${index}: matrices must hold 16 finite numbers`);
  if (!(view.viewport.width > 0 && view.viewport.height > 0)) throw new InvalidViewError(`view ${index}: viewport must be positive`);
  const inv = invert(V);
  if (!inv) throw new InvalidViewError(`view ${index}: view matrix is not invertible`);

  const position = transformPoint(inv, { x: 0, y: 0, z: 0 });
  const row = (r: number): Vec3 => ({ x: V[r] as number, y: V[4 + r] as number, z: V[8 + r] as number });
  const right = normalize(row(0), { x: 1, y: 0, z: 0 });
  const up = normalize(row(1), { x: 0, y: 1, z: 0 });
  const p11 = P[11] as number;
  const perspective = Math.abs(p11) > 1e-9;
  const sign = perspective ? Math.sign(p11) : Math.sign(P[10] as number) || -1;
  const forward = normalize(scale(row(2), sign), { x: 0, y: 0, z: -1 });

  return {
    index,
    source: view,
    viewMatrix: V,
    projectionMatrix: P,
    viewProjection: multiply(P, V),
    viewport: { width: view.viewport.width, height: view.viewport.height },
    bounds: { minX: 0, minY: 0, maxX: view.viewport.width, maxY: view.viewport.height },
    position,
    right,
    up,
    forward,
    perspective,
    ...(view.id !== undefined ? { id: view.id } : {}),
  };
};

export const viewDepth = (view: ResolvedView, p: Vec3): number => dot(sub(p, view.position), view.forward);

export const projectPoint = (view: ResolvedView, p: Vec3): ProjectedPoint => {
  const [cx, cy, , cw] = transformPoint4(view.viewProjection, p);
  const depth = viewDepth(view, p);
  const inFront = view.perspective ? cw > IN_FRONT_EPS : depth > 0;
  const w = inFront ? cw : Math.max(Math.abs(cw), IN_FRONT_EPS);
  const ndcX = cx / w;
  const ndcY = cy / w;
  return {
    x: (ndcX * 0.5 + 0.5) * view.viewport.width,
    y: (0.5 - ndcY * 0.5) * view.viewport.height,
    depth,
    w: cw,
    inFront,
  };
};

/**
 * 2x2 Jacobian of the pixel projection with respect to displacements along
 * two world axes (`u`, `v`) at point `p`, estimated by forward differences.
 * d(px) = [a b; c d] * [du; dv].
 */
export interface PixelJacobian {
  a: number;
  b: number;
  c: number;
  d: number;
}

export const pixelJacobian = (view: ResolvedView, p: Vec3, u: Vec3, v: Vec3, step?: number): PixelJacobian | null => {
  const depth = Math.abs(viewDepth(view, p));
  const h = step ?? Math.max(1e-4, depth * 1e-3);
  const p0 = projectPoint(view, p);
  const pu = projectPoint(view, addScaled(p, u, h));
  const pv = projectPoint(view, addScaled(p, v, h));
  if (!p0.inFront || !pu.inFront || !pv.inFront) return null;
  return {
    a: (pu.x - p0.x) / h,
    b: (pv.x - p0.x) / h,
    c: (pu.y - p0.y) / h,
    d: (pv.y - p0.y) / h,
  };
};

/** Converts a pixel displacement into coefficients along (u, v). Null when the Jacobian is degenerate. */
export const pixelDeltaToAxes = (j: PixelJacobian, delta: Vec2): Vec2 | null => {
  const det = j.a * j.d - j.b * j.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return {
    x: (j.d * delta.x - j.b * delta.y) / det,
    y: (-j.c * delta.x + j.a * delta.y) / det,
  };
};

/** Pixel size of one world unit at point `p`, along the screen x axis. */
export const pixelsPerWorldUnit = (view: ResolvedView, p: Vec3): number => {
  const j = pixelJacobian(view, p, view.right, view.up);
  if (!j) return 0;
  return Math.hypot(j.a, j.c);
};

/** Angle (radians) between the forward axes of two views plus the distance between their positions. */
export const viewDelta = (a: ResolvedView, b: ResolvedView): { angle: number; translation: number } => {
  const c = Math.min(1, Math.max(-1, dot(a.forward, b.forward)));
  const d = sub(a.position, b.position);
  return { angle: Math.acos(c), translation: Math.sqrt(dot(d, d)) };
};
