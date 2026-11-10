/**
 * Impossible density: 300 labels around one hotspot. Shows the explicit
 * diagnostics, then the priority declutter fallback.
 *   pnpm example:dense
 */
import { SpatialLabelLayoutEngine, createCameraView, type LayoutResult } from "@spatial-label-layout/core";
import { formatResult, renderViewSvg } from "@spatial-label-layout/debug";
import { rng, writeOut } from "../shared.js";

const view = createCameraView({ eye: { x: 0, y: 8, z: 16 }, target: { x: 0, y: 0, z: 0 }, viewport: { width: 1280, height: 720 } });

const run = (declutter: boolean): { engine: SpatialLabelLayoutEngine; result: LayoutResult } => {
  const r = rng(7);
  const engine = new SpatialLabelLayoutEngine({ declutter: { enabled: declutter } });
  for (let i = 0; i < 300; i++) {
    const p = { x: (r() - 0.5) * 4, y: 0, z: (r() - 0.5) * 4 };
    engine.setAnchorPosition(`a${i}`, p);
    engine.addLabel({
      id: `l${i}`,
      anchorId: `a${i}`,
      position: p,
      dimensions: { width: 1 + r(), height: 0.35 },
      priority: Math.floor(r() * 5),
      visible: true,
      enabled: true,
    });
  }
  return { engine, result: engine.solve({ views: [view], deltaTime: 0 }) };
};

for (const declutter of [false, true]) {
  const { engine, result } = run(declutter);
  console.log(`\ndeclutter=${declutter}: ${formatResult(result)}`);
  for (const m of result.diagnostics?.messages ?? []) console.log(`  [${m.code}] ${m.message}`);
  const svg = renderViewSvg(engine.inspect({ views: [view], deltaTime: 0 }).views[0]!, { title: `dense, declutter=${declutter}`, text: () => "" });
  console.log("  SVG:", writeOut(import.meta.url, `dense-declutter-${declutter}.svg`, svg));
}
