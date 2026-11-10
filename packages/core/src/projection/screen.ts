import { addScaled } from "../geometry/vec3.js";
import type { LabelDimensions, SpatialLabel, Vec2, Vec3 } from "../types.js";
import { pixelDeltaToAxes, pixelJacobian, pixelsPerWorldUnit, projectPoint, type ResolvedView } from "./view.js";

/**
 * Screen-space helpers for labels that keep a constant size on screen
 * (`SpatialLabel.sizing === "screen"`): maps, globes, any scene whose camera
 * distance varies by orders of magnitude.
 */

/** World units covered by one pixel at `p`; 0 when `p` is not in front of the view. */
export const worldUnitsPerPixel = (view: ResolvedView, p: Vec3): number => {
  const density = pixelsPerWorldUnit(view, p);
  return density > 0 && Number.isFinite(density) ? 1 / density : 0;
};

/**
 * World size of a label seen from `view`.
 * - "world" sizing (default): the label's dimensions, unchanged.
 * - "screen" sizing: the world size that shows its pixel dimensions at `at`
 *   (normally the anchor). Null when `at` is not in front of the view.
 */
export const resolveLabelSize = (label: Pick<SpatialLabel, "dimensions" | "sizing">, view: ResolvedView, at: Vec3): LabelDimensions | null => {
  if (label.sizing !== "screen") return label.dimensions;
  const scale = worldUnitsPerPixel(view, at);
  return scale > 0 ? { width: label.dimensions.width * scale, height: label.dimensions.height * scale } : null;
};

/** Pixel offset of `position` from `anchor` in `view` (y down). Null when either point is not in front. */
export const screenOffset = (view: ResolvedView, anchor: Vec3, position: Vec3): Vec2 | null => {
  const from = projectPoint(view, anchor);
  const to = projectPoint(view, position);
  return from.inFront && to.inFront ? { x: to.x - from.x, y: to.y - from.y } : null;
};

/**
 * World point standing at pixel `offset` from `anchor`, in the plane through
 * the anchor parallel to the image plane. Inverse of `screenOffset` up to depth.
 */
export const placeAtScreenOffset = (view: ResolvedView, anchor: Vec3, offset: Vec2): Vec3 | null => {
  const jacobian = pixelJacobian(view, anchor, view.right, view.up);
  const axes = jacobian && pixelDeltaToAxes(jacobian, offset);
  return axes ? addScaled(addScaled(anchor, view.right, axes.x), view.up, axes.y) : null;
};
