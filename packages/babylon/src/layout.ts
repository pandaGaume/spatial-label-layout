import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Scene } from "@babylonjs/core/scene.js";
import {
  LabelLayoutController,
  type LabelLayoutControllerOptions,
  type ResolvedView,
  type SpatialLabelLayoutEngine,
} from "@spatial-label-layout/core";
import { BabylonCameraProvider, type PixelUnit } from "./camera.js";
import { BabylonLabelRenderer, type BabylonLabelRendererOptions } from "./label-renderer.js";
import { BabylonLeaderRenderer, type BabylonLeaderRendererOptions } from "./leader-renderer.js";

export interface BabylonLabelLayoutOptions extends Pick<LabelLayoutControllerOptions, "engine" | "anchors" | "scheduler" | "interpolator" | "onSolve"> {
  scene: Scene;
  /** Camera the labels are laid out for. Default: the active camera of the scene. */
  camera?: Camera;
  /** Unit of every pixel quantity of the layout (default "css"). */
  pixels?: PixelUnit;
  /** How labels are drawn. */
  labels: BabylonLabelRendererOptions;
  /** How leaders are drawn (width in pixels by default); false for no leader. */
  leaders?: Omit<BabylonLeaderRendererOptions, "view"> | false;
  /**
   * Advances the layout before each render of the scene (default true). Pass
   * false in an application that runs its own frame loop, and call `tick()`
   * there once the camera of the frame is set.
   */
  autoTick?: boolean;
}

/**
 * The layout wired to a Babylon.js scene (brief: BabylonLabelLayoutController):
 * camera provider, label and leader renderers, and the hook in the render loop.
 * Labels and anchors are added through `controller` and `engine`.
 */
export class BabylonLabelLayout {
  readonly controller: LabelLayoutController;
  readonly camera: BabylonCameraProvider;
  readonly labels: BabylonLabelRenderer;
  readonly leaders: BabylonLeaderRenderer | null;
  private observer: Observer<Scene> | null = null;

  constructor(private readonly options: BabylonLabelLayoutOptions) {
    const { scene } = options;
    this.camera = new BabylonCameraProvider(scene, {
      ...(options.camera ? { camera: options.camera } : {}),
      ...(options.pixels ? { pixels: options.pixels } : {}),
    });
    this.labels = new BabylonLabelRenderer(options.labels);
    this.leaders = options.leaders === false ? null : new BabylonLeaderRenderer(scene, { ...options.leaders, view: () => this.controller.view });
    this.controller = new LabelLayoutController({
      camera: this.camera,
      labelRenderer: this.labels,
      ...(this.leaders ? { leaderRenderer: this.leaders } : {}),
      ...(options.engine ? { engine: options.engine } : {}),
      ...(options.anchors ? { anchors: options.anchors } : {}),
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
      ...(options.interpolator ? { interpolator: options.interpolator } : {}),
      ...(options.onSolve ? { onSolve: options.onSolve } : {}),
    });
    if (options.autoTick !== false) this.observer = scene.onBeforeRenderObservable.add(() => this.tick());
  }

  get engine(): SpatialLabelLayoutEngine {
    return this.controller.engine;
  }

  /** Reference view of the last frame, to size what the application draws itself (pins...). */
  get view(): ResolvedView | null {
    return this.controller.view;
  }

  /** Advances one rendered frame. `deltaSeconds` defaults to the frame time of the engine. */
  tick(deltaSeconds: number = this.options.scene.getEngine().getDeltaTime() / 1000): void {
    this.controller.tick(deltaSeconds);
  }

  dispose(): void {
    if (this.observer) this.options.scene.onBeforeRenderObservable.remove(this.observer);
    this.observer = null;
    // Disposes the renderers and their meshes too.
    this.controller.dispose();
  }
}
