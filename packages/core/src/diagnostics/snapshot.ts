import type { Rect2 } from "../geometry/rect2.js";
import type { HiddenReason, Vec2, Viewport } from "../types.js";

/**
 * Renderer-agnostic picture of the layout as seen from one view. Produced by
 * `SpatialLabelLayoutEngine.inspect()`, consumed by the debug package (SVG,
 * canvas overlays in dev tools, test assertions...).
 */
export interface LabelSnapshot {
  id: string;
  anchorId: string;
  visible: boolean;
  hiddenReason?: HiddenReason;
  priority: number;
  /** Projected billboard bounds; null when the billboard is (partly) behind the camera. */
  rect: Rect2 | null;
  corners: Vec2[] | null;
  center: Vec2 | null;
  anchor: Vec2 | null;
  /** Projected leader polyline (anchor first). Null when a point is behind the camera. */
  leader: Vec2[] | null;
  colliding: boolean;
  occluded: boolean;
  outOfView: boolean;
}

export interface ViewSnapshot {
  viewIndex: number;
  viewId?: string;
  viewport: Viewport;
  labels: LabelSnapshot[];
  collidingPairs: Array<[string, string]>;
  crossingPairs: Array<[string, string]>;
}

export interface LayoutSnapshot {
  views: ViewSnapshot[];
}
