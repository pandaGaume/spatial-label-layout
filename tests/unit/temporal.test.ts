import { describe, expect, it } from "vitest";
import {
  DampedInterpolator,
  defaultTemporalConfig,
  FixedRateScheduler,
  PriorityDeclutter,
  resolveView,
  TemporalStabilizer,
} from "@spacexr/spatial-label-layout-core";
import { monoView, orbit } from "../helpers/scene.js";

describe("FixedRateScheduler", () => {
  it("solves on the first frame then at the configured rate", () => {
    const s = new FixedRateScheduler(10);
    const frames = Array.from({ length: 90 }, () => s.shouldSolve(1 / 90));
    expect(frames[0]).toBe(true);
    const count = frames.filter(Boolean).length;
    expect(count).toBeGreaterThanOrEqual(9);
    expect(count).toBeLessThanOrEqual(11);
  });
});

describe("DampedInterpolator", () => {
  it("snaps on first target then converges exponentially", () => {
    const it = new DampedInterpolator({ halfLife: 0.1 });
    it.setTarget("a", { x: 0, y: 0, z: 0 });
    expect(it.get("a")).toEqual({ x: 0, y: 0, z: 0 });
    it.setTarget("a", { x: 1, y: 0, z: 0 });
    it.step(0.1);
    expect(it.get("a")?.x).toBeCloseTo(0.5, 5);
    it.step(1);
    expect(it.get("a")?.x).toBeCloseTo(1, 2);
  });

  it("snaps large jumps", () => {
    const it = new DampedInterpolator({ snapDistance: 2 });
    it.setTarget("a", { x: 0, y: 0, z: 0 });
    it.setTarget("a", { x: 10, y: 0, z: 0 });
    expect(it.get("a")?.x).toBe(10);
  });
});

describe("TemporalStabilizer", () => {
  const cfg = { ...defaultTemporalConfig(), angularThreshold: (2 * Math.PI) / 180, fastAngularSpeed: Math.PI, maxDeferSeconds: 0.3 };
  const view = (a: number) => resolveView(monoView(orbit(a)), 0);

  it("ignores small head motion but re-solves on larger motion", () => {
    const s = new TemporalStabilizer(cfg);
    expect(s.decide(view(0), 0.016, false, false)).toMatchObject({ solve: true, reason: "first-solve" });
    s.markSolved(view(0));
    // 0.002 rad on a 14 m orbit: ~3 cm translation, well under both thresholds.
    expect(s.decide(view(0.002), 0.016, false, false)).toMatchObject({ solve: false, reason: "below-threshold" });
    expect(s.decide(view(0.1), 0.5, false, false)).toMatchObject({ solve: true, reason: "camera-moved" });
  });

  it("freezes the layout during fast rotations, up to a time limit", () => {
    const s = new TemporalStabilizer(cfg);
    s.decide(view(0), 0.016, false, false);
    s.markSolved(view(0));
    let a = 0;
    const reasons: string[] = [];
    for (let i = 0; i < 30; i++) {
      a += 0.1; // 0.1 rad per 16 ms ~ 6 rad/s
      reasons.push(s.decide(view(a), 0.016, true, false).reason);
    }
    expect(reasons[0]).toBe("fast-camera");
    expect(reasons).toContain("defer-timeout");
  });
});

describe("PriorityDeclutter", () => {
  it("hides the lowest priority labels until no pair remains", () => {
    const labels = new Map([
      ["a", { id: "a", priority: 5, collisions: 2 }],
      ["b", { id: "b", priority: 1, collisions: 1 }],
      ["c", { id: "c", priority: 1, collisions: 1 }],
    ]);
    const hidden = new PriorityDeclutter().select(
      [
        ["a", "b"],
        ["a", "c"],
      ],
      labels,
    );
    expect(hidden.sort()).toEqual(["b", "c"]);
  });
});
