import { describe, expect, it } from "vitest";
import {
  FunctionOcclusionProvider,
  SpatialLabelLayoutEngine,
  TopologyError,
  TransformAnchorProvider,
  Mat4Math,
  type LayoutContext,
  type LayoutObserver,
} from "@spacexr/spatial-label-layout-core";
import { makeLabel, monoView, orbit, randomScene } from "../helpers/scene.js";

const ctx = (view = monoView()): LayoutContext => ({ views: [view], deltaTime: 0.1 });

describe("SpatialLabelLayoutEngine: basics", () => {
  it("separates labels sharing the same pin", () => {
    const engine = new SpatialLabelLayoutEngine({ temporal: { enabled: false } });
    engine.setAnchorPosition("pin", { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 4; i++) engine.addLabel(makeLabel(`l${i}`, "pin"));
    const r = engine.solve(ctx());
    expect(r.unresolvedCollisions).toBe(0);
    expect(r.converged).toBe(true);
    expect(r.placements.every((p) => p.visible)).toBe(true);
    const snap = engine.inspect(ctx());
    expect(snap.views[0]?.collidingPairs).toEqual([]);
  });

  it("returns explicit diagnostics instead of throwing for bad input", () => {
    const engine = new SpatialLabelLayoutEngine();
    engine.addLabel(makeLabel("orphan", "missing"));
    const noViews = engine.solve({ views: [], deltaTime: 0 });
    expect(noViews.converged).toBe(false);
    expect(noViews.diagnostics?.messages[0]?.code).toBe("no-views");

    const r = engine.solve(ctx());
    expect(r.placements[0]).toMatchObject({ id: "orphan", visible: false, hiddenReason: "missing-anchor" });
    expect(r.diagnostics?.messages.some((m) => m.code === "missing-anchor")).toBe(true);
  });

  it("rejects topology changes and invalid labels", () => {
    const engine = new SpatialLabelLayoutEngine();
    engine.addLabel(makeLabel("a", "pin"));
    expect(() => engine.updateLabel("a", { anchorId: "other" })).toThrow(TopologyError);
    expect(() => engine.addLabel(makeLabel("a", "pin"))).toThrow();
    expect(() => engine.addLabel(makeLabel("b", "pin", { dimensions: { width: 0, height: 1 } }))).toThrow(RangeError);
    // Routing is geometry, not topology.
    engine.updateLabel("a", { routing: "elbow" });
    expect(engine.getLeader("a")).toMatchObject({ anchorId: "pin", labelId: "a", routing: "elbow" });
  });

  it("never reassigns (anchorId, labelId) during iterations", () => {
    const { engine } = randomScene({ count: 120, seed: 7 });
    const before = engine.getLeaders().map((l) => `${l.labelId}->${l.anchorId}`).sort();
    const seen: string[][] = [];
    const spy: LayoutObserver = { onIteration: () => seen.push(engine.getLeaders().map((l) => `${l.labelId}->${l.anchorId}`).sort()) };
    engine.addObserver(spy);
    engine.solve(ctx());
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s).toEqual(before);
    expect(engine.lastLayout?.placements.every((p) => p.anchorId === `a${p.id.slice(1)}`)).toBe(true);
  });

  it("places a label around its home, its leader still ending at its anchor", () => {
    const engine = new SpatialLabelLayoutEngine({ temporal: { enabled: false } });
    const anchor = { x: -4, y: 0, z: 0 };
    const home = { x: 4, y: 2, z: 0 };
    engine.setAnchorPosition("pin", anchor);
    engine.addLabel(makeLabel("tag", "pin", { home }));
    const r = engine.solve(ctx());
    const placement = r.placements.find((p) => p.id === "tag")!;
    expect(placement.visible).toBe(true);
    const near = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    // The label stands on its home, which nothing covers, far from its anchor; its leader is the anchor's.
    expect(near(placement.position, home)).toBeLessThan(0.05);
    expect(near(placement.position, home)).toBeLessThan(near(placement.position, anchor) / 2);
    expect(engine.getLeader("tag")).toMatchObject({ anchorId: "pin", labelId: "tag" });
    // A home moved later draws the label after it, a step per solve as the runtime solves each frame; removed, the
    // label goes back to its anchor.
    engine.updateLabel("tag", { home: { x: 4, y: 2, z: -6 } });
    let moved = placement;
    for (let frame = 0; frame < 30; frame++) moved = engine.solve(ctx()).placements.find((p) => p.id === "tag")!;
    expect(moved.position.z).toBeLessThan(-3);
    engine.updateLabel("tag", { home: undefined });
    expect(engine.getLabel("tag")?.home).toBeUndefined();
    expect(() => engine.updateLabel("tag", { home: { x: Number.NaN, y: 0, z: 0 } })).toThrow(RangeError);
  });

  it("is deterministic", () => {
    const a = randomScene({ count: 60, seed: 3 }).engine.solve(ctx());
    const b = randomScene({ count: 60, seed: 3 }).engine.solve(ctx());
    expect(a.placements.map((p) => p.position)).toEqual(b.placements.map((p) => p.position));
  });

  it("throws after dispose", () => {
    const engine = new SpatialLabelLayoutEngine();
    engine.dispose();
    expect(() => engine.addLabel(makeLabel("a", "pin"))).toThrow();
  });
});

describe("SpatialLabelLayoutEngine: scenes", () => {
  it.each([10, 100])("resolves a %i-label scene without collisions", (count) => {
    const { engine } = randomScene({ count, seed: count });
    const r = engine.solve(ctx());
    expect(r.unresolvedCollisions).toBe(0);
    expect(r.diagnostics?.perView[0]?.collisions).toBe(0);
    const visible = r.placements.filter((p) => p.visible);
    expect(visible.length).toBe(count);
  });

  it("reports impossible density and can declutter by priority", () => {
    const view = monoView({ x: 0, y: 6, z: 14 });
    const build = (declutter: boolean) => {
      const engine = new SpatialLabelLayoutEngine({ temporal: { enabled: false }, declutter: { enabled: declutter }, maxIterations: 30 });
      engine.setAnchorPosition("pin", { x: 0, y: 0, z: 0 });
      // 400 large labels cannot fit in a 1280x720 viewport.
      for (let i = 0; i < 400; i++) engine.addLabel(makeLabel(`l${i}`, "pin", { priority: i % 5, dimensions: { width: 3, height: 1 } }));
      return engine.solve({ views: [view], deltaTime: 0.1 });
    };
    const raw = build(false);
    expect(raw.converged).toBe(false);
    expect(raw.unresolvedCollisions).toBeGreaterThan(0);
    const codes = raw.diagnostics?.messages.map((m) => m.code);
    expect(codes).toContain("unresolved-collision");
    expect(codes).toContain("impossible-density");

    const decluttered = build(true);
    expect(decluttered.unresolvedCollisions).toBe(0);
    const hidden = decluttered.placements.filter((p) => p.hiddenReason === "decluttered");
    const shown = decluttered.placements.filter((p) => p.visible);
    expect(hidden.length).toBeGreaterThan(0);
    expect(shown.length).toBeGreaterThan(0);
    // Higher priorities survive first.
    const meanPriority = (ids: string[]) => ids.reduce((s, id) => s + (Number(id.slice(1)) % 5), 0) / ids.length;
    expect(meanPriority(shown.map((p) => p.id))).toBeGreaterThan(meanPriority(hidden.map((p) => p.id)));
  });

  it("keeps labels inside the viewport", () => {
    const engine = new SpatialLabelLayoutEngine({ temporal: { enabled: false } });
    // Pin near the right edge of the view.
    engine.setAnchorPosition("edge", { x: 10.5, y: 0, z: 0 });
    engine.addLabel(makeLabel("e", "edge", { dimensions: { width: 3, height: 0.6 } }));
    const r = engine.solve(ctx());
    expect(r.diagnostics?.perView[0]?.outOfView).toBe(0);
    const s = engine.inspect(ctx()).views[0]?.labels[0];
    expect(s?.rect?.maxX).toBeLessThanOrEqual(1280);
  });
});

describe("SpatialLabelLayoutEngine: camera edge cases", () => {
  const behindScene = (policy: "hide" | "reposition") => {
    const engine = new SpatialLabelLayoutEngine({ temporal: { enabled: false }, behindCamera: policy });
    engine.setAnchorPosition("front", { x: 0, y: 0, z: 0 });
    engine.setAnchorPosition("back", { x: 2, y: 6, z: 20 }); // behind a camera at z=14 looking at the origin
    engine.addLabel(makeLabel("f", "front"));
    engine.addLabel(makeLabel("b", "back"));
    return engine;
  };

  it("hides labels whose pin is behind the camera (policy hide)", () => {
    const r = behindScene("hide").solve(ctx());
    expect(r.placements.find((p) => p.id === "b")).toMatchObject({ visible: false, hiddenReason: "anchor-behind-camera" });
    expect(r.placements.find((p) => p.id === "f")?.visible).toBe(true);
  });

  it("brings them back on screen near the matching edge (policy reposition)", () => {
    const engine = behindScene("reposition");
    const r = engine.solve(ctx());
    expect(r.placements.find((p) => p.id === "b")?.visible).toBe(true);
    const s = engine.inspect(ctx()).views[0]?.labels.find((l) => l.id === "b");
    expect(s?.rect).not.toBeNull();
    expect(s?.outOfView).toBe(false);
    // Pin is to the right (+x) of the camera: label goes to the right half.
    expect(s!.center!.x).toBeGreaterThan(640);
    // The leader stays attached to the real pin even though it is behind the camera.
    expect(engine.getLeader("b")?.anchorId).toBe("back");
  });

  it("survives a full 360 degree orbit with every label solved (no hysteresis)", () => {
    const { engine } = randomScene({ count: 40, seed: 11, engine: { temporal: { enabled: false } } });
    let maxCollisions = 0;
    for (let i = 0; i <= 36; i++) {
      const r = engine.solve({ views: [monoView(orbit((i / 36) * Math.PI * 2))], deltaTime: 0.1 });
      maxCollisions = Math.max(maxCollisions, r.unresolvedCollisions);
      expect(r.placements.every((p) => Number.isFinite(p.position.x + p.position.y + p.position.z))).toBe(true);
    }
    expect(maxCollisions).toBe(0);
  });

  it("with hysteresis, residual collisions are transient during a 360 degree orbit", () => {
    const { engine } = randomScene({ count: 40, seed: 11, engine: { temporal: { enabled: true } } });
    const after = engine.settings.temporal.reorganizeAfterSolves;
    const streak = new Map<string, number>();
    let longest = 0;
    for (let i = 0; i <= 72; i++) {
      const r = engine.solve({ views: [monoView(orbit((i / 72) * Math.PI * 2))], deltaTime: 0.1 });
      const now = new Set((r.diagnostics?.collidingPairs ?? []).map(([a, b]) => `${a}|${b}`));
      for (const k of [...streak.keys()]) if (!now.has(k)) streak.delete(k);
      for (const k of now) streak.set(k, (streak.get(k) ?? 0) + 1);
      longest = Math.max(longest, ...streak.values(), 0);
    }
    // A pair may wait for the hysteresis, plus one solve for the cooldown of a recently moved label.
    expect(longest).toBeLessThanOrEqual(after + 2);
  });

  it("works identically with left-handed (Babylon-style) cameras", () => {
    const rh = randomScene({ count: 50, seed: 5 }).engine.solve(ctx(monoView({ x: 0, y: 6, z: 14 }, { x: 0, y: 0, z: 0 }, "right")));
    const lh = randomScene({ count: 50, seed: 5 }).engine.solve(ctx(monoView({ x: 0, y: 6, z: 14 }, { x: 0, y: 0, z: 0 }, "left")));
    expect(rh.unresolvedCollisions).toBe(0);
    expect(lh.unresolvedCollisions).toBe(0);
  });
});

describe("SpatialLabelLayoutEngine: temporal behaviour", () => {
  it("keeps the layout under small head motion and warm-starts after larger motion", () => {
    const { engine } = randomScene({ count: 60, seed: 21, engine: { temporal: { enabled: true } } });
    let first = engine.solve({ views: [monoView(orbit(0))], deltaTime: 0.1 });
    // Defects still building their hysteresis streak trigger a few settling solves.
    for (let i = 0; i < 5 && !first.diagnostics?.skipped; i++) first = engine.solve({ views: [monoView(orbit(0))], deltaTime: 0.1 });
    expect(first.diagnostics?.skipped).toBe(true);
    const still = engine.solve({ views: [monoView(orbit(0.001))], deltaTime: 0.1 });
    expect(still.diagnostics?.skipped).toBe(true);
    expect(still.placements.map((p) => p.position)).toEqual(first.placements.map((p) => p.position));

    let moved = engine.solve({ views: [monoView(orbit(0.08))], deltaTime: 0.1 });
    expect(moved.diagnostics?.skipped).toBe(false);
    // A collision on an established layout may wait for the reorganization hysteresis.
    let travelled = moved.diagnostics?.distanceTravelled ?? 0;
    for (let i = 0; i < engine.settings.temporal.reorganizeAfterSolves && moved.unresolvedCollisions > 0; i++) {
      moved = engine.solve({ views: [monoView(orbit(0.08))], deltaTime: 0.1 });
      travelled += moved.diagnostics?.distanceTravelled ?? 0;
    }
    expect(moved.unresolvedCollisions).toBe(0);
    // Warm start: labels move little compared with the scene size.
    const meanMove = travelled / moved.placements.length;
    expect(meanMove).toBeLessThan(0.5);
  });

  it("does not reorganize under small head motion (no discrete jumps)", () => {
    const { engine } = randomScene({ count: 100, seed: 8, engine: { temporal: { enabled: true, angularThreshold: 0 } } });
    engine.solve({ views: [monoView(orbit(0))], deltaTime: 0.1 });
    // Let pending hysteresis settle on the initial layout.
    for (let i = 0; i < 6; i++) engine.solve({ views: [monoView(orbit(0))], deltaTime: 0.1 });
    let jumps = 0;
    engine.addObserver({
      onPhase: (phase, d) => {
        if (phase === "crossings") jumps += d.swaps ?? 0;
        if (phase === "occlusion") jumps += d.relocations ?? 0;
        if (phase === "repair") jumps += d.moved ?? 0;
      },
    });
    let maxMove = 0;
    let prev = engine.lastLayout!.placements.map((p) => p.position);
    for (let i = 0; i < 60; i++) {
      // Head jitter of +-0.3 degrees around the initial pose, solved every time (angularThreshold 0).
      const r = engine.solve({ views: [monoView(orbit(Math.sin(i * 1.7) * 0.005))], deltaTime: 1 / 10 });
      r.placements.forEach((p, k) => {
        const q = prev[k]!;
        maxMove = Math.max(maxMove, Math.hypot(p.position.x - q.x, p.position.y - q.y, p.position.z - q.z));
      });
      prev = r.placements.map((p) => p.position);
    }
    expect(jumps).toBe(0);
    // Continuous corrections only: far below a label width (~1 m).
    expect(maxMove).toBeLessThan(0.15);
  });

  it("re-solves when a label is resized or a pin moves", () => {
    const { engine } = randomScene({ count: 10, seed: 2, engine: { temporal: { enabled: true } } });
    engine.solve(ctx());
    expect(engine.solve(ctx()).diagnostics?.skipped).toBe(true);
    engine.updateLabel("l0", { dimensions: { width: 3, height: 1 } });
    const r = engine.solve(ctx());
    expect(r.diagnostics?.skipped).toBe(false);
    expect(r.unresolvedCollisions).toBe(0);
    engine.setAnchorPosition("a1", { x: 0, y: 0, z: 0 });
    expect(engine.solve(ctx()).diagnostics?.skipped).toBe(false);
  });

  it("follows meshes through the anchor provider", () => {
    let world = Mat4Math.translation(0, 0, 0);
    const provider = new TransformAnchorProvider({ getWorldMatrix: () => world });
    const engine = new SpatialLabelLayoutEngine({ temporal: { enabled: false } });
    engine.addAnchor({ id: "pin", meshId: "m", localPosition: { x: 1, y: 0, z: 0 } });
    engine.addLabel(makeLabel("l", "pin"));
    engine.updateAnchors(provider);
    expect(engine.getAnchorPosition("pin")).toEqual({ x: 1, y: 0, z: 0 });
    world = Mat4Math.translation(0, 2, 0);
    expect(engine.updateAnchors(provider)).toBe(1);
    expect(engine.getAnchorPosition("pin")).toEqual({ x: 1, y: 2, z: 0 });
  });
});

describe("SpatialLabelLayoutEngine: occlusion", () => {
  it("moves labels out of occluded regions and keeps the leader on the pin", () => {
    // Everything below y = 0.5 is "terrain".
    const occlusion = new FunctionOcclusionProvider((p) => p.y < 0.5);
    const engine = new SpatialLabelLayoutEngine({ temporal: { enabled: false }, occlusion, depth: { mode: "free" } });
    engine.setAnchorPosition("pin", { x: 0, y: 0, z: 0 }); // the pin itself is occluded
    engine.addLabel(makeLabel("l", "pin", { position: { x: 0, y: -1, z: 0 } }));
    const r = engine.solve(ctx());
    const p = r.placements[0]!;
    expect(p.visible).toBe(true);
    expect(p.occluded).toBe(false);
    expect(p.position.y).toBeGreaterThanOrEqual(0.5);
    expect(r.unresolvedOcclusions).toBe(0);
    expect(engine.getLeader("l")?.anchorId).toBe("pin");
  });

  it("reports occlusions it cannot avoid", () => {
    const engine = new SpatialLabelLayoutEngine({ temporal: { enabled: false }, occlusion: new FunctionOcclusionProvider(() => true) });
    engine.setAnchorPosition("pin", { x: 0, y: 0, z: 0 });
    engine.addLabel(makeLabel("l", "pin"));
    const r = engine.solve(ctx());
    expect(r.unresolvedOcclusions).toBe(1);
    expect(r.placements[0]?.visible).toBe(true); // visibility is a separate decision from occlusion
  });
});
