import type { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Logger } from "@babylonjs/core/Misc/logger.js";
import type { Nullable } from "@babylonjs/core/types.js";
import type { GLTFLoader } from "@babylonjs/loaders/glTF/2.0/glTFLoader.js";
import type { IGLTFLoaderExtension } from "@babylonjs/loaders/glTF/2.0/glTFLoaderExtension.js";
import { registerGLTFExtension, unregisterGLTFExtension } from "@babylonjs/loaders/glTF/2.0/glTFLoaderExtensionRegistry.js";
import { LabelRuntime } from "./label-runtime.js";
import { SPACEXR_LABEL, parseSpaceXrLabel, setNodeLabel } from "./label.js";

type LoadNode = NonNullable<IGLTFLoaderExtension["loadNodeAsync"]>;
type GltfNode = Parameters<LoadNode>[1];

/**
 * Loader of `SPACEXR_label`: it declares the label on the Babylon.js node,
 * then hands the node to the label runtime of the scene once the asset is
 * whole. A malformed extension is reported and ignored: the node keeps the
 * transform written in the glTF, as for a client that does not know the
 * extension.
 */
class SpaceXrLabelLoader implements IGLTFLoaderExtension {
  readonly name = SPACEXR_LABEL;
  enabled: boolean;
  private loader: GLTFLoader | null;
  private readonly nodes: TransformNode[] = [];

  constructor(loader: GLTFLoader) {
    this.loader = loader;
    this.enabled = loader.isExtensionUsed(SPACEXR_LABEL);
  }

  loadNodeAsync(context: string, node: GltfNode, assign: (babylonNode: TransformNode) => void): Nullable<Promise<TransformNode>> {
    const value = (node.extensions as Record<string, unknown> | undefined)?.[SPACEXR_LABEL];
    if (value === undefined || !this.loader) return null;
    return this.loader.loadNodeAsync(context, node, (babylonNode) => {
      try {
        setNodeLabel(babylonNode, parseSpaceXrLabel(value));
        this.nodes.push(babylonNode);
      } catch (error) {
        Logger.Warn(`${context}: ${SPACEXR_LABEL} ignored. ${error instanceof Error ? error.message : String(error)}`);
      }
      assign(babylonNode);
    });
  }

  onReady(): void {
    // The content of the labels exists now: the runtime can measure it and reach what an overlay draws last.
    const runtime = this.loader && LabelRuntime.get(this.loader.babylonScene);
    if (runtime) for (const node of this.nodes) if (!node.isDisposed()) runtime.attach(node);
    this.nodes.length = 0;
  }

  dispose(): void {
    this.loader = null;
    this.nodes.length = 0;
  }
}

/**
 * Registers the loader of `SPACEXR_label` with the glTF loader of Babylon.js.
 * An application calls it once, as it registers the glTF loader.
 */
export const registerSpaceXrLabelLoader = (): void => {
  unregisterGLTFExtension(SPACEXR_LABEL);
  registerGLTFExtension(SPACEXR_LABEL, true, (loader) => new SpaceXrLabelLoader(loader));
};
