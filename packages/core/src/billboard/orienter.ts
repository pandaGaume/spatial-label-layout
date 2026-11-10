import { cross, dot, normalize, scale, sub } from "../geometry/vec3.js";
import type { ResolvedView } from "../projection/view.js";
import type { Vec3 } from "../types.js";

/**
 * Orthonormal frame of a billboard in world space.
 * `right`/`up` span the label plane; `normal` points toward the viewer.
 */
export interface BillboardFrame {
  right: Vec3;
  up: Vec3;
  normal: Vec3;
}

/**
 * Decides how billboards are oriented. The solver and the renderer must use
 * the same orienter so that projected corners match what is drawn.
 * Port extension point: an adapter may provide an orienter that mirrors a
 * native billboard mode (e.g. Babylon `BILLBOARDMODE_ALL` vs `_Y`).
 */
export interface BillboardOrienter {
  readonly kind: string;
  frame(center: Vec3, view: ResolvedView): BillboardFrame;
}

/** All billboards parallel to the camera image plane (screen-aligned). Most stable for overlap tests. */
export class ScreenAlignedOrienter implements BillboardOrienter {
  readonly kind = "screen-aligned";
  frame(_center: Vec3, view: ResolvedView): BillboardFrame {
    return { right: view.right, up: view.up, normal: scale(view.forward, -1) };
  }
}

/** Each billboard faces the camera position, keeping `worldUp` as vertical reference (spherical billboard). */
export class ViewpointOrienter implements BillboardOrienter {
  readonly kind = "viewpoint";
  constructor(private readonly worldUp: Vec3 = { x: 0, y: 1, z: 0 }) {}

  frame(center: Vec3, view: ResolvedView): BillboardFrame {
    const normal = normalize(sub(view.position, center), scale(view.forward, -1));
    let right = cross(this.worldUp, normal);
    if (dot(right, right) < 1e-10) right = view.right;
    right = normalize(right);
    if (dot(right, view.right) < 0) right = scale(right, -1);
    let up = normalize(cross(normal, right));
    if (dot(up, view.up) < 0) up = scale(up, -1);
    return { right, up, normal };
  }
}

/** World-fixed orientation (signage-style labels). */
export class FixedOrienter implements BillboardOrienter {
  readonly kind = "fixed";
  constructor(private readonly fixed: BillboardFrame) {}
  frame(): BillboardFrame {
    return this.fixed;
  }
}
