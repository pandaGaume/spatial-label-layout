import { beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Logger } from "@babylonjs/core/Misc/logger.js";
import { Scene } from "@babylonjs/core/scene.js";
import "@babylonjs/loaders/glTF/2.0/index.js";
import { GLTF2Export } from "@babylonjs/serializers/glTF/2.0/glTFSerializer.js";
import { LabelRuntime, getNodeLabel, parseSpaceXrLabel, setNodeLabel, type SpaceXrLabel } from "@spacexr/spatial-label-layout-babylon";
import { registerSpaceXrLabelExporter } from "@spacexr/spatial-label-layout-babylon/gltf-exporter";
import { registerSpaceXrLabelLoader } from "@spacexr/spatial-label-layout-babylon/gltf-loader";

const WIDTH = 800;
const HEIGHT = 600;

const makeScene = (rightHanded: boolean): { scene: Scene; camera: FreeCamera } => {
  const engine = new NullEngine({ renderWidth: WIDTH, renderHeight: HEIGHT, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 });
  // The layout smooths the labels over time: every frame of a test lasts 16 ms.
  engine.getDeltaTime = () => 16;
  const scene = new Scene(engine);
  scene.useRightHandedSystem = rightHanded;
  const camera = new FreeCamera("camera", new Vector3(30, 40, 120), scene);
  camera.setTarget(new Vector3(5, -3, 2));
  camera.fov = 0.8;
  camera.computeWorldMatrix();
  camera.getViewMatrix(true);
  return { scene, camera };
};

/** A label node holding a plate of 4 by 2 units, under a parent that is moved, turned and scaled, as a tile root is. */
const makeLabel = (scene: Scene, name = "node", position = new Vector3(2, 1, -4)): { node: TransformNode; plate: Mesh; parent: TransformNode } => {
  const parent = (scene.getTransformNodeByName("parent") as TransformNode | null) ?? new TransformNode("parent", scene);
  parent.position.set(100, -20, 35);
  parent.rotationQuaternion = Quaternion.FromEulerAngles(0.4, -1.1, 0.7);
  parent.scaling.setAll(3);
  const node = new TransformNode(name, scene);
  node.parent = parent;
  node.position = position;
  node.rotationQuaternion = Quaternion.FromEulerAngles(0.2, 0.3, 0.1);
  node.scaling.set(2, 2, 2);
  const plate = CreateBox(`${name}-plate`, { width: 4, height: 2, depth: 0.1 }, scene);
  plate.parent = node;
  return { node, plate, parent };
};

const worldAxis = (node: TransformNode, axis: Vector3): Vector3 => Vector3.TransformNormal(axis, node.computeWorldMatrix(true));

const expectVector = (actual: Vector3, expected: Vector3, precision = 6): void => {
  expect(actual.x).toBeCloseTo(expected.x, precision);
  expect(actual.y).toBeCloseTo(expected.y, precision);
  expect(actual.z).toBeCloseTo(expected.z, precision);
};

/** The direction of the viewer along the axis of a camera. */
const towardViewer = (camera: FreeCamera, rightHanded: boolean): Vector3 =>
  Vector3.TransformNormal(new Vector3(0, 0, rightHanded ? 1 : -1), camera.getWorldMatrix()).normalize();

/** Height in the scene of `pixels` pixels at the view depth of a point. */
const heightOf = (pixels: number, camera: FreeCamera, point: Vector3): number => {
  const depth = Math.abs(Vector3.TransformCoordinates(point, camera.getViewMatrix(true)).z);
  return (pixels * 2 * depth * Math.tan(camera.fov / 2)) / HEIGHT;
};

describe.each([
  ["right-handed", true],
  ["left-handed", false],
])("a label that faces the screen, in a %s scene", (_name, rightHanded) => {
  it("is parallel to the screen, with the up of the camera, and keeps only the scale of its node", () => {
    const { scene, camera } = makeScene(rightHanded);
    const { node, plate } = makeLabel(scene);
    const authored = { position: node.position.clone(), rotation: node.rotationQuaternion!.clone(), scaling: node.scaling.clone() };
    setNodeLabel(node, { facing: "screen" });
    const runtime = new LabelRuntime(scene);
    runtime.attach(node);
    const body = runtime.bodyOf(node)!;
    const anchor = node.getAbsolutePosition().clone();

    runtime.update(camera);

    // The node is the anchor: nothing of it changes. Its content went under the body.
    expectVector(node.position, authored.position);
    expectVector(node.scaling, authored.scaling);
    expect(Quaternion.Dot(node.rotationQuaternion!, authored.rotation)).toBeCloseTo(1, 9);
    expect(plate.parent).toBe(body);
    expectVector(body.computeWorldMatrix(true).getTranslation(), anchor, 5);
    // The label looks along the axis of the camera, toward the viewer: not at the position of the camera.
    const viewer = towardViewer(camera, rightHanded);
    expect(Vector3.Dot(viewer, camera.globalPosition.subtract(anchor).normalize())).toBeLessThan(0.99);
    // The local axes of the label are those of the glTF content, whatever the handedness of the scene.
    const face = worldAxis(body, new Vector3(0, 0, 1));
    expect(face.length()).toBeCloseTo(2, 6);
    expectVector(face.normalize(), viewer);
    const up = worldAxis(body, Vector3.Up());
    expect(up.length()).toBeCloseTo(2, 6);
    expectVector(up.normalize(), Vector3.TransformNormal(Vector3.Up(), camera.getWorldMatrix()).normalize());
    // The +X of the content reads toward the right of the camera, in both handednesses.
    expectVector(worldAxis(body, Vector3.Right()).normalize(), Vector3.TransformNormal(Vector3.Right(), camera.getWorldMatrix()).normalize());
  });
});

describe("a label", () => {
  it("keeps its orientation without facing, and takes its size on screen, parents included", () => {
    const { scene, camera } = makeScene(true);
    const { node } = makeLabel(scene);
    setNodeLabel(node, { size: { referenceHeight: 0.5, pixels: 24 } });
    const runtime = new LabelRuntime(scene);
    runtime.attach(node);
    const body = runtime.bodyOf(node)!;

    runtime.update(camera);

    expect(Quaternion.Dot(body.rotationQuaternion!, Quaternion.Identity())).toBeCloseTo(1, 9);
    expect(worldAxis(body, new Vector3(0, 0.5, 0)).length()).toBeCloseTo(heightOf(24, camera, node.getAbsolutePosition()), 6);
  });

  it("gives its reference height its height in CSS pixels, whatever the density of the screen", () => {
    const { scene, camera } = makeScene(true);
    const { node } = makeLabel(scene);
    setNodeLabel(node, { facing: "screen", size: { referenceHeight: 0.5, pixels: 24 } });
    const runtime = new LabelRuntime(scene);
    runtime.attach(node);
    const body = runtime.bodyOf(node)!;

    runtime.update(camera);
    const height = worldAxis(body, new Vector3(0, 0.5, 0)).length();
    expect(height).toBeCloseTo(heightOf(24, camera, node.getAbsolutePosition()), 6);

    // Twice the pixel density: the same canvas is rendered on 1200 lines, each half a CSS pixel.
    scene.getEngine().setHardwareScalingLevel(0.5);
    scene.getEngine().setSize(1600, 1200);
    runtime.update(camera);
    expect(worldAxis(body, new Vector3(0, 0.5, 0)).length()).toBeCloseTo(height, 6);
  });

  it("follows its node, which something else may move", () => {
    const { scene, camera } = makeScene(true);
    const { node } = makeLabel(scene);
    setNodeLabel(node, { facing: "screen" });
    const runtime = new LabelRuntime(scene);
    runtime.attach(node);
    runtime.update(camera);

    // What a reference to the ground does: it moves the node, between two frames.
    node.position.y += 25;
    node.computeWorldMatrix(true);
    runtime.update(camera);

    const body = runtime.bodyOf(node)!;
    expectVector(body.computeWorldMatrix(true).getTranslation(), node.getAbsolutePosition(), 5);
    expectVector(worldAxis(body, new Vector3(0, 0, 1)).normalize(), towardViewer(camera, true));
  });

  it("draws overlays back to front, each over those behind it, on a logarithmic depth", () => {
    const { scene, camera } = makeScene(true);
    const engine = scene.getEngine();
    const toTarget = camera.getTarget().subtract(camera.position).normalize();
    /** An overlay label holding two boxes, at a distance along the axis of the camera. */
    const overlay = (name: string, distance: number): { node: TransformNode; boxes: Mesh[] } => {
      const node = new TransformNode(name, scene);
      node.position = camera.position.add(toTarget.scale(distance));
      const boxes = [CreateBox(`${name}-a`, { size: 1 }, scene), CreateBox(`${name}-b`, { size: 1 }, scene)];
      for (const box of boxes) box.parent = node;
      setNodeLabel(node, { facing: "screen", overlay: true });
      return { node, boxes };
    };
    const near = overlay("near", 50);
    const far = overlay("far", 400);
    const plain = CreateBox("plain", { size: 1 }, scene);
    const runtime = new LabelRuntime(scene, { overlayRenderingGroupId: 2 });
    runtime.attach(near.node);
    runtime.attach(far.node);
    runtime.update(camera);
    expect(near.boxes.map((box) => box.renderingGroupId)).toEqual([2, 2]);
    expect(near.boxes.every((box) => (box.material as { useLogarithmicDepth?: boolean } | null)?.useLogarithmicDepth !== false)).toBe(true);

    const sub = (box: Mesh) => box.subMeshes[0]!;
    // The farthest overlay first, the meshes of an overlay together, and what is no overlay before them.
    const sorted = [sub(near.boxes[0]!), sub(far.boxes[1]!), sub(near.boxes[1]!), sub(plain), sub(far.boxes[0]!)].sort((a, b) => runtime.compareOverlay(a, b));
    expect(sorted.map((item) => item.getMesh().name)).toEqual(["plain", "far-a", "far-b", "near-a", "near-b"]);

    // The depth buffer is cleared when the overlay being drawn changes, and only then.
    const cleared: unknown[][] = [];
    const clear = engine.clear.bind(engine);
    engine.clear = (...parameters: Parameters<typeof engine.clear>) => {
      cleared.push(parameters);
      return clear(...parameters);
    };
    for (const item of sorted.slice(1)) {
      const mesh = item.getMesh() as Mesh;
      mesh.onBeforeRenderObservable.notifyObservers(mesh);
    }
    expect(cleared).toEqual([[null, false, true, false]]);

    // The next camera starts again from the group, which is cleared before it is drawn.
    cleared.length = 0;
    runtime.update(camera);
    far.boxes[0]!.onBeforeRenderObservable.notifyObservers(far.boxes[0]!);
    expect(cleared).toEqual([]);
  });

  it("is hidden where the scene hides its anchor, and shown again", () => {
    const { scene, camera } = makeScene(true);
    const { node } = makeLabel(scene);
    setNodeLabel(node, { facing: "screen" });
    let behind = true;
    const runtime = new LabelRuntime(scene, { hides: () => behind });
    runtime.attach(node);
    const body = runtime.bodyOf(node)!;

    runtime.update(camera);
    expect(body.isEnabled()).toBe(false);
    expect(node.isEnabled()).toBe(true);

    behind = false;
    runtime.update(camera);
    expect(body.isEnabled()).toBe(true);
  });

  it("gets its content back under its node once detached", () => {
    const { scene, camera } = makeScene(true);
    const { node, plate } = makeLabel(scene);
    setNodeLabel(node, { facing: "screen", size: { referenceHeight: 1, pixels: 20 } });
    const runtime = new LabelRuntime(scene);
    runtime.attach(node);
    const body = runtime.bodyOf(node)!;
    runtime.update(camera);

    runtime.detach(node);

    expect(plate.parent).toBe(node);
    expect(body.isDisposed()).toBe(true);
    expect(runtime.bodyOf(node)).toBeUndefined();
  });

  it("is left alone while its node is disabled", () => {
    const { scene, camera } = makeScene(true);
    const { node } = makeLabel(scene);
    setNodeLabel(node, { facing: "screen", size: { referenceHeight: 1, pixels: 20 } });
    const runtime = new LabelRuntime(scene);
    runtime.attach(node);
    const body = runtime.bodyOf(node)!;
    node.setEnabled(false);

    runtime.update(camera);

    expectVector(body.scaling, new Vector3(1, 1, 1));
  });
});

describe("labels with a leader", () => {
  const LABEL: SpaceXrLabel = { facing: "screen", size: { referenceHeight: 1, pixels: 10 }, overlay: true, leader: { color: [1, 0.5, 0], width: 2, anchorRadius: 5 } };

  /** Where a point of the scene shows on screen, in pixels. */
  const onScreen = (scene: Scene, point: Vector3): Vector3 =>
    Vector3.Project(point, Matrix.Identity(), scene.getTransformMatrix(), scene.activeCamera!.viewport.toGlobal(WIDTH, HEIGHT));

  const setUp = () => {
    const { scene, camera } = makeScene(true);
    const parent = new TransformNode("tile", scene);
    parent.position.set(4, -2, 1);
    parent.rotationQuaternion = Quaternion.FromEulerAngles(0.3, 0.2, -0.1);
    parent.scaling.setAll(1.5);
    // Two anchors a few pixels apart on screen: their labels cannot both stand on them.
    const nodes = [new Vector3(0, 0, 0), new Vector3(0.6, 0.2, 0)].map((position, index) => {
      const node = new TransformNode(`label${index}`, scene);
      node.parent = parent;
      node.position = position;
      const plate = CreateBox(`label${index}-plate`, { width: 4, height: 2, depth: 0.1 }, scene);
      plate.parent = node;
      setNodeLabel(node, LABEL);
      return node;
    });
    const runtime = new LabelRuntime(scene, { overlayRenderingGroupId: 2 });
    for (const node of nodes) runtime.attach(node);
    const anchors = nodes.map((node) => node.getAbsolutePosition().clone());
    for (let frame = 0; frame < 90; frame++) scene.render();
    return { scene, camera, parent, nodes, runtime, anchors };
  };

  it("are moved apart on screen, parallel to it and at their size in pixels, their node staying on its anchor", () => {
    const { scene, camera, parent, nodes, runtime, anchors } = setUp();

    expect(runtime.labelLayout).not.toBeNull();
    const bodies = nodes.map((node) => runtime.bodyOf(node)!);
    const centres = bodies.map((body) => onScreen(scene, body.computeWorldMatrix(true).getTranslation()));
    bodies.forEach((body, index) => {
      expect(nodes[index]!.parent).toBe(parent);
      expectVector(nodes[index]!.getAbsolutePosition(), anchors[index]!, 6);
      expect(body.isEnabled()).toBe(true);
      // Parallel to the screen, read from left to right.
      expectVector(worldAxis(body, new Vector3(0, 0, 1)).normalize(), towardViewer(camera, true), 4);
      expectVector(worldAxis(body, Vector3.Right()).normalize(), Vector3.TransformNormal(Vector3.Right(), camera.getWorldMatrix()).normalize(), 4);
      // One unit of the label is 10 pixels high.
      const position = body.getAbsolutePosition();
      expect(worldAxis(body, Vector3.Up()).length() / heightOf(10, camera, position)).toBeCloseTo(1, 2);
      // The label left its anchor.
      expect(Vector3.Distance(centres[index]!, onScreen(scene, anchors[index]!))).toBeGreaterThan(10);
    });
    // The two rectangles, 40 by 20 pixels, do not overlap.
    expect(Math.abs(centres[0]!.x - centres[1]!.x) >= 40 || Math.abs(centres[0]!.y - centres[1]!.y) >= 20).toBe(true);
  });

  it("are linked to their anchor by a leader and mark it, in the overlay group", () => {
    const { scene, camera, anchors } = setUp();

    // The segments of the leaders: what the overlay group holds besides the plates and the marks.
    const segments = scene.meshes.filter((mesh) => mesh.renderingGroupId === 2 && mesh.name !== "label-anchor" && !mesh.name.endsWith("-plate"));
    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const segment of segments) expect(segment.isPickable).toBe(false);
    const marks = scene.meshes.filter((mesh) => mesh.name === "label-anchor");
    expect(marks).toHaveLength(2);
    marks.forEach((mark, index) => {
      expect(mark.isEnabled()).toBe(true);
      expect(mark.renderingGroupId).toBe(2);
      expectVector(mark.position, anchors[index]!, 4);
      // A sphere of radius 1, scaled to 5 pixels.
      expect(mark.scaling.x / heightOf(5, camera, anchors[index]!)).toBeCloseTo(1, 2);
    });
    // The leaders and the marks share the color of their label.
    for (const segment of segments) expect(segment.material).toBe(marks[0]!.material);
  });

  it("are hidden with their mark when their tile is, and leave the layout with their node", () => {
    const { scene, parent, nodes, runtime } = setUp();
    const bodies = nodes.map((node) => runtime.bodyOf(node)!);

    parent.setEnabled(false);
    for (let frame = 0; frame < 3; frame++) scene.render();
    expect(scene.meshes.filter((mesh) => mesh.name === "label-anchor").every((mark) => !mark.isEnabled())).toBe(true);

    parent.setEnabled(true);
    for (let frame = 0; frame < 30; frame++) scene.render();
    expect(bodies.every((body) => body.isEnabled())).toBe(true);

    nodes[0]!.dispose();
    expect(runtime.labelLayout!.labels.get("label-0")).toBeUndefined();
    expect(runtime.labelLayout!.labels.get("label-1")).toBeDefined();
    expect(scene.meshes.filter((mesh) => mesh.name === "label-anchor")).toHaveLength(1);
  });
});

describe("SPACEXR_label in glTF", () => {
  const TAG: SpaceXrLabel = {
    facing: "screen",
    size: { referenceHeight: 0.35, pixels: 14 },
    overlay: true,
    leader: { color: [0.5, 0.25, 0], width: 1.6, anchorRadius: 6 },
    priority: 3,
  };

  const exportGlb = async (label: SpaceXrLabel | undefined): Promise<Uint8Array> => {
    const { scene } = makeScene(true);
    const node = new TransformNode("tag", scene);
    node.position.set(4, 5, 6);
    const box = CreateBox("tag-box", { size: 1 }, scene);
    box.parent = node;
    setNodeLabel(node, label);
    const data = await GLTF2Export.GLBAsync(scene, "content");
    const blob = data.files["content.glb"];
    if (!(blob instanceof Blob)) throw new Error("No GLB was exported.");
    return new Uint8Array(await blob.arrayBuffer());
  };

  /** The JSON chunk of a GLB. */
  const documentOf = (glb: Uint8Array): { extensionsUsed?: string[]; extensionsRequired?: string[]; nodes: { name?: string; extensions?: Record<string, unknown> }[] } => {
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true))));
  };

  beforeAll(() => {
    registerSpaceXrLabelExporter();
    registerSpaceXrLabelLoader();
  });

  it("is written on its node and listed as used, never as required", async () => {
    const document = documentOf(await exportGlb(TAG));

    expect(document.extensionsUsed).toEqual(["SPACEXR_label"]);
    expect(document.extensionsRequired ?? []).toEqual([]);
    expect(document.nodes.find((node) => node.name === "tag")?.extensions).toEqual({ SPACEXR_label: TAG });
    expect(documentOf(await exportGlb(undefined)).extensionsUsed ?? []).toEqual([]);
  });

  it("is read back, and its node attached to the runtime of the scene", async () => {
    const glb = await exportGlb(TAG);
    const { scene } = makeScene(true);
    const runtime = new LabelRuntime(scene, { overlayRenderingGroupId: 2 });

    const container = await LoadAssetContainerAsync(glb, scene, { pluginExtension: ".glb" });

    const tag = container.transformNodes.find((node) => node.name === "tag")!;
    expect(getNodeLabel(tag)).toEqual(TAG);
    // The runtime knows the node: its content is under a body, in the overlay group, and its leader in the layout.
    expect(runtime.bodyOf(tag)?.getChildMeshes().map((mesh) => mesh.renderingGroupId)).toEqual([2]);
    expect(runtime.labelLayout).not.toBeNull();
  });

  it("keeps the hierarchy of its asset container whole: the body of the label is one of its nodes", async () => {
    const glb = await exportGlb(TAG);
    const { scene } = makeScene(true);
    const runtime = new LabelRuntime(scene);
    const warnings: string[] = [];
    const warn = Logger.Warn;
    // Only the warnings of the hierarchy count: the null engine also warns that it has no logarithmic depth.
    Logger.Warn = (message: string | unknown[]) => {
      if (/container|hierarchy/i.test(String(message))) warnings.push(String(message));
    };

    try {
      const container = await LoadAssetContainerAsync(glb, scene, { pluginExtension: ".glb" });
      const tag = container.transformNodes.find((node) => node.name === "tag")!;
      const body = runtime.bodyOf(tag)!;

      // The body waits for its container, then enters and leaves the scene with it.
      expect(container.transformNodes).toContain(body);
      expect(scene.transformNodes).not.toContain(body);
      container.addAllToScene();
      expect(scene.transformNodes).toContain(body);
      expect(scene.transformNodes.filter((node) => node === body)).toHaveLength(1);
      container.removeAllFromScene();
      expect(scene.transformNodes).not.toContain(body);
      container.addAllToScene();
      expect(warnings).toEqual([]);

      // Detached, the label gives its content back and its body leaves the container; attached again, it joins it.
      runtime.detach(tag);
      expect(body.isDisposed()).toBe(true);
      expect(container.transformNodes).not.toContain(body);
      runtime.attach(tag);
      const again = runtime.bodyOf(tag)!;
      expect(container.transformNodes).toContain(again);
      expect(scene.transformNodes).toContain(again);

      container.dispose();
      expect(again.isDisposed()).toBe(true);
      expect(runtime.bodyOf(tag)).toBeUndefined();
      expect(warnings).toEqual([]);
    } finally {
      Logger.Warn = warn;
    }
  });

  it("is kept as a declaration in a scene without a runtime", async () => {
    const glb = await exportGlb({ facing: "screen" });

    const container = await LoadAssetContainerAsync(glb, makeScene(true).scene, { pluginExtension: ".glb" });

    expect(getNodeLabel(container.transformNodes.find((node) => node.name === "tag")!)).toEqual({ facing: "screen" });
  });

  it("is ignored when malformed, and its node still loaded", async () => {
    const glb = await exportGlb({ size: { referenceHeight: -1, pixels: 10 } });

    const container = await LoadAssetContainerAsync(glb, makeScene(true).scene, { pluginExtension: ".glb" });

    const tag = container.transformNodes.find((node) => node.name === "tag");
    expect(tag).toBeDefined();
    expect(getNodeLabel(tag!)).toBeUndefined();
    expect(() => parseSpaceXrLabel({ leader: { color: [2, 0, 0] } })).toThrow();
  });
});

describe("LabelRuntime", () => {
  it("is unique in a scene and is found from it", () => {
    const { scene } = makeScene(true);
    const runtime = new LabelRuntime(scene);
    expect(LabelRuntime.get(scene)).toBe(runtime);
    expect(() => new LabelRuntime(scene)).toThrow();
    runtime.dispose();
    expect(LabelRuntime.get(scene)).toBeUndefined();
  });
});
