/**
 * Minimal use of the engine without any rendering library:
 * anchors in world space, one solve, a debug SVG of the result.
 *   pnpm example:basic
 */
import { SpatialLabelLayoutEngine, createCameraView } from "@spatial-label-layout/core";
import { formatResult, renderViewSvg } from "@spatial-label-layout/debug";
import { writeOut } from "../shared.js";

const engine = new SpatialLabelLayoutEngine();

const pins = [
  { id: "summit", p: { x: 0, y: 2, z: 0 } },
  { id: "hut", p: { x: 0.4, y: 1.6, z: 0.3 } },
  { id: "lake", p: { x: -2, y: 0, z: 1 } },
  { id: "bridge", p: { x: 2.5, y: 0.2, z: -1 } },
  { id: "camp", p: { x: 0.2, y: 1.8, z: -0.2 } },
];
for (const { id, p } of pins) {
  engine.setAnchorPosition(id, p);
  engine.addLabel({
    id: `label-${id}`,
    anchorId: id,
    position: p,
    dimensions: { width: 1.4, height: 0.4 },
    priority: id === "summit" ? 5 : 1,
    visible: true,
    enabled: true,
  });
}

const view = createCameraView({ eye: { x: 0, y: 4, z: 9 }, target: { x: 0, y: 1, z: 0 }, viewport: { width: 1280, height: 720 } });
const result = engine.solve({ views: [view], deltaTime: 0 });
console.log(formatResult(result));
for (const p of result.placements) console.log(`  ${p.id.padEnd(14)} -> (${p.position.x.toFixed(2)}, ${p.position.y.toFixed(2)}, ${p.position.z.toFixed(2)}) visible=${p.visible}`);

const snapshot = engine.inspect({ views: [view], deltaTime: 0 });
console.log("SVG:", writeOut(import.meta.url, "basic.svg", renderViewSvg(snapshot.views[0]!, { title: "basic" })));
