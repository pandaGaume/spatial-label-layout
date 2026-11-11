import type { Node } from "@babylonjs/core/node.js";

/** Name of the glTF node extension that makes a node a label. */
export const SPACEXR_LABEL = "SPACEXR_label";

/** The size a label keeps on screen: a length of its local +Y axis and the height it takes. */
export interface SpaceXrLabelSize {
  /** Reference height along the local +Y axis of the node, in its local frame. */
  referenceHeight: number;
  /** Height the reference height takes on screen, in CSS reference pixels. */
  pixels: number;
}

/** The leader of a label: the client may move the label away from its anchor, and links the two. */
export interface SpaceXrLabelLeader {
  /** Linear RGB color of the leader and of the anchor mark. Default: white. */
  color?: [number, number, number];
  /** Width of the leader, in pixels. Default: `DEFAULT_LEADER_WIDTH`. */
  width?: number;
  /** Radius of the mark drawn on the anchor, in pixels. Default: 0, no mark. */
  anchorRadius?: number;
}

/**
 * `SPACEXR_label` of a glTF node: the node is a label, an object made to be
 * read, attached to the point it names, its origin, called its anchor. Its
 * content, the nodes below it, reads along the local +X axis, its height along
 * +Y, its face toward +Z. Every property is optional.
 */
export interface SpaceXrLabel {
  /** "screen": the label stays parallel to the screen. Without it, it keeps the orientation of the glTF. */
  facing?: "screen";
  /** The size the label keeps on screen. Without it, it keeps its metric size. */
  size?: SpaceXrLabelSize;
  /** Draws the label over the rest of the scene, never occluded. Default: false. */
  overlay?: boolean;
  /** Lets the client move the label away from its anchor to avoid overlaps, with a leader between them. */
  leader?: SpaceXrLabelLeader;
  /** Labels of higher priority move less and are hidden last. Default: `DEFAULT_LABEL_PRIORITY`. */
  priority?: number;
}

export const DEFAULT_LEADER_WIDTH = 1.5;
export const DEFAULT_LABEL_PRIORITY = 1;

const labels = new WeakMap<Node, SpaceXrLabel>();

/** The label declared on a node, by the loader or by the application. */
export const getNodeLabel = (node: Node): SpaceXrLabel | undefined => labels.get(node);

/**
 * Declares a node as a label, or removes the declaration. The declaration is
 * data: the exporter writes it, and a `LabelRuntime` applies it to the nodes
 * attached to it.
 */
export const setNodeLabel = (node: Node, label: SpaceXrLabel | undefined): void => {
  if (label) labels.set(node, label);
  else labels.delete(node);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const positive = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a number greater than zero.`);
  return value;
};

/** Reads a `SPACEXR_label` object. Throws when a property has the wrong type or is out of range. */
export const parseSpaceXrLabel = (value: unknown): SpaceXrLabel => {
  if (!isRecord(value)) throw new Error(`${SPACEXR_LABEL} must be an object.`);
  const label: SpaceXrLabel = {};
  if (value.facing !== undefined) {
    if (value.facing !== "screen") throw new Error('facing must be "screen".');
    label.facing = "screen";
  }
  if (value.size !== undefined) {
    if (!isRecord(value.size)) throw new Error("size must be an object.");
    label.size = { referenceHeight: positive(value.size.referenceHeight, "size.referenceHeight"), pixels: positive(value.size.pixels, "size.pixels") };
  }
  if (value.overlay !== undefined) {
    if (typeof value.overlay !== "boolean") throw new Error("overlay must be a boolean.");
    label.overlay = value.overlay;
  }
  if (value.leader !== undefined) {
    if (!isRecord(value.leader)) throw new Error("leader must be an object.");
    const leader: SpaceXrLabelLeader = {};
    const color = value.leader.color;
    if (color !== undefined) {
      if (!Array.isArray(color) || color.length !== 3 || color.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 1))
        throw new Error("leader.color must be three numbers from 0 to 1.");
      leader.color = [color[0] as number, color[1] as number, color[2] as number];
    }
    if (value.leader.width !== undefined) leader.width = positive(value.leader.width, "leader.width");
    const radius = value.leader.anchorRadius;
    if (radius !== undefined) {
      if (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0) throw new Error("leader.anchorRadius must be a number, zero or greater.");
      leader.anchorRadius = radius;
    }
    label.leader = leader;
  }
  if (value.priority !== undefined) {
    if (typeof value.priority !== "number" || !Number.isFinite(value.priority)) throw new Error("priority must be a finite number.");
    label.priority = value.priority;
  }
  return label;
};
