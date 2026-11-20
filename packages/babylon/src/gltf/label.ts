import type { Node } from "@babylonjs/core/node.js";
import type { SpaceXrLabel } from "@spacexr/spatial-label-layout-core";

// The extension itself is defined in the core: kept here for the applications that import it from this package.
export {
  SPACEXR_LABEL,
  DEFAULT_LABEL_PRIORITY,
  DEFAULT_LEADER_WIDTH,
  cloneJson,
  hasAnchor,
  isLabelId,
  parseSpaceXrLabel,
  type JsonValue,
  type SpaceXrLabel,
  type SpaceXrLabelAnchor,
  type SpaceXrLabelLeader,
  type SpaceXrLabelSize,
  type SpaceXrLabelUserData,
} from "@spacexr/spatial-label-layout-core";

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
