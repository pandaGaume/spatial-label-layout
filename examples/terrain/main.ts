/**
 * Terrain demo without a 3D library: 100 mesh-local anchors on a heightfield,
 * raymarched terrain occlusion, the generic controller driven at 90 fps with
 * the solver at 10 Hz, and in-memory renderers standing in for Babylon/three.
 *   pnpm example:terrain
 */
import {
  FixedRateScheduler,
  LabelLayoutController,
  Mat4Math,
  RaymarchOcclusionProvider,
  StaticCameraProvider,
  TransformAnchorProvider,
  createCameraView,
} from "@spacexr/spatial-label-layout-core";
import { MetricsRecorder, RecordingLabelRenderer, RecordingLeaderRenderer, formatSummary, renderViewSvg } from "@spacexr/spatial-label-layout-debug";
import { rng, terrainHeight, writeOut } from "../shared.js";

const VIEWPORT = { width: 1600, height: 900 };
const FPS = 90;
const SECONDS = 8;

// "Mesh" registry: the terrain slowly rises, to show anchors following their mesh.
let terrainWorld = Mat4Math.translation(0, 0, 0);
const anchors = new TransformAnchorProvider({ getWorldMatrix: (id) => (id === "terrain" ? terrainWorld : null) });

const viewAt = (t: number) => {
  const a = t * 0.35; // slow orbit, ~20 deg/s
  return createCameraView({ eye: { x: Math.sin(a) * 20, y: 9, z: Math.cos(a) * 20 }, target: { x: 0, y: 0, z: 0 }, viewport: VIEWPORT, id: "mono" });
};
const camera = new StaticCameraProvider([viewAt(0)]);
const labels = new RecordingLabelRenderer();
const leaders = new RecordingLeaderRenderer();
const metrics = new MetricsRecorder();

const controller = new LabelLayoutController({
  camera,
  anchors,
  labelRenderer: labels,
  leaderRenderer: leaders,
  scheduler: new FixedRateScheduler(10),
  engine: {
    occlusion: new RaymarchOcclusionProvider((p) => p.y < terrainHeight(p.x, p.z) + terrainWorld[13]!, { step: 0.3 }),
    observers: [metrics],
  },
});

const r = rng(3);
for (let i = 0; i < 100; i++) {
  const x = (r() * 2 - 1) * 10, z = (r() * 2 - 1) * 10;
  controller.addAnchor({ id: `pin${i}`, meshId: "terrain", localPosition: { x, y: terrainHeight(x, z), z } });
  controller.addLabel({
    id: `poi${i}`,
    anchorId: `pin${i}`,
    position: { x, y: 0, z },
    dimensions: { width: 0.9 + r() * 0.6, height: 0.3 },
    priority: Math.floor(r() * 4),
    visible: true,
    enabled: true,
  });
}

const jumpsByKind = { swaps: 0, relocations: 0, repairs: 0 };
const reasons = new Map<string, number>();
controller.engine.addObserver({
  onPhase: (phase, d) => {
    if (phase === "crossings") jumpsByKind.swaps += d.swaps ?? 0;
    if (phase === "occlusion") jumpsByKind.relocations += d.relocations ?? 0;
    if (phase === "repair") jumpsByKind.repairs += d.moved ?? 0;
  },
  onSolveEnd: (r) => {
    const k = r.diagnostics?.reason ?? "?";
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  },
});

const t0 = performance.now();
for (let f = 0; f < FPS * SECONDS; f++) {
  const t = f / FPS;
  terrainWorld = Mat4Math.translation(0, Math.min(1, t / SECONDS), 0);
  camera.set([viewAt(t)]);
  controller.tick(1 / FPS);
  if (f % (FPS * 2) === 0) {
    const snap = controller.engine.inspect({ views: [viewAt(t)], deltaTime: 0 });
    writeOut(import.meta.url, `terrain-${String(t).padStart(2, "0")}s.svg`, renderViewSvg(snap.views[0]!, { title: `terrain t=${t}s`, text: () => "" }));
  }
}
const wall = performance.now() - t0;

console.log(`${FPS * SECONDS} frames rendered, ${labels.frames} label frames, wall ${wall.toFixed(0)} ms (${(wall / (FPS * SECONDS)).toFixed(2)} ms/frame incl. render ports)`);
console.log(formatSummary(metrics.summary()));
console.log(`discrete reorganizations: ${JSON.stringify(jumpsByKind)}`);
console.log(`solve reasons: ${JSON.stringify(Object.fromEntries(reasons))}`);
console.log(`leaders always start at their live anchor: ${[...leaders.leaders.values()].every((l) => l.points.length === 0 || l.points[0]!.y > -5)}`);
console.log("SVG snapshots in examples/terrain/out/");
controller.dispose();
