import type { Node } from "@babylonjs/core/node.js";
import type { Nullable } from "@babylonjs/core/types.js";
import { GLTFExporter } from "@babylonjs/serializers/glTF/2.0/glTFExporter.js";
import type { IGLTFExporterExtensionV2 } from "@babylonjs/serializers/glTF/2.0/glTFExporterExtension.js";
import { SPACEXR_LABEL, getNodeLabel } from "./label.js";

type ExportNode = NonNullable<IGLTFExporterExtensionV2["postExportNodeAsync"]>;
type GltfNode = Parameters<ExportNode>[1];

/**
 * Exporter of `SPACEXR_label`: it writes the label the application declared
 * on a Babylon.js node into its glTF node. The extension is listed in
 * `extensionsUsed` when a node carries it, and never in `extensionsRequired`:
 * a client that does not know it shows the node with the transform written in
 * the glTF.
 */
class SpaceXrLabelExporter implements IGLTFExporterExtensionV2 {
  readonly name = SPACEXR_LABEL;
  enabled = true;
  readonly required = false;
  wasUsed = false;

  async postExportNodeAsync(
    _context: string,
    node: GltfNode,
    babylonNode: Node,
    _nodeMap?: unknown,
    convertToRightHanded?: boolean,
  ): Promise<Nullable<GltfNode>> {
    const label = getNodeLabel(babylonNode);
    if (label) {
      // The anchor is in the frame of the parent of the node: it is converted as the translation of the node is.
      const anchor = label.anchor && {
        position: [convertToRightHanded ? -label.anchor.position[0] : label.anchor.position[0], label.anchor.position[1], label.anchor.position[2]],
        ...(label.anchor.ground ? { ground: { ...label.anchor.ground } } : {}),
      };
      const written = {
        ...label,
        ...(label.size ? { size: { ...label.size } } : {}),
        ...(label.leader ? { leader: { ...label.leader } } : {}),
        ...(anchor ? { anchor } : {}),
      };
      node.extensions = { ...node.extensions, [SPACEXR_LABEL]: written };
      this.wasUsed = true;
    }
    return node;
  }

  dispose(): void {
    // Nothing is held between two exports.
  }
}

/**
 * Where exporter extensions are registered: the `GLTFExporter` class of the
 * Babylon.js serializers. An application that may hold another copy of the
 * serializers than this package resolves passes its own class.
 */
export interface GltfExporterRegistry {
  // The classes of another copy of Babylon.js are other types to the compiler, though the same at run time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RegisterExtension(name: string, factory: (exporter: any) => any, order?: number): void;
  UnregisterExtension(name: string): boolean;
}

/**
 * Registers the exporter of `SPACEXR_label` with the glTF exporter of
 * Babylon.js. An application calls it once, before it exports glTF.
 */
export const registerSpaceXrLabelExporter = (registry: GltfExporterRegistry = GLTFExporter): void => {
  registry.UnregisterExtension(SPACEXR_LABEL);
  registry.RegisterExtension(SPACEXR_LABEL, () => new SpaceXrLabelExporter());
};
