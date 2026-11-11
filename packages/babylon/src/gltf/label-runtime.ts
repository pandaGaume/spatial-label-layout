import { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.js";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Logger } from "@babylonjs/core/Misc/logger.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { RadialCandidateGenerator, worldUnitsPerPixel, type EngineOptions } from "@spacexr/spatial-label-layout-core";
import type { BabylonLabelNode } from "../label-renderer.js";
import { BabylonLabelLayout, type BabylonLabelLayoutOptions } from "../layout.js";
import { DEFAULT_LABEL_PRIORITY, DEFAULT_LEADER_WIDTH, getNodeLabel, hasAnchor, type SpaceXrLabel } from "./label.js";

export interface LabelRuntimeOptions {
  /**
   * Rendering group of the labels drawn as overlays, of the leaders and of
   * the anchor marks: it is drawn after the groups below it, on a cleared depth
   * buffer. Default: 1.
   */
  overlayRenderingGroupId?: number;
  /**
   * Whether the scene hides an anchor from an eye, both in the frame of the
   * scene: the far side of a globe, behind its horizon. A label drawn over the
   * scene would show through it there; the runtime hides it instead. Without
   * it, nothing is hidden.
   */
  hides?(anchor: Vector3, eye: Vector3): boolean;
  /**
   * How the labels that have a leader are moved apart and how their leaders are
   * routed: settings of the layout engine, merged over the defaults of this
   * runtime. This is the policy of the client, or of its view.
   */
  layout?: EngineOptions;
  /**
   * The ground the scene displays, for the anchors that stand on it: writes the
   * point of the ground on the vertical of `position`, raised by `offset`, and
   * returns false where no ground is known yet. The same contract as the ground
   * of `SPACEXR_ground_reference`. Without it, such an anchor keeps the
   * position written in the glTF.
   */
  ground?: { project(position: Vector3, offset: number, result: Vector3): boolean };
  /** Frames between two readings of the ground under an anchor. Default: 30. */
  groundRefreshFrames?: number;
}

/** A label the layout places: it has a leader. */
interface LaidOut {
  /** Identity of the label, of its anchor and of its leader in the layout. */
  id: string;
  /** Whether the layout was last told the label shows. */
  visible: boolean;
  material: StandardMaterial;
  /** The mark drawn on the anchor. */
  mark: Mesh | null;
  radius: number;
  /** The local transform this runtime last wrote on the body, to tell when the layout wrote a new one. */
  position: Vector3;
  scaling: Vector3;
  /** Where the anchor stands, in the frame of the scene. */
  anchor: Vector3;
  /** Where the label was last told it prefers to stand: the origin of its node, when its anchor is elsewhere. */
  home: Vector3 | null;
  /** Frame of the last reading of the ground under the anchor. */
  groundFrame: number;
  /** The anchor on the ground, in the frame of the parent of the node, once read. */
  grounded: Vector3 | null;
  /** Whether the layout was last told the scene hides the anchor: the leader and the mark are then hidden. */
  anchorHidden: boolean;
}

interface Entry {
  /** The node of the glTF: its origin is where the label stands. This runtime never moves it. */
  node: TransformNode;
  label: SpaceXrLabel;
  /** Holds the content of the label, below the node: what this runtime turns, scales and moves. */
  body: TransformNode;
  /** View depth of the label for the camera that renders, which orders the overlays. */
  depth: number;
  /** Rank of the label among those attached, which tells two overlays at the same depth apart. */
  order: number;
  laidOut: LaidOut | null;
}

const runtimes = new WeakMap<Scene, LabelRuntime>();
const IDENTITY = Quaternion.Identity();
const DEFAULT_OVERLAY_GROUP = 1;
/** Squared length below which a direction is not usable. */
const EPSILON = 1e-12;
/** Layout of the labels with a leader, unless the application says otherwise: sizes in pixels. */
const LEADER_LENGTH = 34;
const LABEL_PADDING = 6;
/** Distance an anchor moves on screen before the labels are laid out again, in pixels. */
const LAYOUT_STEP = 0.5;
const DEFAULT_GROUND_FRAMES = 30;

/**
 * Applies `SPACEXR_label` to the nodes of a Babylon.js scene, frame after
 * frame and for each camera that renders: a label is parallel to the screen,
 * keeps a size in pixels, is drawn over the scene and, with a leader, is moved
 * away from its anchor so that it covers no other label, a line linking the two.
 *
 * A scene has at most one runtime. The glTF loader of this package attaches
 * the nodes it reads to the runtime of the scene it loads into; a scene without
 * a runtime keeps the declarations and the authored transforms.
 *
 * The node of a label is where it stands, and is never moved here: whatever
 * places it, an animation, a reference to the ground, keeps doing so. Its
 * content is put under a body node, which this runtime turns, scales and moves.
 * A label with an anchor elsewhere is placed around its node and linked to its
 * anchor by its leader, the mark of the anchor drawn there.
 *
 * A label that faces the screen looks along the axis of the camera, not at its
 * position: labels are parallel to one another, and two neighbours never cut
 * through each other. The rotation and the scale of the parents of its node are
 * discarded. In a headset the plane of the screen follows the head: a label
 * then faces the head, the same in both eyes.
 *
 * Labels drawn as overlays are drawn back to front, each one over those behind
 * it: the depth buffer is cleared between two of them, so that the parts of one
 * label still hide one another. Their materials take a logarithmic depth, which
 * keeps those parts in order however far the label is seen from.
 *
 * Limits: a label with a leader always faces the screen, since the layout
 * places a rectangle of the screen, and it is measured from its meshes, centred
 * on its anchor. Leaders share one width, that of the first label that has
 * one. The order of the overlays holds for their opaque parts, and a mesh
 * shared by several nodes as instances is drawn once for all of them. The
 * content of a label is what stands below its node: the mesh of the node
 * itself, if it has one, is left where it is.
 */
export class LabelRuntime {
  private readonly entries = new Map<TransformNode, Entry>();
  /** The overlay each mesh of the overlay group belongs to, by the unique id of the mesh. */
  private readonly overlays = new Map<number, Entry>();
  private readonly overlayObservers = new Map<Mesh, Observer<Mesh>>();
  private readonly overlayGroup: number;
  private readonly hides: ((anchor: Vector3, eye: Vector3) => boolean) | undefined;
  private readonly layoutOptions: EngineOptions;
  private readonly ground: LabelRuntimeOptions["ground"];
  private readonly groundFrames: number;
  /** The overlay whose meshes are being drawn, in the camera that renders. */
  private drawing: Entry | null = null;
  private ordered = false;
  private attached = 0;
  private observer: Observer<Camera> | null;
  /** The layout of the labels with a leader, built with the first of them. */
  private layout: BabylonLabelLayout | null = null;
  private readonly laidOut = new Map<string, Entry>();
  /** The bodies handed to the layout while their label is added to it. */
  private readonly pending = new Map<string, BabylonLabelNode>();
  private readonly materials = new Map<string, StandardMaterial>();
  private layoutFrame = -1;
  private warnedFacing = false;

  /** The runtime of a scene, when it has one. */
  static get(scene: Scene): LabelRuntime | undefined {
    return runtimes.get(scene);
  }

  constructor(
    private readonly scene: Scene,
    options: LabelRuntimeOptions = {},
  ) {
    if (runtimes.has(scene)) throw new Error("This scene already has a label runtime.");
    this.overlayGroup = options.overlayRenderingGroupId ?? DEFAULT_OVERLAY_GROUP;
    this.hides = options.hides ? (anchor, eye) => options.hides!(anchor, eye) : undefined;
    this.layoutOptions = options.layout ?? {};
    this.ground = options.ground;
    this.groundFrames = Math.max(1, options.groundRefreshFrames ?? DEFAULT_GROUND_FRAMES);
    this.observer = scene.onBeforeCameraRenderObservable.add((camera) => this.update(camera));
    scene.onDisposeObservable.addOnce(() => this.dispose());
    runtimes.set(scene, this);
  }

  /** The layout that places the labels with a leader, once one is attached: for diagnostics. */
  get labelLayout(): BabylonLabelLayout | null {
    return this.layout;
  }

  /** The node that holds the content of an attached label, which this runtime places. */
  bodyOf(node: TransformNode): TransformNode | undefined {
    return this.entries.get(node)?.body;
  }

  /** Starts applying the label declared on a node. A node without a declaration is left alone. */
  attach(node: TransformNode): void {
    const label = getNodeLabel(node);
    this.detach(node);
    if (!label) return;
    // The content of the label goes under a body: the node stays the anchor, placed by whatever places it.
    const body = new TransformNode(`${node.name}-label`, this.scene);
    body.rotationQuaternion = Quaternion.Identity();
    for (const child of node.getChildren()) child.parent = body;
    body.parent = node;
    this.join(node, body);
    const entry: Entry = { node, label, body, depth: 0, order: this.attached++, laidOut: null };
    this.entries.set(node, entry);
    node.onDisposeObservable.addOnce(() => this.forget(node));
    if (hasAnchor(label)) this.layOut(entry);
    if (label.overlay) this.overlay(entry);
  }

  /** Stops applying the label of a node, and puts its content back under it as it was authored. */
  detach(node: TransformNode): void {
    const entry = this.entries.get(node);
    if (!entry) return;
    this.forget(node);
    if (node.isDisposed()) return;
    for (const child of entry.body.getChildren()) child.parent = node;
    entry.body.dispose();
  }

  /**
   * Applies the labels for a camera. The runtime calls it before each camera
   * renders; an application that renders outside the render loop of the scene
   * may call it itself.
   */
  update(camera: Camera): void {
    const frame = this.scene.getFrameId();
    const eye = (camera.rigParent ?? camera).globalPosition;
    this.drawing = null;
    for (const entry of this.entries.values()) {
      const { node, body } = entry;
      if (node.isDisposed()) {
        this.forget(node);
        continue;
      }
      // The layout and this runtime enable and disable the body: the node says whether the label shows at all.
      const shown = node.isEnabled();
      const place = node.getAbsolutePosition();
      const visible = shown && !this.hides?.(place, eye);
      if (entry.laidOut) {
        const laidOut = entry.laidOut;
        this.locateAnchor(entry, frame);
        this.layout!.engine.setAnchorPosition(laidOut.id, laidOut.anchor);
        // An anchor apart from the label may be hidden while the label shows: its leader and its mark go then.
        const anchorHidden = !!entry.label.anchor && !!this.hides?.(laidOut.anchor, eye);
        if (anchorHidden !== laidOut.anchorHidden) this.layout!.engine.updateLabel(laidOut.id, { leaderHidden: (laidOut.anchorHidden = anchorHidden) });
        // A label whose anchor is elsewhere prefers to stand by its node: the layout is told when the node moves.
        if (entry.label.anchor && !laidOut.home?.equalsWithEpsilon(place, 1e-6)) {
          laidOut.home = place.clone();
          this.layout!.engine.updateLabel(laidOut.id, { home: { x: place.x, y: place.y, z: place.z } });
        }
        if (visible !== entry.laidOut.visible) this.layout!.engine.updateLabel(entry.laidOut.id, { visible: (entry.laidOut.visible = visible) });
        continue;
      }
      if (!shown) continue;
      body.setEnabled(visible);
      if (visible) this.present(entry, place, camera);
    }
    if (this.layout && this.laidOut.size) this.place(camera, frame);
  }

  /**
   * The order in which the overlay group draws two submeshes: the farthest
   * overlay first, and the meshes of one overlay together. A mesh of the group
   * that belongs to no overlay, a leader or an anchor mark, is drawn before
   * them.
   */
  compareOverlay(a: SubMesh, b: SubMesh): number {
    const first = a.getMesh();
    const second = b.getMesh();
    const near = this.overlays.get(first.uniqueId);
    const far = this.overlays.get(second.uniqueId);
    if (near === far) return first.uniqueId - second.uniqueId;
    if (!near) return -1;
    if (!far) return 1;
    return far.depth - near.depth || near.order - far.order;
  }

  dispose(): void {
    if (this.observer) this.scene.onBeforeCameraRenderObservable.remove(this.observer);
    this.observer = null;
    for (const node of [...this.entries.keys()]) this.detach(node);
    for (const [mesh, observer] of this.overlayObservers) mesh.onBeforeRenderObservable.remove(observer);
    this.overlayObservers.clear();
    this.overlays.clear();
    if (this.ordered && !this.scene.isDisposed) this.scene.setRenderingOrder(this.overlayGroup);
    this.ordered = false;
    this.layout?.dispose();
    this.layout = null;
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    if (runtimes.get(this.scene) === this) runtimes.delete(this.scene);
  }

  /** Turns a label that stays on its anchor toward the screen and gives it its scale, for a camera. */
  private present(entry: Entry, anchor: Vector3, camera: Camera): void {
    const { node, body, label } = entry;
    // The two eyes of a headset share one head: a label gets the same pose in both, or it could not be fused.
    const head = camera.rigParent ?? camera;
    const depth = head === camera ? Math.abs(Vector3.TransformCoordinates(anchor, camera.getViewMatrix()).z) : Vector3.Distance(head.globalPosition, anchor);
    entry.depth = depth;
    const facing = label.facing === "screen";
    const nodeWorld = node.getWorldMatrix();

    let factor = 1;
    if (label.size) {
      // A label that faces the screen discards the scale of its parents: its reference height is that of its node.
      const reference = facing ? Math.abs(node.scaling.y * label.size.referenceHeight) : Vector3.TransformNormal(new Vector3(0, label.size.referenceHeight, 0), nodeWorld).length();
      const unit = this.unitsPerPixel(camera, depth);
      if (reference > EPSILON && unit > 0) factor = (label.size.pixels * unit) / reference;
    }
    body.position.setAll(0);
    if (!facing) {
      body.rotationQuaternion!.copyFrom(IDENTITY);
      body.scaling.setAll(factor);
      return;
    }

    const headWorld = head.getWorldMatrix();
    const mirror = this.scene.useRightHandedSystem ? 1 : -1;
    // On a screen the label is parallel to it: it looks along the axis of the camera, toward the viewer. In a
    // headset that axis turns with the head, and the label looks at the head instead.
    const forward = head === camera ? Vector3.TransformNormal(new Vector3(0, 0, mirror), headWorld) : head.globalPosition.subtract(anchor);
    if (forward.lengthSquared() < EPSILON) return;
    forward.normalize();
    let right = Vector3.Cross(Vector3.TransformNormal(Vector3.UpReadOnly, headWorld), forward);
    // A label on the vertical of the head: the right of the head decides.
    if (right.lengthSquared() < EPSILON) right = Vector3.Cross(forward, Vector3.TransformNormal(Vector3.RightReadOnly, headWorld));
    right.normalize();
    const rotation = Quaternion.RotationQuaternionFromAxis(right, Vector3.Cross(forward, right), forward);
    // The face of a label looks toward its local +Z, which a left-handed scene mirrors: the rotation is that of
    // the mirrored axes, and the mirror itself goes with the scale, since the parents that carried it are discarded.
    if (mirror < 0) rotation.multiplyInPlace(Quaternion.RotationAxis(Vector3.UpReadOnly, Math.PI));
    const scale = new Vector3(node.scaling.x * factor, node.scaling.y * factor, node.scaling.z * factor * mirror);
    const local = Matrix.Compose(scale, rotation, anchor).multiply(nodeWorld.clone().invert());
    local.decompose(body.scaling, body.rotationQuaternion!, body.position);
  }

  /** Length a CSS pixel covers in the scene at a view depth. */
  private unitsPerPixel(camera: Camera, depth: number): number {
    const engine = this.scene.getEngine();
    const renderHeight = engine.getRenderHeight(true) * camera.viewport.height;
    const height = Math.max(1, renderHeight * engine.getHardwareScalingLevel());
    if (camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
      const top = camera.orthoTop ?? renderHeight / 2;
      const bottom = camera.orthoBottom ?? -renderHeight / 2;
      return Math.abs(top - bottom) / height;
    }
    let tangent = Math.tan(camera.fov / 2);
    if (camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED) tangent *= renderHeight / Math.max(1, engine.getRenderWidth(true) * camera.viewport.width);
    return (2 * depth * tangent) / height;
  }

  /** Hands a label that has a leader to the layout, with its leader and the mark of its anchor. */
  private layOut(entry: Entry): void {
    const { node, body, label } = entry;
    const leader = label.leader ?? {};
    if (label.facing !== "screen" && !this.warnedFacing) {
      this.warnedFacing = true;
      Logger.Warn("SPACEXR_label: a label with a leader faces the screen, whatever its facing.");
    }
    const id = `label-${entry.order}`;
    const radius = leader.anchorRadius ?? 0;
    const material = this.material(leader.color ?? [1, 1, 1]);
    const layout = (this.layout ??= this.createLayout(leader.width ?? DEFAULT_LEADER_WIDTH));
    let mark: Mesh | null = null;
    if (radius > 0) {
      mark = CreateSphere("label-anchor", { diameter: 2, segments: 12 }, this.scene);
      mark.material = material;
      mark.renderingGroupId = this.overlayGroup;
      mark.isPickable = false;
      mark.setEnabled(false);
    }
    entry.laidOut = {
      id,
      visible: false,
      material,
      mark,
      radius,
      position: new Vector3(NaN, NaN, NaN),
      scaling: new Vector3(NaN, NaN, NaN),
      anchor: node.getAbsolutePosition().clone(),
      home: label.anchor ? node.getAbsolutePosition().clone() : null,
      groundFrame: -Infinity,
      grounded: null,
      anchorHidden: false,
    };
    this.locateAnchor(entry, this.scene.getFrameId());
    this.laidOut.set(id, entry);

    const { width, height } = this.measure(entry);
    // A label that keeps its size on screen is measured in pixels; any other one in the units of the scene.
    const factor = label.size ? label.size.pixels / label.size.referenceHeight : Math.abs(node.scaling.y);
    // The body belongs to its label: the layout places it and never disposes it.
    this.pending.set(id, { node: body, width, height, front: "+z", dispose: () => undefined });
    layout.engine.setAnchorPosition(id, entry.laidOut.anchor);
    layout.controller.addLabel({
      id,
      anchorId: id,
      position: node.getAbsolutePosition(),
      ...(entry.laidOut.home ? { home: { x: entry.laidOut.home.x, y: entry.laidOut.home.y, z: entry.laidOut.home.z } } : {}),
      dimensions: { width: width * factor, height: height * factor },
      sizing: label.size ? "screen" : "world",
      priority: label.priority ?? DEFAULT_LABEL_PRIORITY,
      visible: false,
      enabled: true,
    });
    this.pending.delete(id);
  }

  private createLayout(leaderWidth: number): BabylonLabelLayout {
    const camera = this.scene.activeCamera;
    const options: BabylonLabelLayoutOptions = {
      scene: this.scene,
      ...(camera ? { camera } : {}),
      // The layout advances in `update`, once the camera of the frame is set.
      autoTick: false,
      labels: { create: (label) => this.pending.get(label.id)! },
      leaders: {
        width: leaderWidth,
        material: (leader) => this.laidOut.get(leader.labelId)!.laidOut!.material,
        configure: (mesh) => {
          mesh.renderingGroupId = this.overlayGroup;
          mesh.isPickable = false;
        },
      },
      engine: {
        leaderLengthPx: LEADER_LENGTH,
        paddingPx: LABEL_PADDING,
        // A label that nothing pushes away stands above its anchor and to its left.
        candidates: new RadialCandidateGenerator({ startAngle: (3 * Math.PI) / 4 }),
        declutter: { enabled: true },
        defaultRouting: "elbow",
        // The label of an anchor that left the screen leaves with it, and gives its room to the others.
        anchorOutOfView: "hide",
        temporal: { screenThresholdPx: LAYOUT_STEP },
        ...this.layoutOptions,
      },
    };
    return new BabylonLabelLayout(options);
  }

  /** Lets the layout place its labels, then puts each body back under its node and sizes its anchor mark. */
  private place(camera: Camera, frame: number): void {
    const layout = this.layout!;
    // One layout per frame: the two eyes of a headset see the same placement.
    if (frame !== this.layoutFrame) {
      this.layoutFrame = frame;
      layout.tick(this.scene.getEngine().getDeltaTime() / 1000);
    }
    const view = layout.view;
    for (const entry of this.laidOut.values()) {
      const { node, body } = entry;
      const laidOut = entry.laidOut!;
      // The layout writes the transform of the body in the frame of the scene, as if it had no parent: it is put
      // back in the frame of its node, once per transform the layout writes.
      if (body.isEnabled(false) && !(body.position.equals(laidOut.position) && body.scaling.equals(laidOut.scaling))) {
        const world = Matrix.Compose(body.scaling, body.rotationQuaternion!, body.position);
        entry.depth = Math.abs(Vector3.TransformCoordinates(body.position, camera.getViewMatrix()).z);
        world.multiply(node.getWorldMatrix().clone().invert()).decompose(body.scaling, body.rotationQuaternion!, body.position);
        laidOut.position.copyFrom(body.position);
        laidOut.scaling.copyFrom(body.scaling);
      }
      if (!laidOut.mark) continue;
      const anchor = laidOut.anchor;
      const scale = laidOut.visible && !laidOut.anchorHidden && view ? worldUnitsPerPixel(view, anchor) * laidOut.radius : 0;
      laidOut.mark.setEnabled(scale > 0);
      if (scale > 0) {
        laidOut.mark.position.copyFrom(anchor);
        laidOut.mark.scaling.setAll(scale);
      }
    }
  }

  /**
   * Where the anchor of a laid out label stands in the frame of the scene: the
   * origin of its node, or the point of `anchor` in the frame of the parent of the
   * node, set on the ground when it refers to it and the ground is known. The
   * ground is read again every few frames, as it refines.
   */
  private locateAnchor(entry: Entry, frame: number): void {
    const laidOut = entry.laidOut!;
    const anchor = entry.label.anchor;
    if (!anchor) {
      laidOut.anchor.copyFrom(entry.node.getAbsolutePosition());
      return;
    }
    const parent = entry.node.parent;
    const world = parent ? parent.getWorldMatrix() : Matrix.IdentityReadOnly;
    const local = Vector3.FromArray(anchor.position);
    if (anchor.ground && this.ground) {
      if (frame - laidOut.groundFrame >= this.groundFrames) {
        laidOut.groundFrame = frame;
        const written = Vector3.TransformCoordinates(local, world);
        const grounded = new Vector3();
        laidOut.grounded = this.ground.project(written, anchor.ground.offset ?? 0, grounded)
          ? Vector3.TransformCoordinates(grounded, world.clone().invert())
          : null;
      }
      if (laidOut.grounded) local.copyFrom(laidOut.grounded);
    }
    Vector3.TransformCoordinatesToRef(local, world, laidOut.anchor);
  }

  /** The size of a label along the local x and y axes of its node, from its meshes: the rectangle centred on its anchor. */
  private measure(entry: Entry): { width: number; height: number } {
    const { node, body } = entry;
    node.computeWorldMatrix(true);
    const inverse = node.getWorldMatrix().clone().invert();
    let halfWidth = 0;
    let halfHeight = 0;
    const local = new Vector3();
    for (const mesh of body.getChildMeshes(false)) {
      if (!mesh.getTotalVertices()) continue;
      mesh.computeWorldMatrix(true);
      for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
        Vector3.TransformCoordinatesToRef(corner, inverse, local);
        halfWidth = Math.max(halfWidth, Math.abs(local.x));
        halfHeight = Math.max(halfHeight, Math.abs(local.y));
      }
    }
    return { width: Math.max(halfWidth * 2, 1e-6), height: Math.max(halfHeight * 2, 1e-6) };
  }

  /** The unlit material of the leaders and anchor marks of a color, given linear. */
  private material(color: readonly [number, number, number]): StandardMaterial {
    const key = color.join(",");
    let material = this.materials.get(key);
    if (!material) {
      material = new StandardMaterial("label-leader", this.scene);
      material.disableLighting = true;
      material.emissiveColor = new Color3(color[0], color[1], color[2]).toGammaSpace();
      this.materials.set(key, material);
    }
    return material;
  }

  /**
   * Draws the meshes of a label after the rest of the scene, without testing
   * their depth against it, and in the order of the overlays.
   */
  private overlay(entry: Entry): void {
    for (const mesh of entry.body.getChildMeshes(false)) {
      // An instance is drawn in the group of the mesh it repeats, and with it.
      const drawn = ((mesh as InstancedMesh).sourceMesh ?? mesh) as Mesh;
      drawn.renderingGroupId = this.overlayGroup;
      this.overlays.set(drawn.uniqueId, entry);
      // The parts of a label, its plate and its text, stand a hair apart in depth, and a label seen from far is
      // scaled thousands of times: a linear depth buffer cannot tell them apart there. The labels are alone in
      // their depth buffer, cleared for each of them: a logarithmic depth keeps their parts in order.
      const material = drawn.material as (Material & { useLogarithmicDepth?: boolean }) | null;
      if (material && "useLogarithmicDepth" in material) material.useLogarithmicDepth = true;
      if (!this.overlayObservers.has(drawn) && drawn.onBeforeRenderObservable)
        this.overlayObservers.set(
          drawn,
          drawn.onBeforeRenderObservable.add(() => this.separate(this.overlays.get(drawn.uniqueId))),
        );
    }
    this.scene.setRenderingAutoClearDepthStencil(this.overlayGroup, true, true, true);
    if (!this.ordered) {
      this.ordered = true;
      const compare = (a: SubMesh, b: SubMesh): number => this.compareOverlay(a, b);
      this.scene.setRenderingOrder(this.overlayGroup, compare, compare, compare);
    }
  }

  /** Clears the depth buffer when the overlay being drawn changes: the new one is drawn over the previous ones. */
  private separate(entry: Entry | undefined): void {
    if (!entry || entry === this.drawing) return;
    if (this.drawing) this.scene.getEngine().clear(null, false, true, false);
    this.drawing = entry;
  }

  /**
   * Puts the body of a label in the asset container of its node, when the node
   * was loaded into one. The body stands between the node and its content: a
   * container that held the two without it would have a broken hierarchy. The
   * body then enters and leaves the scene with its container, and is disposed
   * with it.
   */
  private join(node: TransformNode, body: TransformNode): void {
    // Babylon.js keeps the container of a node there, and takes a node out of the list of its container on dispose.
    const container = node._parentContainer;
    if (!container) return;
    container.transformNodes.push(body);
    body._parentContainer = container;
    // A container that was not added to the scene yet adds its nodes itself.
    const inScene = this.scene.transformNodes.includes(node) || (this.scene.meshes as readonly TransformNode[]).includes(node);
    if (!inScene) this.scene.removeTransformNode(body);
  }

  /** Stops following a node: its place in the layout, its anchor mark and the order of its meshes. */
  private forget(node: TransformNode): void {
    const entry = this.entries.get(node);
    this.entries.delete(node);
    if (!entry) return;
    if (this.drawing === entry) this.drawing = null;
    if (entry.laidOut) {
      this.laidOut.delete(entry.laidOut.id);
      this.layout?.controller.removeLabel(entry.laidOut.id);
      this.layout?.engine.removeAnchor(entry.laidOut.id);
      entry.laidOut.mark?.dispose();
    }
    for (const [id, owner] of this.overlays) if (owner === entry) this.overlays.delete(id);
    for (const [mesh, observer] of this.overlayObservers) {
      if (this.overlays.has(mesh.uniqueId)) continue;
      mesh.onBeforeRenderObservable.remove(observer);
      this.overlayObservers.delete(mesh);
    }
  }
}
