import { describe, expect, it } from "vitest";
import {
  createCameraView,
  Mat4Math,
  pixelDeltaToAxes,
  pixelJacobian,
  projectPoint,
  resolveView,
  type DepthRange,
  type Handedness,
} from "@spatial-label-layout/core";

const VP = { width: 800, height: 600 };

describe("mat4", () => {
  it("inverts an affine matrix", () => {
    const m = Mat4Math.multiply(Mat4Math.translation(1, 2, 3), Mat4Math.rotationY(0.7));
    const inv = Mat4Math.invert(m);
    expect(inv).not.toBeNull();
    const id = Mat4Math.multiply(m, inv as Float64Array);
    for (let i = 0; i < 16; i++) expect(id[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 9);
  });

  it("returns null for singular matrices", () => {
    expect(Mat4Math.invert(new Float64Array(16))).toBeNull();
  });
});

describe.each<[Handedness, DepthRange]>([
  ["right", "negOneToOne"],
  ["right", "zeroToOne"],
  ["left", "negOneToOne"],
  ["left", "zeroToOne"],
])("projection (%s-handed, %s)", (handedness, depthRange) => {
  // Same physical setup in both conventions: camera 10 units from origin, looking at it.
  const eye = handedness === "right" ? { x: 0, y: 0, z: 10 } : { x: 0, y: 0, z: -10 };
  const view = resolveView(createCameraView({ eye, target: { x: 0, y: 0, z: 0 }, viewport: VP, handedness, depthRange }), 0);

  it("recovers camera position and forward axis", () => {
    expect(view.position.x).toBeCloseTo(eye.x, 5);
    expect(view.position.z).toBeCloseTo(eye.z, 5);
    expect(view.forward.z).toBeCloseTo(-Math.sign(eye.z), 5);
    expect(view.perspective).toBe(true);
  });

  it("projects the target to the viewport center with positive depth", () => {
    const p = projectPoint(view, { x: 0, y: 0, z: 0 });
    expect(p.x).toBeCloseTo(400, 3);
    expect(p.y).toBeCloseTo(300, 3);
    expect(p.inFront).toBe(true);
    expect(p.depth).toBeCloseTo(10, 4);
  });

  it("maps camera right/up to screen +x / -y", () => {
    const r = projectPoint(view, view.right);
    const u = projectPoint(view, view.up);
    expect(r.x).toBeGreaterThan(400);
    expect(u.y).toBeLessThan(300);
  });

  it("flags points behind the camera", () => {
    const behind = { x: eye.x * 2, y: 0, z: eye.z * 2 };
    expect(projectPoint(view, behind).inFront).toBe(false);
  });

  it("inverts pixel displacements through the Jacobian", () => {
    const p = { x: 0.3, y: -0.2, z: 0 };
    const j = pixelJacobian(view, p, view.right, view.up);
    expect(j).not.toBeNull();
    const ax = pixelDeltaToAxes(j as NonNullable<typeof j>, { x: 12, y: -7 });
    expect(ax).not.toBeNull();
    const moved = {
      x: p.x + view.right.x * (ax as { x: number }).x + view.up.x * (ax as { y: number }).y,
      y: p.y + view.right.y * (ax as { x: number }).x + view.up.y * (ax as { y: number }).y,
      z: p.z + view.right.z * (ax as { x: number }).x + view.up.z * (ax as { y: number }).y,
    };
    const a = projectPoint(view, p);
    const b = projectPoint(view, moved);
    expect(b.x - a.x).toBeCloseTo(12, 1);
    expect(b.y - a.y).toBeCloseTo(-7, 1);
  });
});

describe("resolveView validation", () => {
  it("rejects non-finite matrices and empty viewports", () => {
    const good = createCameraView({ eye: { x: 0, y: 0, z: 5 }, target: { x: 0, y: 0, z: 0 }, viewport: VP });
    expect(() => resolveView({ ...good, viewport: { width: 0, height: 10 } }, 0)).toThrow();
    const bad = new Float32Array(good.viewMatrix as Float32Array);
    bad[3] = Number.NaN;
    expect(() => resolveView({ ...good, viewMatrix: bad }, 0)).toThrow();
  });
});
