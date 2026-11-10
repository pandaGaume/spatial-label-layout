import { SpatialLabelLayoutEngine, createCameraView, createStereoViews, type CameraView, type EngineOptions } from "@spatial-label-layout/core";

export const VIEWPORT = { width: 1920, height: 1080 };

const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const terrainHeight = (x: number, z: number): number => 1.2 * Math.sin(x * 0.35) * Math.cos(z * 0.3) + 0.4 * Math.sin(x * 1.1 + z * 0.7);

export type Density = "uniform" | "clustered";

/** Labels over a terrain-like heightfield; "clustered" puts 60% of pins in a small hotspot. */
export const buildScene = (count: number, density: Density = "uniform", options: EngineOptions = {}, seed = 1): SpatialLabelLayoutEngine => {
  const r = rng(seed);
  const engine = new SpatialLabelLayoutEngine({ temporal: { enabled: false }, ...options });
  const spread = 12;
  for (let i = 0; i < count; i++) {
    const hot = density === "clustered" && r() < 0.6;
    const x = hot ? (r() - 0.5) * 3 : (r() * 2 - 1) * spread;
    const z = hot ? (r() - 0.5) * 3 : (r() * 2 - 1) * spread;
    engine.setAnchorPosition(`a${i}`, { x, y: terrainHeight(x, z), z });
    engine.addLabel({
      id: `l${i}`,
      anchorId: `a${i}`,
      position: { x, y: 0, z },
      dimensions: { width: 0.5 + r() * 0.5, height: 0.18 },
      priority: Math.floor(r() * 4),
      visible: true,
      enabled: true,
    });
  }
  return engine;
};

export const orbitView = (angle: number, radius = 22, height = 11): CameraView =>
  createCameraView({
    eye: { x: Math.sin(angle) * radius, y: height, z: Math.cos(angle) * radius },
    target: { x: 0, y: 0, z: 0 },
    viewport: VIEWPORT,
    id: "mono",
  });

export const orbitStereo = (angle: number, radius = 22, height = 11) =>
  createStereoViews({
    eye: { x: Math.sin(angle) * radius, y: height, z: Math.cos(angle) * radius },
    target: { x: 0, y: 0, z: 0 },
    viewport: VIEWPORT,
  });
