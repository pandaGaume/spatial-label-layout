import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { BillboardTransform, LabelRenderer, SpatialLabel } from "@spacexr/spatial-label-layout-core";

/**
 * What draws one label: a 3D object of the application, whatever it is made
 * of (an extruded tag, a textured plane, a group of meshes...). Its local x
 * axis reads to the right and its local y axis upward. The node must have no
 * parent that moves it: the renderer writes its world position, rotation and
 * scaling (with `orientation: "native"`, its billboard mode instead of its
 * rotation).
 */
export interface BabylonLabelNode {
  node: TransformNode;
  /** Size of the node along its local x and y axes, before scaling, in any unit. */
  width: number;
  height: number;
  /**
   * Local z direction the readable face of the node looks toward. Default "-z",
   * as the planes Babylon.js builds; "+z" for an object modelled with its face
   * toward +z (x right, y up, z toward the reader). The renderer turns that
   * face to the viewer in left- and right-handed scenes alike.
   */
  front?: "+z" | "-z";
  /** Releases what the node owns. Default: `node.dispose()`. */
  dispose?(): void;
}

/**
 * Who turns the label nodes toward the viewer.
 * - "layout" (default): the renderer writes the rotation of each node from the
 *   axes the layout solved the label with, whatever orienter the engine uses.
 * - "native": the node carries `BILLBOARDMODE_ALL` and Babylon.js turns it to
 *   the camera it renders with; the renderer writes only its position and
 *   scaling. That billboard is parallel to the image plane, so the engine must
 *   use a screen-aligned orienter (its default).
 */
export type BabylonLabelOrientation = "layout" | "native";

/** `TransformNode.BILLBOARDMODE_ALL`, without importing the class and its side effects. */
const BILLBOARDMODE_ALL = 7;

export interface BabylonLabelRendererOptions {
  /** Builds the node of a label when it enters the layout. */
  create(label: Readonly<SpatialLabel>): BabylonLabelNode;
  /** Default "layout". */
  orientation?: BabylonLabelOrientation;
  /** The payload of a label changed (`controller.updateLabel`): text, style... */
  refresh?(label: Readonly<SpatialLabel>, node: BabylonLabelNode): void;
}

const AXIS_X = new Vector3();
const AXIS_Y = new Vector3();
const AXIS_Z = new Vector3();

/**
 * Billboard port for Babylon.js (brief: BabylonBillboardAdapter).
 *
 * By default each node is oriented from the axes the layout measured the
 * label with, not from a billboard mode of the engine: the quad drawn is the
 * quad solved. With `orientation: "native"`, Babylon.js orients it with
 * `BILLBOARDMODE_ALL`, which gives the same axes as the screen-aligned
 * orienter of the core for the camera the layout reads.
 * The node is scaled so that its local size shows as the size the layout
 * gives, which follows the camera for labels with "screen" sizing.
 */
export class BabylonLabelRenderer implements LabelRenderer {
  private readonly nodes = new Map<string, BabylonLabelNode>();
  readonly orientation: BabylonLabelOrientation;

  constructor(private readonly options: BabylonLabelRendererOptions) {
    this.orientation = options.orientation ?? "layout";
  }

  /** The node of a label, to restyle or pick it. */
  get(id: string): BabylonLabelNode | undefined {
    return this.nodes.get(id);
  }

  createLabel(label: Readonly<SpatialLabel>): void {
    this.removeLabel(label.id);
    const entry = this.options.create(label);
    entry.node.rotationQuaternion ??= new Quaternion();
    if (this.orientation === "native") {
      // Babylon.js applies the billboard after the local rotation of the node, which must stay neutral.
      entry.node.rotationQuaternion.copyFromFloats(0, 0, 0, 1);
      entry.node.billboardMode = BILLBOARDMODE_ALL;
    }
    // Nothing shows before the layout placed the label.
    entry.node.setEnabled(false);
    this.nodes.set(label.id, entry);
  }

  updateLabel(id: string, transform: BillboardTransform, visible: boolean): void {
    const entry = this.nodes.get(id);
    if (!entry) return;
    const node = entry.node;
    node.setEnabled(visible);
    if (!visible) return;
    const { position, right, up } = transform;
    node.position.set(position.x, position.y, position.z);
    const scale = transform.width / entry.width;
    const front = entry.front ?? "-z";
    if (this.orientation === "native") {
      // The billboard of Babylon.js turns local -z toward the viewer in left- and right-handed scenes alike.
      node.scaling.set(scale, transform.height / entry.height, front === "-z" ? scale : -scale);
      return;
    }
    // A rotation takes its third axis from the first two, whatever the handedness of the scene.
    AXIS_X.set(right.x, right.y, right.z);
    AXIS_Y.set(up.x, up.y, up.z);
    Vector3.CrossToRef(AXIS_X, AXIS_Y, AXIS_Z);
    Quaternion.RotationQuaternionFromAxisToRef(AXIS_X, AXIS_Y, AXIS_Z, node.rotationQuaternion as Quaternion);
    // That third axis looks toward the viewer or away, depending on the handedness of the view: the depth of
    // the node is mirrored when its face would look the wrong way. Its x and y axes, which carry the reading
    // direction, are never mirrored.
    const towardViewer = AXIS_Z.x * transform.normal.x + AXIS_Z.y * transform.normal.y + AXIS_Z.z * transform.normal.z >= 0;
    node.scaling.set(scale, transform.height / entry.height, towardViewer === (front === "+z") ? scale : -scale);
  }

  refreshLabel(label: Readonly<SpatialLabel>): void {
    const entry = this.nodes.get(label.id);
    if (entry) this.options.refresh?.(label, entry);
  }

  removeLabel(id: string): void {
    const entry = this.nodes.get(id);
    if (!entry) return;
    this.nodes.delete(id);
    if (entry.dispose) entry.dispose();
    else entry.node.dispose();
  }

  dispose(): void {
    for (const id of [...this.nodes.keys()]) this.removeLabel(id);
  }
}
