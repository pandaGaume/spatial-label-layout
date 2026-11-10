import { describe, expect, it } from "vitest";
import {
  EveryFrameScheduler,
  LabelLayoutController,
  Mat4Math,
  StaticCameraProvider,
  TransformAnchorProvider,
} from "@spatial-label-layout/core";
import { RecordingLabelRenderer, RecordingLeaderRenderer, renderViewSvg } from "@spatial-label-layout/debug";
import { makeLabel, monoView } from "../helpers/scene.js";

const setup = () => {
  let world = Mat4Math.translation(0, 0, 0);
  const camera = new StaticCameraProvider([monoView()]);
  const labels = new RecordingLabelRenderer();
  const leaders = new RecordingLeaderRenderer();
  const controller = new LabelLayoutController({
    camera,
    anchors: new TransformAnchorProvider({ getWorldMatrix: () => world }),
    labelRenderer: labels,
    leaderRenderer: leaders,
    scheduler: new EveryFrameScheduler(),
    engine: { temporal: { enabled: false } },
  });
  for (let i = 0; i < 5; i++) {
    controller.addAnchor({ id: `a${i}`, meshId: "terrain", localPosition: { x: i - 2, y: 0, z: 0 } });
    controller.addLabel(makeLabel(`l${i}`, `a${i}`));
  }
  return { controller, labels, leaders, camera, moveMesh: (m: Float64Array) => (world = m) };
};

describe("LabelLayoutController", () => {
  it("drives billboard and leader ports every frame", () => {
    const { controller, labels, leaders } = setup();
    for (let f = 0; f < 3; f++) controller.tick(1 / 60);
    expect(labels.frames).toBe(3);
    for (const [, e] of labels.labels) {
      expect(e.visible).toBe(true);
      expect(e.updates).toBe(3);
      expect(e.transform?.width).toBeCloseTo(1.2);
    }
    expect(leaders.leaders.size).toBe(5);
  });

  it("keeps leaders attached to the live anchor (mesh moved between solves)", () => {
    const { controller, leaders, moveMesh } = setup();
    controller.tick(1 / 60);
    moveMesh(Mat4Math.translation(0, 1, 0));
    controller.tick(1 / 60);
    for (const [id, e] of leaders.leaders) {
      const i = Number(id.split("::")[0]!.slice(1));
      expect(e.points[0]).toEqual({ x: i - 2, y: 1, z: 0 });
      expect(e.leader.anchorId).toBe(`a${i}`);
    }
  });

  it("resets on reference frame changes and cleans up on dispose", () => {
    const { controller, labels, leaders, camera } = setup();
    controller.tick(1 / 60);
    camera.bumpReferenceFrame();
    controller.tick(1 / 60);
    expect(controller.result?.unresolvedCollisions).toBe(0);
    controller.removeLabel("l0");
    expect(labels.labels.has("l0")).toBe(false);
    expect(leaders.leaders.has("l0::leader")).toBe(false);
    controller.dispose();
    expect(labels.labels.size).toBe(0);
    expect(leaders.leaders.size).toBe(0);
  });

  it("produces a debug SVG snapshot", () => {
    const { controller } = setup();
    controller.tick(1 / 60);
    const snap = controller.engine.inspect({ views: [monoView()], deltaTime: 0 });
    const svg = renderViewSvg(snap.views[0]!, { title: "controller" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.match(/<polygon/g)?.length).toBe(5);
    expect(svg.match(/<polyline/g)?.length).toBe(5);
  });
});
