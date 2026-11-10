import { describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Scene } from "@babylonjs/core/scene.js";
import {
  EveryFrameScheduler,
  RadialCandidateGenerator,
  projectPoint,
  resolveView,
  worldUnitsPerPixel,
  type LeaderRouting,
  type ResolvedView,
} from "@spacexr/spatial-label-layout-core";
import { BabylonCameraProvider, BabylonLabelLayout, type BabylonLabelNode } from "@spacexr/spatial-label-layout-babylon";

const WIDTH = 1280;
const HEIGHT = 720;
/** Local size of the label objects of these tests, and their size on screen. */
const LOCAL = { width: 2, height: 0.4 };
const PIXELS = { width: 120, height: 24 };

const makeScene = (rightHanded: boolean): { scene: Scene; camera: FreeCamera } => {
  const engine = new NullEngine({ renderWidth: WIDTH, renderHeight: HEIGHT, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = rightHanded;
  const camera = new FreeCamera("camera", new Vector3(3, 6, rightHanded ? 14 : -14), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  return { scene, camera };
};

/** A 3D object standing for a label of the application: a slab, with a part that sticks out of its face. */
const makeNode = (scene: Scene, front: "+z" | "-z"): BabylonLabelNode => {
  const node = new TransformNode("label", scene);
  const slab = CreateBox("slab", { width: LOCAL.width, height: LOCAL.height, depth: 0.1 }, scene);
  slab.parent = node;
  const face = CreateBox("face", { size: 0.05 }, scene);
  face.parent = node;
  face.position.z = front === "+z" ? 0.2 : -0.2;
  return { node, ...LOCAL, front };
};

const makeLayout = (rightHanded: boolean, front: "+z" | "-z" = "+z", routing: LeaderRouting = "straight"): { scene: Scene; layout: BabylonLabelLayout; view: () => ResolvedView } => {
  const { scene } = makeScene(rightHanded);
  const layout = new BabylonLabelLayout({
    scene,
    labels: { create: () => makeNode(scene, front) },
    autoTick: false,
    scheduler: new EveryFrameScheduler(),
    // The first place tried stands to the upper right of the pin, clear of it on both axes.
    engine: { temporal: { enabled: false }, candidates: new RadialCandidateGenerator({ startAngle: Math.PI / 6 }) },
  });
  layout.engine.setAnchorPosition("pin", { x: 0, y: 0, z: 0 });
  layout.controller.addLabel({
    id: "label",
    anchorId: "pin",
    position: { x: 0, y: 0, z: 0 },
    dimensions: PIXELS,
    sizing: "screen",
    priority: 1,
    visible: true,
    enabled: true,
    routing,
  });
  layout.tick(1 / 60);
  return { scene, layout, view: () => layout.view as ResolvedView };
};

const worldOf = (node: TransformNode, x: number, y: number, z: number): Vector3 => Vector3.TransformCoordinates(new Vector3(x, y, z), node.computeWorldMatrix(true));

describe.each([
  ["left-handed", false],
  ["right-handed", true],
])("Babylon.js adapter in a %s scene", (_name, rightHanded) => {
  it("gives the solver the view the engine draws with", () => {
    const { scene, camera } = makeScene(rightHanded);
    const provider = new BabylonCameraProvider(scene);
    const views = provider.getViews();
    expect(views).toHaveLength(1);
    expect(views[0]!.viewport).toEqual({ width: WIDTH, height: HEIGHT });
    expect(provider.getReferenceView()).toBeUndefined();
    const view = resolveView(views[0]!, 0);
    const transform = camera.getViewMatrix().multiply(camera.getProjectionMatrix());
    for (const point of [new Vector3(0, 0, 0), new Vector3(2, 1, -3), new Vector3(-4, 0.5, 2)]) {
      const expected = Vector3.Project(point, Matrix.Identity(), transform, camera.viewport.toGlobal(WIDTH, HEIGHT));
      const actual = projectPoint(view, point);
      expect(actual.inFront).toBe(true);
      expect(actual.x).toBeCloseTo(expected.x, 3);
      expect(actual.y).toBeCloseTo(expected.y, 3);
    }
    // The matrices are copies: the camera may move without changing a view already given.
    const before = [...Array.from(views[0]!.viewMatrix)];
    camera.position.x += 5;
    camera.getViewMatrix(true);
    expect(Array.from(views[0]!.viewMatrix)).toEqual(before);
  });

  it.each(["+z", "-z"] as const)("draws the label object where the layout solved it (face toward %s)", (front) => {
    const { layout, view } = makeLayout(rightHanded, front);
    const entry = layout.labels.get("label")!;
    const node = entry.node;
    expect(node.isEnabled()).toBe(true);
    // The corners of the object, drawn by Babylon.js, cover the pixels the label asked for.
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([sx, sy]) => projectPoint(view(), worldOf(node, (sx! * LOCAL.width) / 2, (sy! * LOCAL.height) / 2, 0)));
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(PIXELS.width, 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(PIXELS.height, 1);
    // It reads left to right and bottom to top on screen.
    const centre = projectPoint(view(), worldOf(node, 0, 0, 0));
    expect(projectPoint(view(), worldOf(node, 1, 0, 0)).x).toBeGreaterThan(centre.x);
    expect(projectPoint(view(), worldOf(node, 0, 0.2, 0)).y).toBeLessThan(centre.y);
    // Its face looks at the viewer: the part that sticks out is nearer than the slab.
    const eye = view().position;
    const sticking = worldOf(node, 0, 0, front === "+z" ? 0.2 : -0.2);
    const slab = worldOf(node, 0, 0, 0);
    expect(Vector3.Distance(sticking, new Vector3(eye.x, eye.y, eye.z))).toBeLessThan(Vector3.Distance(slab, new Vector3(eye.x, eye.y, eye.z)));
    // It stands where the placement of the layout is on screen, away from its pin.
    const placed = projectPoint(view(), layout.controller.result!.placements[0]!.position);
    expect(centre.x).toBeCloseTo(placed.x, 2);
    expect(centre.y).toBeCloseTo(placed.y, 2);
    expect(Math.hypot(centre.x - WIDTH / 2, centre.y - HEIGHT / 2)).toBeGreaterThan(20);
  });

  it("draws a straight leader from the pin to the border of the label, with a width in pixels", () => {
    const { layout, view } = makeLayout(rightHanded);
    const segments = layout.leaders!.get(layout.engine.getLeader("label")!.id)!;
    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    expect(segment.isEnabled()).toBe(true);
    const from = worldOf(segment, 0, -0.5, 0);
    const to = worldOf(segment, 0, 0.5, 0);
    expect(from.length()).toBeLessThan(1e-6);
    // The far end touches the rectangle of the label on screen.
    const end = projectPoint(view(), to);
    const centre = projectPoint(view(), layout.labels.get("label")!.node.position);
    expect(Math.abs(end.x - centre.x)).toBeLessThanOrEqual(PIXELS.width / 2 + 0.5);
    expect(Math.abs(end.y - centre.y)).toBeLessThanOrEqual(PIXELS.height / 2 + 0.5);
    expect(segment.scaling.x / worldUnitsPerPixel(view(), segment.position)).toBeCloseTo(1.5, 3);
  });

  it("draws every segment of an elbow leader, end to end", () => {
    const { layout } = makeLayout(rightHanded, "+z", "elbow");
    const leader = layout.engine.getLeader("label")!;
    const label = layout.engine.getLabel("label")!;
    const node = layout.labels.get("label")!.node;
    const frame = layout.engine.settings.orienter.frame(node.position, layout.view!);
    const size = { width: node.scaling.x * LOCAL.width, height: node.scaling.y * LOCAL.height };
    const route = layout.engine.leaderRouters.route({ leader, anchor: { x: 0, y: 0, z: 0 }, labelCenter: node.position, frame, size });
    expect(label.routing).toBe("elbow");
    // Pin, corner, turn, edge of the label.
    expect(route).toHaveLength(4);
    const segments = layout.leaders!.get(leader.id)!.filter((mesh) => mesh.isEnabled());
    expect(segments).toHaveLength(route.length - 1);
    segments.forEach((segment, i) => {
      const from = worldOf(segment, 0, -0.5, 0);
      const to = worldOf(segment, 0, 0.5, 0);
      expect(Vector3.Distance(from, new Vector3(route[i]!.x, route[i]!.y, route[i]!.z))).toBeLessThan(1e-6);
      expect(Vector3.Distance(to, new Vector3(route[i + 1]!.x, route[i + 1]!.y, route[i + 1]!.z))).toBeLessThan(1e-6);
    });
  });

  it("follows the render loop of the scene and releases its objects", () => {
    const { scene } = makeScene(rightHanded);
    const layout = new BabylonLabelLayout({ scene, labels: { create: () => makeNode(scene, "+z") } });
    layout.engine.setAnchorPosition("pin", { x: 0, y: 0, z: 0 });
    layout.controller.addLabel({ id: "label", anchorId: "pin", position: { x: 0, y: 0, z: 0 }, dimensions: PIXELS, sizing: "screen", priority: 1, visible: true, enabled: true });
    const node = layout.labels.get("label")!.node;
    expect(node.isEnabled()).toBe(false);
    scene.render();
    expect(node.isEnabled()).toBe(true);
    const leader = layout.leaders!.get(layout.engine.getLeader("label")!.id)![0]!;
    layout.dispose();
    expect(node.isDisposed()).toBe(true);
    expect(leader.isDisposed()).toBe(true);
    expect(scene.onBeforeRenderObservable.hasObservers()).toBe(false);
  });
});
