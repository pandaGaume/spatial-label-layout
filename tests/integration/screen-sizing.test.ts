import { describe, expect, it } from "vitest";
import {
  DampedInterpolator,
  EveryFrameScheduler,
  LabelLayoutController,
  ScreenLockedInterpolator,
  SpatialLabelLayoutEngine,
  StaticAnchorProvider,
  StaticCameraProvider,
  StraightRouter,
  projectPoint,
  resolveView,
  worldUnitsPerPixel,
  type CameraView,
  type PlacementInterpolator,
  type SolveScheduler,
  type Vec3,
} from "@spacexr/spatial-label-layout-core";
import { RecordingLabelRenderer, RecordingLeaderRenderer } from "@spacexr/spatial-label-layout-debug";
import { makeLabel, monoView } from "../helpers/scene.js";

const ORIGIN = { x: 0, y: 0, z: 0 };
const PIXELS = { width: 120, height: 24 };

/** A view looking at the origin from `distance` along +z. */
const from = (distance: number, shift = 0): CameraView => monoView({ x: shift, y: 0, z: distance }, { x: shift, y: 0, z: 0 });

const offsetPx = (view: CameraView, anchor: Vec3, position: Vec3): { x: number; y: number } => {
  const v = resolveView(view, 0);
  const a = projectPoint(v, anchor);
  const p = projectPoint(v, position);
  return { x: p.x - a.x, y: p.y - a.y };
};

const screenEngine = (options: ConstructorParameters<typeof SpatialLabelLayoutEngine>[0] = {}): SpatialLabelLayoutEngine => {
  const engine = new SpatialLabelLayoutEngine({ temporal: { enabled: false }, ...options });
  engine.setAnchorPosition("pin", ORIGIN);
  engine.addLabel(makeLabel("label", "pin", { dimensions: PIXELS, sizing: "screen" }));
  return engine;
};

describe("labels sized in pixels", () => {
  it("keep their size on screen whatever the distance", () => {
    const engine = screenEngine();
    for (const distance of [10, 1000, 100000]) {
      const view = from(distance);
      const result = engine.solve({ views: [view], deltaTime: 0.1 });
      const rect = engine.inspect({ views: [view], deltaTime: 0 }).views[0]!.labels[0]!.rect!;
      expect(rect.maxX - rect.minX).toBeCloseTo(PIXELS.width, 1);
      expect(rect.maxY - rect.minY).toBeCloseTo(PIXELS.height, 1);
      // The placement tells the world size the solve used.
      const scale = worldUnitsPerPixel(resolveView(view, 0), ORIGIN);
      expect(result.placements[0]!.dimensions!.width).toBeCloseTo(PIXELS.width * scale, 6);
      expect(result.placements[0]!.visible).toBe(true);
    }
  });

  it("keep their place on screen, from their pin, when the camera moves away", () => {
    const engine = screenEngine();
    const near = from(10);
    const far = from(1000);
    const before = offsetPx(near, ORIGIN, engine.solve({ views: [near], deltaTime: 0.1 }).placements[0]!.position);
    expect(Math.hypot(before.x, before.y)).toBeGreaterThan(20);
    const after = offsetPx(far, ORIGIN, engine.solve({ views: [far], deltaTime: 0.1 }).placements[0]!.position);
    // The solver still shortens the leader a little at each solve: the place is kept within a couple of pixels.
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    expect(Math.abs(after.y - before.y)).toBeLessThan(2);

    // A label sized in the world keeps its world offset instead: a hundred times farther, it falls on its pin.
    const world = new SpatialLabelLayoutEngine({ temporal: { enabled: false }, avoidAnchors: false });
    world.setAnchorPosition("pin", ORIGIN);
    world.addLabel(makeLabel("label", "pin"));
    const worldBefore = offsetPx(near, ORIGIN, world.solve({ views: [near], deltaTime: 0.1 }).placements[0]!.position);
    const worldAfter = offsetPx(far, ORIGIN, world.solve({ views: [far], deltaTime: 0.1 }).placements[0]!.position);
    expect(Math.hypot(worldAfter.x, worldAfter.y)).toBeLessThan(Math.hypot(worldBefore.x, worldBefore.y) / 50);
  });

  it("are hidden while their pin cannot be seen by the reference view", () => {
    const engine = screenEngine({ behindCamera: "keep" });
    engine.setAnchorPosition("pin", { x: 0, y: 0, z: 50 });
    const result = engine.solve({ views: [from(10)], deltaTime: 0.1 });
    expect(result.placements[0]!.visible).toBe(false);
    expect(result.placements[0]!.hiddenReason).toBe("anchor-behind-camera");
  });

  it("follow the camera between two solves, through the controller", () => {
    // Solves once, then never again: what moves afterwards is the interpolation alone.
    const once: SolveScheduler = {
      elapsedSinceSolve: 0,
      solved: false,
      shouldSolve() {
        const first = !this.solved;
        this.solved = true;
        return first;
      },
      reset() {
        this.solved = false;
      },
    } as SolveScheduler & { solved: boolean };
    const camera = new StaticCameraProvider([from(10)]);
    const labels = new RecordingLabelRenderer();
    const leaders = new RecordingLeaderRenderer();
    const controller = new LabelLayoutController({ camera, labelRenderer: labels, leaderRenderer: leaders, scheduler: once, engine: { temporal: { enabled: false } } });
    controller.engine.setAnchorPosition("pin", ORIGIN);
    controller.addLabel(makeLabel("label", "pin", { dimensions: PIXELS, sizing: "screen" }));

    controller.tick(1 / 60);
    const first = labels.labels.get("label")!.transform!;
    const before = offsetPx(from(10), ORIGIN, first.position);

    camera.set([from(1000)]);
    controller.tick(1 / 60);
    const second = labels.labels.get("label")!.transform!;
    const after = offsetPx(from(1000), ORIGIN, second.position);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
    // A hundred times farther, the same pixels are a hundred times larger in the world.
    expect(second.width / first.width).toBeCloseTo(100, 1);
    expect(controller.view?.viewport.width).toBe(1280);
    // The leader still runs from the pin to the label.
    const leader = [...leaders.leaders.values()][0]!;
    expect(leader.points[0]).toEqual(ORIGIN);
    expect(leader.visible).toBe(true);
  });

  it("slide in pixels toward a new target, and fall back to world damping for world sized labels", () => {
    const view = resolveView(from(10), 0);
    const interpolator = new ScreenLockedInterpolator({ halfLife: 0.1 });
    interpolator.beginFrame({ view, anchorOf: () => ORIGIN, screenLocked: (id) => id === "screen" });
    interpolator.setTarget("screen", { x: 1, y: 0, z: 0 });
    interpolator.setTarget("world", { x: 1, y: 0, z: 0 });
    interpolator.setTarget("screen", { x: 3, y: 0, z: 0 });
    interpolator.setTarget("world", { x: 3, y: 0, z: 0 });
    interpolator.step(0.1);
    expect(interpolator.get("screen")!.x).toBeCloseTo(2, 3);
    expect(interpolator.get("world")!.x).toBeCloseTo(2, 3);
    interpolator.snap();
    expect(interpolator.get("screen")!.x).toBeCloseTo(3, 3);
    interpolator.remove("screen");
    expect(interpolator.get("screen")).toBeUndefined();
  });
});

describe("pins out of view", () => {
  const sideways = { x: 500, y: 0, z: 0 };

  it("keep their label by default and lose it with the hide policy", () => {
    const keep = new SpatialLabelLayoutEngine({ temporal: { enabled: false } });
    keep.setAnchorPosition("pin", sideways);
    keep.addLabel(makeLabel("label", "pin"));
    expect(keep.solve({ views: [from(10)], deltaTime: 0.1 }).placements[0]!.visible).toBe(true);

    const hide = new SpatialLabelLayoutEngine({ temporal: { enabled: false }, anchorOutOfView: "hide" });
    hide.setAnchorPosition("pin", sideways);
    hide.addLabel(makeLabel("label", "pin"));
    const hidden = hide.solve({ views: [from(10)], deltaTime: 0.1 });
    expect(hidden.placements[0]!.visible).toBe(false);
    expect(hidden.placements[0]!.hiddenReason).toBe("anchor-out-of-view");
    // The label is back as soon as its pin is.
    hide.setAnchorPosition("pin", ORIGIN);
    expect(hide.solve({ views: [from(10)], deltaTime: 0.1 }).placements[0]!.visible).toBe(true);
  });

  it("count as in view within the margin", () => {
    const view = resolveView(from(10), 0);
    // A pin a few pixels beyond the right edge.
    const edge = { x: (view.viewport.width / 2 + 10) * worldUnitsPerPixel(view, ORIGIN), y: 0, z: 0 };
    const solve = (margin: number): boolean => {
      const engine = new SpatialLabelLayoutEngine({ temporal: { enabled: false }, anchorOutOfView: "hide", anchorViewMarginPx: margin });
      engine.setAnchorPosition("pin", edge);
      engine.addLabel(makeLabel("label", "pin"));
      return engine.solve({ views: [from(10)], deltaTime: 0.1 }).placements[0]!.visible;
    };
    expect(solve(0)).toBe(false);
    expect(solve(20)).toBe(true);
  });
});

describe("screen threshold of the temporal stabilizer", () => {
  const setup = (): SpatialLabelLayoutEngine => {
    const engine = new SpatialLabelLayoutEngine({ temporal: { screenThresholdPx: 2 } });
    engine.setAnchorPosition("pin", ORIGIN);
    engine.addLabel(makeLabel("label", "pin", { dimensions: PIXELS, sizing: "screen" }));
    return engine;
  };
  const skipped = (engine: SpatialLabelLayoutEngine, view: CameraView): boolean => engine.solve({ views: [view], deltaTime: 0.1 }).diagnostics!.skipped;
  /** World distance one pixel covers at the origin, seen from a thousand units. */
  const pixel = worldUnitsPerPixel(resolveView(from(1000), 0), ORIGIN);

  it("ignores camera motion that moves no pin by more than the threshold, at any scale", () => {
    const engine = setup();
    expect(skipped(engine, from(1000))).toBe(false);
    // Half a pixel: far above the world thresholds (5 cm), below the screen one.
    expect(pixel * 0.5).toBeGreaterThan(0.05);
    expect(skipped(engine, from(1000, pixel * 0.5))).toBe(true);
    expect(skipped(engine, from(1000, pixel * 5))).toBe(false);
  });

  it("measures pin motion in pixels too", () => {
    const engine = setup();
    expect(skipped(engine, from(1000))).toBe(false);
    engine.setAnchorPosition("pin", { x: pixel * 0.5, y: 0, z: 0 });
    expect(skipped(engine, from(1000))).toBe(true);
    engine.setAnchorPosition("pin", { x: pixel * 5, y: 0, z: 0 });
    expect(skipped(engine, from(1000))).toBe(false);
  });

  it("re-solves when the viewport changes", () => {
    const engine = setup();
    expect(skipped(engine, from(1000))).toBe(false);
    expect(skipped(engine, { ...from(1000), viewport: { width: 800, height: 600 } })).toBe(false);
  });
});

describe("controller and skipped solves", () => {
  it("does not send the targets of a solve the stabilizer skipped", () => {
    let targets = 0;
    const inner = new DampedInterpolator();
    const counting: PlacementInterpolator = {
      setTarget: (id, t) => {
        targets++;
        inner.setTarget(id, t);
      },
      step: (dt) => inner.step(dt),
      get: (id) => inner.get(id),
      snap: (id) => inner.snap(id),
      remove: (id) => inner.remove(id),
      clear: () => inner.clear(),
    };
    const controller = new LabelLayoutController({ camera: new StaticCameraProvider([from(10)]), scheduler: new EveryFrameScheduler(), interpolator: counting });
    controller.engine.setAnchorPosition("pin", ORIGIN);
    controller.addLabel(makeLabel("label", "pin"));
    for (let frame = 0; frame < 5; frame++) controller.tick(1 / 60);
    expect(controller.result!.diagnostics!.skipped).toBe(true);
    expect(targets).toBe(1);
  });
});

describe("vectors with accessor properties", () => {
  /** Shaped as the vectors of Babylon.js: coordinates behind accessors, which an object spread does not copy. */
  class AccessorVector {
    constructor(
      private _x: number,
      private _y: number,
      private _z: number,
    ) {}
    get x(): number {
      return this._x;
    }
    get y(): number {
      return this._y;
    }
    get z(): number {
      return this._z;
    }
  }

  it("go through the providers, the routers and the interpolators", () => {
    const anchor = new AccessorVector(1, 2, 3);
    const provider = new StaticAnchorProvider();
    provider.set("pin", anchor);
    expect(provider.resolve({ id: "pin", localPosition: ORIGIN })).toEqual({ x: 1, y: 2, z: 3 });
    expect(provider.resolve({ id: "other", localPosition: anchor })).toEqual({ x: 1, y: 2, z: 3 });

    const frame = { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } };
    const route = new StraightRouter("center").route({
      leader: { id: "leader", anchorId: "pin", labelId: "label", routing: "straight" },
      anchor,
      labelCenter: new AccessorVector(4, 5, 6),
      frame,
      size: { width: 1, height: 1 },
    });
    expect(route).toEqual([
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 5, z: 6 },
    ]);

    const interpolator = new DampedInterpolator();
    interpolator.setTarget("label", anchor);
    expect(interpolator.get("label")).toEqual({ x: 1, y: 2, z: 3 });
  });
});
