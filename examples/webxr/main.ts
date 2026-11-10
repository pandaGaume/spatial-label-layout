/**
 * Simulated WebXR session: two eyes plus a center reference pose, head
 * jitter, a session restart (reference-space change) and per-eye metrics.
 * In a browser, the adapter would build these CameraViews from
 * `XRFrame.getViewerPose(refSpace).views` (`view.transform.inverse.matrix`
 * and `view.projectionMatrix`).
 *   pnpm example:webxr
 */
import { FixedRateScheduler, LabelLayoutController, StaticCameraProvider, createStereoViews } from "@spacexr/spatial-label-layout-core";
import { MetricsRecorder, RecordingLabelRenderer, RecordingLeaderRenderer, formatSummary, renderViewSvg } from "@spacexr/spatial-label-layout-debug";
import { rng, writeOut } from "../shared.js";

const VIEWPORT = { width: 1680, height: 1760 }; // Quest-3-like per-eye resolution
const head = (t: number) => {
  // Small natural head motion: ~1 deg yaw sway, 1 cm bob.
  const yaw = Math.sin(t * 1.3) * 0.017;
  const eye = { x: 0, y: 1.6 + Math.sin(t * 2.1) * 0.01, z: 0 };
  return createStereoViews({
    eye,
    target: { x: Math.sin(yaw) * 3, y: 1.4, z: -Math.cos(yaw) * 3 },
    viewport: VIEWPORT,
    fovY: (100 * Math.PI) / 180,
    ipd: 0.063,
    near: 0.05,
  });
};

const first = head(0);
const camera = new StaticCameraProvider([first.left, first.right], first.center);
const metrics = new MetricsRecorder();
const controller = new LabelLayoutController({
  camera,
  labelRenderer: new RecordingLabelRenderer(),
  leaderRenderer: new RecordingLeaderRenderer(),
  scheduler: new FixedRateScheduler(10),
  engine: {
    observers: [metrics],
    depth: { mode: "comfort-depth", comfortRange: { min: 1, max: 4 }, limits: { min: 0.6, max: 6 } },
  },
});

// A shelf of objects 2-4 m in front of the user.
const r = rng(5);
for (let i = 0; i < 40; i++) {
  const p = { x: (r() - 0.5) * 3, y: 0.8 + r() * 1.2, z: -2 - r() * 2 };
  controller.engine.setAnchorPosition(`obj${i}`, p);
  controller.addLabel({ id: `tag${i}`, anchorId: `obj${i}`, position: p, dimensions: { width: 0.22, height: 0.06 }, priority: 1, visible: true, enabled: true });
}

const FPS = 90;
for (let f = 0; f < FPS * 6; f++) {
  const t = f / FPS;
  const v = head(t);
  camera.set([v.left, v.right], v.center);
  if (f === FPS * 3) camera.bumpReferenceFrame(); // e.g. XR session restarted / recentered
  controller.tick(1 / FPS);
}

console.log(formatSummary(metrics.summary()));
const v = head(6);
const snap = controller.engine.inspect({ views: [v.left, v.right], referenceView: v.center, deltaTime: 0 });
snap.views.forEach((vs) => writeOut(import.meta.url, `eye-${vs.viewId}.svg`, renderViewSvg(vs, { title: `eye ${vs.viewId}`, text: () => "" })));
console.log("per-eye SVG snapshots in examples/webxr/out/");
controller.dispose();
