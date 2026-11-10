import { describe, expect, it } from "vitest";
import { SpatialLabelLayoutEngine } from "@spacexr/spatial-label-layout-core";
import { makeLabel, randomScene, stereo } from "../helpers/scene.js";

describe("stereo / WebXR validation", () => {
  it("validates every eye independently and reports per-eye metrics", () => {
    const { center, left, right } = stereo();
    const { engine } = randomScene({ count: 100, seed: 42 });
    const r = engine.solve({ views: [left, right], referenceView: center, deltaTime: 1 / 10 });
    expect(r.diagnostics?.perView.map((v) => v.viewId)).toEqual(["left", "right"]);
    for (const v of r.diagnostics?.perView ?? []) expect(v.collisions).toBe(0);
    expect(r.unresolvedCollisions).toBe(0);
  });

  it("detects and fixes a collision that exists in one eye only", () => {
    // Exaggerated IPD so the parallax between a near and a far label is large.
    const { center, left, right } = stereo(0.6, { x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 });
    const engine = new SpatialLabelLayoutEngine({
      temporal: { enabled: false },
      initialization: "provided",
      depth: { mode: "free" },
      weights: { anchorPull: 0, motion: 0 },
      avoidAnchors: false,
      minimizeCrossings: false,
    });
    // Near label (5 m from the eyes) and far label (14 m), side by side in the center view.
    engine.setAnchorPosition("near", { x: -1, y: -1, z: 5 });
    engine.setAnchorPosition("far", { x: 1, y: -1, z: -4 });
    engine.addLabel(makeLabel("near", "near", { position: { x: -0.62, y: 0, z: 5 }, dimensions: { width: 1, height: 0.4 } }));
    engine.addLabel(makeLabel("far", "far", { position: { x: 0.95, y: 0, z: -4 }, dimensions: { width: 2.8, height: 1.12 } }));

    const views = [left, right];
    const before = engine.inspect({ views, referenceView: center, deltaTime: 0 });
    const collidingBefore = before.views.map((v) => v.collidingPairs.length);
    // Precondition of the scenario: overlap in exactly one eye.
    expect(collidingBefore.filter((c) => c > 0)).toHaveLength(1);

    const r = engine.solve({ views, referenceView: center, deltaTime: 0.1 });
    expect(r.unresolvedCollisions).toBe(0);
    for (const v of engine.inspect({ views, referenceView: center, deltaTime: 0 }).views) expect(v.collidingPairs).toEqual([]);
  });

  it("flags stereo-only residual collisions in diagnostics", () => {
    const { center, left, right } = stereo(0.6, { x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 });
    const engine = new SpatialLabelLayoutEngine({
      temporal: { enabled: false },
      initialization: "provided",
      depth: { mode: "free" },
      maxIterations: 0,
      refinementIterations: 0,
      repairRounds: 0,
      minimizeCrossings: false,
      avoidAnchors: false,
    });
    engine.setAnchorPosition("near", { x: -1, y: -1, z: 5 });
    engine.setAnchorPosition("far", { x: 1, y: -1, z: -4 });
    engine.addLabel(makeLabel("near", "near", { position: { x: -0.62, y: 0, z: 5 }, dimensions: { width: 1, height: 0.4 } }));
    engine.addLabel(makeLabel("far", "far", { position: { x: 0.95, y: 0, z: -4 }, dimensions: { width: 2.8, height: 1.12 } }));
    const r = engine.solve({ views: [left, right], referenceView: center, deltaTime: 0.1 });
    expect(r.diagnostics?.messages.map((m) => m.code)).toContain("stereo-only-collision");
  });

  it("applies XR comfort depth limits", () => {
    const { center, left, right } = stereo();
    const engine = new SpatialLabelLayoutEngine({
      temporal: { enabled: false },
      depth: { mode: "comfort-depth", comfortRange: { min: 2, max: 6 }, limits: { min: 1.5, max: 8 } },
    });
    engine.setAnchorPosition("far", { x: 0, y: 0, z: -30 });
    engine.addLabel(makeLabel("l", "far", { dimensions: { width: 3, height: 1 } }));
    const r = engine.solve({ views: [left, right], referenceView: center, deltaTime: 0.1 });
    const p = r.placements[0]!.position;
    const eye = { x: 0, y: 6, z: 14 };
    const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
    expect(d).toBeLessThanOrEqual(8 + 1e-6);
    expect(engine.getLeader("l")?.anchorId).toBe("far");
  });
});
