import { ScreenAlignedOrienter, type BillboardOrienter } from "../billboard/orienter.js";
import { QuadTreeIndex } from "../collision/quadtree.js";
import type { SpatialIndexFactory } from "../collision/spatial-index.js";
import { defaultTemporalConfig, type TemporalConfig } from "../temporal/stabilizer.js";
import type { LeaderRouting } from "../types.js";
import { RadialCandidateGenerator, type CandidateGenerator } from "./candidates.js";
import type { DeclutterStrategy } from "./declutter.js";

/** Weights of E = wo*Eoverlap + wx*Ecrossing + wm*Emotion + wa*Eocclusion + wd*Edepth (brief 4.1). */
export interface LayoutWeights {
  overlap: number;
  crossing: number;
  motion: number;
  occlusion: number;
  depth: number;
  /** Soft pull keeping leaders short. Not a hard constraint (brief 4.1). */
  anchorPull: number;
}

/**
 * - "free": no depth preference.
 * - "surface-relative": labels prefer the anchor's distance to the camera (+ offset).
 * - "comfort-depth": labels prefer a distance range (XR ergonomics).
 */
export type DepthMode = "free" | "surface-relative" | "comfort-depth";

export interface DepthConfig {
  mode: DepthMode;
  /** "surface-relative": added to the anchor distance (negative = closer to the viewer). */
  surfaceOffset: number;
  /** "comfort-depth": preferred distance range from the reference camera. */
  comfortRange: { min: number; max: number };
  /** Hard XR comfort limits on the distance to the reference camera, applied in every mode. */
  limits?: { min: number; max: number };
}

/** Brief section 10: pin behind the camera. */
export type BehindCameraPolicy = "hide" | "reposition" | "keep";

export type InitializationMode = "candidates" | "provided";

export interface SolverConfig {
  maxIterations: number;
  /** Extra relaxation after crossing swaps / occlusion moves / repairs. */
  refinementIterations: number;
  /** Discrete re-placement rounds for collisions left by the continuous relaxation. */
  repairRounds: number;
  /** Gap kept between projected labels (pixels). */
  paddingPx: number;
  /** Inset of the viewport labels must stay inside (pixels). */
  viewportMarginPx: number;
  keepInViewport: boolean;
  /** Labels also avoid covering anchors (pins) of radius `anchorRadiusPx`. */
  avoidAnchors: boolean;
  anchorRadiusPx: number;
  /** Overlaps smaller than this (pixels, on both axes) are not reported as collisions. */
  collisionTolerancePx: number;
  /** Stop when the largest per-iteration motion is below this (pixels). */
  convergenceTolerancePx: number;
  /** Fraction of the separation applied per iteration (0..1]. */
  relaxation: number;
  weights: LayoutWeights;
  depth: DepthConfig;
  behindCamera: BehindCameraPolicy;
  initialization: InitializationMode;
  /** Preferred distance between anchor and the label edge (pixels). */
  leaderLengthPx: number;
  minimizeCrossings: boolean;
  maxSwapsPerSolve: number;
  avoidOcclusion: boolean;
  /** A label counts as occluded when its center is hidden in "any" or "all" views. */
  occlusionMode: "any" | "all";
  maxOcclusionRelocations: number;
  /** Hide low-priority labels when density makes a collision-free layout impossible. */
  declutter: { enabled: boolean; strategy?: DeclutterStrategy };
  defaultRouting: LeaderRouting;
  /** Verify (anchorId, labelId) pairs after each solve; throws TopologyError on violation. */
  validateTopology: boolean;
  temporal: TemporalConfig;
  orienter: BillboardOrienter;
  spatialIndex: SpatialIndexFactory;
  candidates: CandidateGenerator;
  /** Injectable clock (ms) for deterministic tests. */
  now: () => number;
}

export type SolverConfigInput = Partial<Omit<SolverConfig, "weights" | "depth" | "temporal" | "declutter">> & {
  weights?: Partial<LayoutWeights>;
  depth?: Partial<DepthConfig>;
  temporal?: Partial<TemporalConfig>;
  declutter?: Partial<SolverConfig["declutter"]>;
};

const defaultNow = (): number => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

export const defaultSolverConfig = (): SolverConfig => ({
  maxIterations: 60,
  refinementIterations: 20,
  repairRounds: 3,
  paddingPx: 4,
  viewportMarginPx: 8,
  keepInViewport: true,
  avoidAnchors: true,
  anchorRadiusPx: 4,
  collisionTolerancePx: 0.5,
  convergenceTolerancePx: 0.25,
  relaxation: 0.9,
  weights: { overlap: 1, crossing: 0.5, motion: 0.3, occlusion: 1, depth: 0.2, anchorPull: 0.3 },
  depth: { mode: "surface-relative", surfaceOffset: 0, comfortRange: { min: 0.75, max: 5 } },
  behindCamera: "hide",
  initialization: "candidates",
  leaderLengthPx: 24,
  minimizeCrossings: true,
  maxSwapsPerSolve: 32,
  avoidOcclusion: true,
  occlusionMode: "any",
  maxOcclusionRelocations: 32,
  declutter: { enabled: false },
  defaultRouting: "straight",
  validateTopology: true,
  temporal: defaultTemporalConfig(),
  orienter: new ScreenAlignedOrienter(),
  // Quadtree by default: adapts to dense hotspots. UniformGridIndex remains available.
  spatialIndex: () => new QuadTreeIndex(),
  candidates: new RadialCandidateGenerator(),
  now: defaultNow,
});

export const resolveSolverConfig = (input: SolverConfigInput = {}, base: SolverConfig = defaultSolverConfig()): SolverConfig => {
  const { weights, depth, temporal, declutter, ...rest } = input;
  const cleaned = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<SolverConfig>;
  return {
    ...base,
    ...cleaned,
    weights: { ...base.weights, ...stripUndefined(weights) },
    depth: { ...base.depth, ...stripUndefined(depth) },
    temporal: { ...base.temporal, ...stripUndefined(temporal) },
    declutter: { ...base.declutter, ...stripUndefined(declutter) },
  };
};

const stripUndefined = <T extends object>(o: T | undefined): Partial<T> =>
  o ? (Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>) : {};
