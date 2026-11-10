import type { IterationStats, LayoutObserver, LayoutResult } from "@spacexr/spatial-label-layout-core";

export interface MetricsSummary {
  solves: number;
  skipped: number;
  converged: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  meanIterations: number;
  /** Mean residual collisions per view index (e.g. [left, right]). */
  meanCollisionsPerView: number[];
  meanOcclusions: number;
  meanCrossings: number;
  totalDistanceTravelled: number;
}

/**
 * Brief section 11 metrics: collisions per eye, occlusions, crossings,
 * travelled distance, solve time, convergence. Attach with `engine.addObserver()`.
 */
export class MetricsRecorder implements LayoutObserver {
  private readonly results: LayoutResult[] = [];
  private readonly iterations: IterationStats[] = [];

  constructor(private readonly keepIterations = false) {}

  onIteration(stats: IterationStats): void {
    if (this.keepIterations) this.iterations.push(stats);
  }

  onSolveEnd(result: LayoutResult): void {
    this.results.push(result);
  }

  get history(): readonly LayoutResult[] {
    return this.results;
  }

  get iterationHistory(): readonly IterationStats[] {
    return this.iterations;
  }

  clear(): void {
    this.results.length = 0;
    this.iterations.length = 0;
  }

  summary(): MetricsSummary {
    const solved = this.results.filter((r) => !r.diagnostics?.skipped);
    const times = solved.map((r) => r.computationTimeMs).sort((a, b) => a - b);
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    const perView: number[][] = [];
    for (const r of solved) {
      for (const v of r.diagnostics?.perView ?? []) (perView[v.viewIndex] ??= []).push(v.collisions);
    }
    return {
      solves: solved.length,
      skipped: this.results.length - solved.length,
      converged: solved.filter((r) => r.converged).length,
      meanMs: mean(times),
      p95Ms: times.length ? (times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] as number) : 0,
      maxMs: times.length ? (times[times.length - 1] as number) : 0,
      meanIterations: mean(solved.map((r) => r.iterations)),
      meanCollisionsPerView: perView.map((xs) => mean(xs)),
      meanOcclusions: mean(solved.map((r) => r.unresolvedOcclusions)),
      meanCrossings: mean(solved.map((r) => r.diagnostics?.perView[0]?.crossings ?? 0)),
      totalDistanceTravelled: solved.reduce((s, r) => s + (r.diagnostics?.distanceTravelled ?? 0), 0),
    };
  }
}

export const formatSummary = (s: MetricsSummary): string =>
  [
    `solves=${s.solves} skipped=${s.skipped} converged=${s.converged}`,
    `time mean=${s.meanMs.toFixed(2)}ms p95=${s.p95Ms.toFixed(2)}ms max=${s.maxMs.toFixed(2)}ms`,
    `iterations mean=${s.meanIterations.toFixed(1)}`,
    `collisions/view=[${s.meanCollisionsPerView.map((c) => c.toFixed(2)).join(", ")}] occlusions=${s.meanOcclusions.toFixed(2)} crossings=${s.meanCrossings.toFixed(2)}`,
    `distance travelled=${s.totalDistanceTravelled.toFixed(3)}`,
  ].join("\n");

/** One-line human-readable result, for logs. */
export const formatResult = (r: LayoutResult): string => {
  const d = r.diagnostics;
  const views = d?.perView.map((v) => `${v.viewId ?? v.viewIndex}:c${v.collisions}/x${v.crossings}/o${v.occlusions}`).join(" ") ?? "";
  return `${r.converged ? "converged" : "NOT converged"} in ${r.iterations} it, ${r.computationTimeMs.toFixed(2)} ms, collisions=${r.unresolvedCollisions}, occlusions=${r.unresolvedOcclusions}${d?.skipped ? " (skipped)" : ""} ${views}`;
};
