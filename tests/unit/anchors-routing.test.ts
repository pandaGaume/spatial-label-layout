import { describe, expect, it } from "vitest";
import {
  borderAttachPoint,
  ElbowRouter,
  LeaderRouterRegistry,
  Mat4Math,
  ScreenAlignedOrienter,
  StraightRouter,
  TransformAnchorProvider,
  ViewpointOrienter,
  createCameraView,
  resolveView,
  type MeshResolver,
  type Vec3,
} from "@spacexr/spatial-label-layout-core";

describe("TransformAnchorProvider", () => {
  const tri: [Vec3, Vec3, Vec3] = [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 0, y: 2, z: 0 },
  ];
  let world: Mat4Math.Mat4 = Mat4Math.translation(10, 0, 0);
  const meshes: MeshResolver = {
    getWorldMatrix: (id) => (id === "terrain" ? world : null),
    getTriangle: (_id, t) => (t === 0 ? tri : null),
  };
  const provider = new TransformAnchorProvider(meshes);

  it("transforms mesh-local positions", () => {
    expect(provider.resolve({ id: "a", meshId: "terrain", localPosition: { x: 1, y: 2, z: 3 } })).toEqual({ x: 11, y: 2, z: 3 });
  });

  it("follows the mesh transform", () => {
    world = Mat4Math.multiply(Mat4Math.translation(0, 5, 0), Mat4Math.scaling(2, 2, 2));
    expect(provider.resolve({ id: "a", meshId: "terrain", localPosition: { x: 1, y: 1, z: 1 } })).toEqual({ x: 2, y: 7, z: 2 });
    world = Mat4Math.translation(10, 0, 0);
  });

  it("interpolates barycentric anchors on deformed triangles", () => {
    const a = { id: "b", meshId: "terrain", localPosition: { x: 0, y: 0, z: 0 }, triangleId: 0, barycentric: [0.5, 0.25, 0.25] as const };
    expect(provider.resolve(a)).toEqual({ x: 10.5, y: 0.5, z: 0 });
    tri[1] = { x: 4, y: 0, z: 0 }; // deformation
    expect(provider.resolve(a)).toEqual({ x: 11, y: 0.5, z: 0 });
  });

  it("returns null for unknown meshes and treats mesh-less anchors as world positions", () => {
    expect(provider.resolve({ id: "c", meshId: "nope", localPosition: { x: 0, y: 0, z: 0 } })).toBeNull();
    expect(provider.resolve({ id: "d", localPosition: { x: 1, y: 2, z: 3 } })).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe("leader routing", () => {
  const frame = { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } };
  const size = { width: 2, height: 1 };
  const leader = { id: "l::leader", anchorId: "a", labelId: "l", routing: "straight" as const };

  it("attaches straight leaders to the label border", () => {
    const p = borderAttachPoint({ anchor: { x: 0, y: -5, z: 0 }, labelCenter: { x: 0, y: 0, z: 0 }, frame, size });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-0.5);
    const q = borderAttachPoint({ anchor: { x: 10, y: 1, z: 0 }, labelCenter: { x: 0, y: 0, z: 0 }, frame, size });
    expect(q.x).toBeCloseTo(1);
  });

  it("starts every route at the anchor", () => {
    const anchor = { x: 5, y: -3, z: 0 };
    for (const r of [new StraightRouter(), new StraightRouter("center"), new ElbowRouter()]) {
      const pts = r.route({ leader, anchor, labelCenter: { x: 0, y: 0, z: 0 }, frame, size });
      expect(pts[0]).toEqual(anchor);
      expect(pts.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("routes elbows through a horizontal stub to the facing edge", () => {
    const pts = new ElbowRouter({ shape: "diagonal" }).route({ leader, anchor: { x: 5, y: -3, z: 0 }, labelCenter: { x: 0, y: 0, z: 0 }, frame, size });
    expect(pts).toHaveLength(3);
    expect(pts[2]).toEqual({ x: 1, y: 0, z: 0 });
    expect(pts[1]?.y).toBeCloseTo(0);
  });

  it("routes orthogonal elbows by default: horizontal from the pin, vertical, horizontal into the label", () => {
    const anchor = { x: 5, y: -3, z: 0 };
    const pts = new ElbowRouter().route({ leader, anchor, labelCenter: { x: 0, y: 0, z: 0 }, frame, size });
    // Pin, corner level with the pin, turn level with the label, middle of the facing edge.
    expect(pts).toEqual([anchor, { x: 1.5, y: -3, z: 0 }, { x: 1.5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]);
    // Mirrored for a pin on the other side.
    const left = new ElbowRouter().route({ leader, anchor: { x: -5, y: 2, z: 0 }, labelCenter: { x: 0, y: 0, z: 0 }, frame, size });
    expect(left).toEqual([{ x: -5, y: 2, z: 0 }, { x: -1.5, y: 2, z: 0 }, { x: -1.5, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }]);
  });

  it("keeps the turn of an elbow between the pin and the label, and drops it when it is not needed", () => {
    const router = new ElbowRouter();
    // A pin closer to the label than the stub is long: the turn stands halfway.
    const close = router.route({ leader, anchor: { x: 1.2, y: -3, z: 0 }, labelCenter: { x: 0, y: 0, z: 0 }, frame, size });
    expect(close[1]?.x).toBeCloseTo(1.1);
    expect(close[2]?.x).toBeCloseTo(1.1);
    // A pin level with the label: a single horizontal segment.
    expect(router.route({ leader, anchor: { x: 5, y: 0, z: 0 }, labelCenter: { x: 0, y: 0, z: 0 }, frame, size })).toEqual([
      { x: 5, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]);
    // A pin under the label: straight to its border.
    expect(router.route({ leader, anchor: { x: 0.5, y: -4, z: 0 }, labelCenter: { x: 0, y: 0, z: 0 }, frame, size })).toHaveLength(2);
  });

  it("dispatches by routing kind and falls back to straight", () => {
    const reg = new LeaderRouterRegistry();
    expect(reg.get("elbow").kind).toBe("elbow");
    expect(reg.get("unknown-kind").kind).toBe("straight");
  });
});

describe("orienters", () => {
  const view = resolveView(createCameraView({ eye: { x: 3, y: 2, z: 8 }, target: { x: 0, y: 0, z: 0 }, viewport: { width: 640, height: 480 } }), 0);

  it("screen-aligned frames match the camera axes", () => {
    const f = new ScreenAlignedOrienter().frame({ x: 0, y: 0, z: 0 }, view);
    expect(f.right).toEqual(view.right);
    expect(f.up).toEqual(view.up);
  });

  it("viewpoint frames face the camera and keep screen orientation", () => {
    const c = { x: -2, y: 0, z: 1 };
    const f = new ViewpointOrienter().frame(c, view);
    const toCam = { x: view.position.x - c.x, y: view.position.y - c.y, z: view.position.z - c.z };
    const len = Math.hypot(toCam.x, toCam.y, toCam.z);
    expect(f.normal.x * toCam.x / len + f.normal.y * toCam.y / len + f.normal.z * toCam.z / len).toBeCloseTo(1, 5);
    expect(f.right.x * view.right.x + f.right.y * view.right.y + f.right.z * view.right.z).toBeGreaterThan(0);
    expect(f.up.x * view.up.x + f.up.y * view.up.y + f.up.z * view.up.z).toBeGreaterThan(0);
  });
});
