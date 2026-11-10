/**
 * Performance budget report (brief section 11): solve time and quality
 * metrics over a 360 degree orbit, mono and stereo, 10 / 100 / 500 labels.
 * Run: pnpm bench:budget
 */
import { FixedRateScheduler, LabelLayoutController } from "@spatial-label-layout/core";
import { MetricsRecorder } from "@spatial-label-layout/debug";
import { buildScene, orbitStereo, orbitView } from "./scenes.js";

const TARGET_MS: Record<number, number> = { 100: 5, 500: 15 };
const STEPS = 72;

const rows: string[][] = [["labels", "mode", "density", "mean ms", "p95 ms", "max ms", "target", "converged", "collisions/view", "crossings"]];

for (const count of [10, 100, 500]) {
  for (const mode of ["mono", "stereo"] as const) {
    for (const density of ["uniform", "clustered"] as const) {
      const engine = buildScene(count, density);
      const metrics = new MetricsRecorder();
      engine.solve({ views: [orbitView(0)], deltaTime: 0.1 }); // cold start excluded
      engine.addObserver(metrics);
      for (let i = 1; i <= STEPS; i++) {
        const a = (i / STEPS) * Math.PI * 2;
        if (mode === "mono") engine.solve({ views: [orbitView(a)], deltaTime: 0.1 });
        else {
          const { center, left, right } = orbitStereo(a);
          engine.solve({ views: [left, right], referenceView: center, deltaTime: 0.1 });
        }
      }
      const s = metrics.summary();
      const target = TARGET_MS[count];
      rows.push([
        String(count),
        mode,
        density,
        s.meanMs.toFixed(2),
        s.p95Ms.toFixed(2),
        s.maxMs.toFixed(2),
        target ? `<${target} ${s.meanMs < target ? "ok" : "MISS"}` : "-",
        `${s.converged}/${s.solves}`,
        s.meanCollisionsPerView.map((c) => c.toFixed(2)).join("/"),
        s.meanCrossings.toFixed(1),
      ]);
    }
  }
}

const print = (table: string[][]): void => {
  const widths = table[0]!.map((_, c) => Math.max(...table.map((r) => r[c]!.length)));
  for (const r of table) console.log(r.map((v, c) => v.padEnd(widths[c]!)).join("  "));
};
console.log("Worst case: full solve every 5 degrees of orbit, temporal stabilization off.\n");
print(rows);

/**
 * Realistic XR loop: 90 fps rendering, solver at 10 Hz through the controller,
 * temporal stabilization on, slow orbit (20 deg/s) with head jitter.
 * Reports the amortized cost per rendered frame and discrete reorganizations.
 */
const realistic: string[][] = [["labels", "frames", "solves", "skipped", "ms/frame (amortized)", "solve p95 ms", "jumps/s", "collisions/view"]];
for (const count of [100, 500]) {
  const engine = buildScene(count, "uniform", { temporal: { enabled: true } });
  const metrics = new MetricsRecorder();
  engine.addObserver(metrics);
  let jumps = 0;
  engine.addObserver({
    onPhase: (phase, d) => {
      if (phase === "crossings") jumps += d.swaps ?? 0;
      if (phase === "occlusion") jumps += d.relocations ?? 0;
      if (phase === "repair") jumps += d.moved ?? 0;
    },
  });
  let t = 0;
  const camera = { getViews: () => [orbitView(t * 0.35 + Math.sin(t * 7) * 0.004)] };
  const controller = new LabelLayoutController({ camera, engine, scheduler: new FixedRateScheduler(10) });
  const FPS = 90, SECONDS = 10;
  controller.tick(1 / FPS); // cold start excluded
  metrics.clear();
  jumps = 0;
  const t0 = performance.now();
  for (let f = 1; f < FPS * SECONDS; f++) {
    t = f / FPS;
    controller.tick(1 / FPS);
  }
  const wall = performance.now() - t0;
  const s = metrics.summary();
  realistic.push([
    String(count),
    String(FPS * SECONDS - 1),
    String(s.solves),
    String(s.skipped),
    (wall / (FPS * SECONDS - 1)).toFixed(3),
    s.p95Ms.toFixed(2),
    (jumps / SECONDS).toFixed(2),
    s.meanCollisionsPerView.map((c) => c.toFixed(2)).join("/"),
  ]);
}
console.log("\nRealistic loop: 90 fps render, 10 Hz solver, temporal stabilization on, 20 deg/s orbit + head jitter.\n");
print(realistic);
console.log(`\nNode ${process.version}, ${process.platform}/${process.arch}. Indicative only: measure on the reference XR machine.`);
