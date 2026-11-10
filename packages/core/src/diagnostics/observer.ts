import type { LayoutContext, LayoutResult } from "../types.js";

export type SolvePhase = "initialize" | "relax" | "crossings" | "occlusion" | "refine" | "repair" | "declutter" | "evaluate";

export interface IterationStats {
  phase: SolvePhase;
  iteration: number;
  /** Overlapping pairs found (all views) before applying this iteration's corrections. */
  collisions: number;
  /** Pin-covering and viewport violations above tolerance. */
  violations: number;
  /** Largest label displacement this iteration (pixels in the reference view). */
  maxStepPx: number;
}

/**
 * Instrumentation hook (brief: debug package). All members optional so a
 * profiler, a debug overlay or a test spy can implement only what it needs.
 */
export interface LayoutObserver {
  onSolveStart?(context: LayoutContext): void;
  onIteration?(stats: IterationStats): void;
  onPhase?(phase: SolvePhase, detail: Record<string, number>): void;
  onSolveEnd?(result: LayoutResult): void;
}
