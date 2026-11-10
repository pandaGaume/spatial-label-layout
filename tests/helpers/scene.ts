import {
  createCameraView,
  createStereoViews,
  SpatialLabelLayoutEngine,
  type CameraView,
  type EngineOptions,
  type Handedness,
  type SpatialLabel,
  type Vec3,
} from "@spacexr/spatial-label-layout-core";

export const VIEWPORT = { width: 1280, height: 720 };

/** Deterministic PRNG (mulberry32). */
export const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const monoView = (eye: Vec3 = { x: 0, y: 6, z: 14 }, target: Vec3 = { x: 0, y: 0, z: 0 }, handedness: Handedness = "right"): CameraView =>
  createCameraView({ eye, target, viewport: VIEWPORT, handedness, id: "mono" });

export const stereo = (ipd = 0.064, eye: Vec3 = { x: 0, y: 6, z: 14 }, target: Vec3 = { x: 0, y: 0, z: 0 }) =>
  createStereoViews({ eye, target, viewport: VIEWPORT, ipd });

export const makeLabel = (id: string, anchorId: string, extra: Partial<SpatialLabel> = {}): SpatialLabel => ({
  id,
  anchorId,
  position: { x: 0, y: 0, z: 0 },
  dimensions: { width: 1.2, height: 0.4 },
  priority: 1,
  visible: true,
  enabled: true,
  ...extra,
});

export interface SceneOptions {
  count: number;
  seed?: number;
  /** Half extent of the square area holding anchors (world units). */
  spread?: number;
  /** Max terrain-like height of anchors. */
  height?: number;
  engine?: EngineOptions;
}

/** Anchors scattered on a bumpy plane around the origin, one label per anchor. */
export const randomScene = (o: SceneOptions): { engine: SpatialLabelLayoutEngine; anchors: Map<string, Vec3> } => {
  const r = rng(o.seed ?? 1);
  const spread = o.spread ?? 8;
  const engine = new SpatialLabelLayoutEngine({ temporal: { enabled: false }, ...o.engine });
  const anchors = new Map<string, Vec3>();
  for (let i = 0; i < o.count; i++) {
    const p = { x: (r() * 2 - 1) * spread, y: r() * (o.height ?? 1), z: (r() * 2 - 1) * spread };
    anchors.set(`a${i}`, p);
    engine.setAnchorPosition(`a${i}`, p);
    engine.addLabel(makeLabel(`l${i}`, `a${i}`, { priority: Math.floor(r() * 3), dimensions: { width: 0.6 + r() * 0.6, height: 0.25 } }));
  }
  return { engine, anchors };
};

export const orbit = (angle: number, radius = 14, height = 6): Vec3 => ({ x: Math.sin(angle) * radius, y: height, z: Math.cos(angle) * radius });
