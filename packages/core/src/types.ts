/**
 * Public data model (brief sections 3, 5, 6 and 8).
 *
 * Every interface here is plain data: no class instance from a rendering
 * library ever crosses this boundary. Adapters (Babylon.js, three.js, raw
 * WebXR...) convert their native objects into these shapes.
 *
 * Extension policy: fields marked "extension" are additive and optional, so an
 * adapter written against the brief's minimal shapes keeps compiling.
 */

/** 3D vector in world units. Plain object so that Babylon/three vectors are structurally compatible. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 2D vector, used for screen-space (pixel) quantities. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Barycentric weights (w0, w1, w2) on a triangle; expected to sum to 1. */
export type Barycentric = readonly [number, number, number];

/**
 * A pin attached to a mesh.
 *
 * - With `barycentric` + `triangleId`, the anchor follows a deformable mesh.
 * - Otherwise `localPosition` is transformed by the mesh world matrix.
 * - Without `meshId`, `localPosition` is interpreted as a world position.
 */
export interface LabelAnchor {
  id: string;
  meshId?: string;
  localPosition: Vec3;
  triangleId?: number;
  barycentric?: Barycentric;
}

/** Size of a billboard in world units, after the billboard scale factor is applied. */
export interface LabelDimensions {
  width: number;
  height: number;
}

export interface SpatialLabel {
  id: string;
  /** Immutable once added: the (anchorId, labelId) pair is a topological invariant. */
  anchorId: string;
  /** World position. On `addLabel` it is used as warm start only when `initialization` is "provided". */
  position: Vec3;
  dimensions: LabelDimensions;
  /** Higher priority labels move less and are hidden last. */
  priority: number;
  /** User visibility toggle. Hidden labels do not take part in collisions. */
  visible: boolean;
  /** Disabled labels are ignored by the solver entirely. */
  enabled: boolean;
  /** Extension: leader routing for this label (default: engine config). */
  routing?: LeaderRouting;
  /** Extension: free payload for adapters (text, style id...). Never read by the solver. */
  userData?: unknown;
}

export type LeaderRouting = "straight" | "elbow" | "polyline";

export interface LabelLeader {
  id: string;
  anchorId: string;
  labelId: string;
  routing: LeaderRouting;
}

export interface Viewport {
  width: number;
  height: number;
}

/**
 * One rendering viewpoint (mono camera, or one XR eye).
 *
 * Matrix convention: 16 floats, column-major storage, column vectors,
 * translation at indices 12, 13, 14 (WebGL / three.js `elements` /
 * Babylon.js `Matrix.m` all share this memory layout).
 * Handedness and NDC depth range are free: the core only relies on clip `w`
 * and on the view matrix rows, which are handedness-agnostic.
 */
export interface CameraView {
  viewMatrix: Float32Array | ArrayLike<number>;
  projectionMatrix: Float32Array | ArrayLike<number>;
  viewport: Viewport;
  /** Extension: stable identifier ("mono", "left", "right"...). */
  id?: string;
}

export interface LayoutContext {
  /** Views to validate (one for mono, two for stereo XR). */
  views: CameraView[];
  /** Seconds since the previous `solve` call. */
  deltaTime: number;
  /**
   * Extension: central pose used to propose placements (brief section 5).
   * Defaults to `views[0]`. For WebXR, pass the head (center-eye) pose.
   */
  referenceView?: CameraView;
  /** Extension: force a full re-layout (large reference-frame change, AR/VR switch). */
  forceReset?: boolean;
}

export type HiddenReason =
  | "disabled"
  | "user-hidden"
  | "missing-anchor"
  | "anchor-behind-camera"
  | "decluttered"
  | "out-of-view";

export interface LabelPlacement {
  id: string;
  position: Vec3;
  visible: boolean;
  /** Extension: the leader end attached to the pin. */
  anchorId?: string;
  /** Extension: world position of the anchor used for this solve. */
  anchorPosition?: Vec3 | null;
  /** Extension: why the label is not visible. */
  hiddenReason?: HiddenReason;
  /** Extension: label center occluded in at least one view. */
  occluded?: boolean;
  /** Extension: label still collides in at least one view after solving. */
  colliding?: boolean;
}

export interface LayoutResult {
  placements: LabelPlacement[];
  converged: boolean;
  iterations: number;
  unresolvedCollisions: number;
  unresolvedOcclusions: number;
  computationTimeMs: number;
  /** Extension: detailed diagnostics; present on every result produced by the core engine. */
  diagnostics?: LayoutDiagnostics;
}

export interface ViewMetrics {
  viewIndex: number;
  viewId?: string;
  /** Overlapping label pairs in this view. */
  collisions: number;
  /** Visible labels whose center is occluded in this view. */
  occlusions: number;
  /** Leader crossings in this view. */
  crossings: number;
  /** Visible labels whose projected rectangle leaves the viewport. */
  outOfView: number;
}

export interface EnergyBreakdown {
  overlap: number;
  crossing: number;
  motion: number;
  occlusion: number;
  depth: number;
  total: number;
}

export type DiagnosticCode =
  | "no-views"
  | "invalid-view"
  | "missing-anchor"
  | "anchor-behind-camera"
  | "label-out-of-view"
  | "unresolved-collision"
  | "impossible-density"
  | "label-decluttered"
  | "stereo-only-collision"
  | "iteration-budget-exhausted"
  | "solve-skipped";

export interface LayoutDiagnostic {
  code: DiagnosticCode;
  message: string;
  labelIds?: string[];
  viewIndex?: number;
}

export interface LayoutDiagnostics {
  /** True when the temporal stabilizer reused the previous layout. */
  skipped: boolean;
  reason?: string;
  perView: ViewMetrics[];
  energy: EnergyBreakdown;
  /** Sum of world distances travelled by labels during this solve. */
  distanceTravelled: number;
  /** Pairs still overlapping in the worst view. */
  collidingPairs: Array<[string, string]>;
  hiddenLabels: Array<{ id: string; reason: HiddenReason }>;
  messages: LayoutDiagnostic[];
}
