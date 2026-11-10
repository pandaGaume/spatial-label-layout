import { cross, dot, normalize, sub, addScaled } from "../geometry/vec3.js";
import type { CameraView, Vec3, Viewport } from "../types.js";

/**
 * Pure-math camera builders. Useful for tests, headless benchmarks, and for
 * adapters that receive raw poses (e.g. WebXR `XRView.transform`) instead of
 * engine camera objects.
 */

export type Handedness = "right" | "left";
/** "negOneToOne": OpenGL/WebGL NDC depth. "zeroToOne": WebGPU/D3D NDC depth. */
export type DepthRange = "negOneToOne" | "zeroToOne";

export interface PerspectiveOptions {
  fovY: number;
  aspect: number;
  near: number;
  far: number;
  handedness?: Handedness;
  depthRange?: DepthRange;
}

export const perspective = (o: PerspectiveOptions): Float32Array => {
  const f = 1 / Math.tan(o.fovY / 2);
  const rh = (o.handedness ?? "right") === "right";
  const zo = (o.depthRange ?? "negOneToOne") === "zeroToOne";
  const { near: n, far: fa } = o;
  const m = new Float32Array(16);
  m[0] = f / o.aspect;
  m[5] = f;
  if (rh) {
    m[11] = -1;
    m[10] = zo ? fa / (n - fa) : (fa + n) / (n - fa);
    m[14] = zo ? (fa * n) / (n - fa) : (2 * fa * n) / (n - fa);
  } else {
    m[11] = 1;
    m[10] = zo ? fa / (fa - n) : (fa + n) / (fa - n);
    m[14] = zo ? (-fa * n) / (fa - n) : (-2 * fa * n) / (fa - n);
  }
  return m;
};

export const lookAt = (eye: Vec3, target: Vec3, up: Vec3 = { x: 0, y: 1, z: 0 }, handedness: Handedness = "right"): Float32Array => {
  const z = handedness === "right" ? normalize(sub(eye, target), { x: 0, y: 0, z: 1 }) : normalize(sub(target, eye), { x: 0, y: 0, z: 1 });
  let x = cross(up, z);
  if (dot(x, x) < 1e-12) x = cross({ x: 0, y: 0, z: 1 }, z);
  x = normalize(x);
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x.x; m[4] = x.y; m[8] = x.z;
  m[1] = y.x; m[5] = y.y; m[9] = y.z;
  m[2] = z.x; m[6] = z.y; m[10] = z.z;
  m[12] = -dot(x, eye);
  m[13] = -dot(y, eye);
  m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
};

export interface CameraViewOptions {
  eye: Vec3;
  target: Vec3;
  up?: Vec3;
  /** Vertical field of view in radians (default 60 degrees). */
  fovY?: number;
  viewport: Viewport;
  near?: number;
  far?: number;
  handedness?: Handedness;
  depthRange?: DepthRange;
  id?: string;
}

export const createCameraView = (o: CameraViewOptions): CameraView => {
  const handedness = o.handedness ?? "right";
  const view: CameraView = {
    viewMatrix: lookAt(o.eye, o.target, o.up, handedness),
    projectionMatrix: perspective({
      fovY: o.fovY ?? Math.PI / 3,
      aspect: o.viewport.width / o.viewport.height,
      near: o.near ?? 0.1,
      far: o.far ?? 1000,
      handedness,
      depthRange: o.depthRange ?? "negOneToOne",
    }),
    viewport: { ...o.viewport },
  };
  if (o.id !== undefined) view.id = o.id;
  return view;
};

export interface StereoViewOptions extends CameraViewOptions {
  /** Inter-pupillary distance in world units (default 0.064). */
  ipd?: number;
}

/** Left/right eyes with parallel axes, plus the central reference pose. */
export const createStereoViews = (o: StereoViewOptions): { center: CameraView; left: CameraView; right: CameraView } => {
  const handedness = o.handedness ?? "right";
  const up = o.up ?? { x: 0, y: 1, z: 0 };
  const half = (o.ipd ?? 0.064) / 2;
  const fwd = normalize(sub(o.target, o.eye));
  // Screen-right is cross(up, z) where z is the view-matrix z axis (see lookAt).
  const z = handedness === "right" ? { x: -fwd.x, y: -fwd.y, z: -fwd.z } : fwd;
  const right = normalize(cross(up, z), { x: 1, y: 0, z: 0 });
  const mk = (offset: number, id: string): CameraView =>
    createCameraView({
      ...o,
      id,
      eye: addScaled(o.eye, right, offset),
      target: addScaled(o.target, right, offset),
    });
  return { center: mk(0, "center"), left: mk(-half, "left"), right: mk(half, "right") };
};
