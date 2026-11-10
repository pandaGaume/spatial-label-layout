import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { CameraProvider, CameraView } from "@spacexr/spatial-label-layout-core";

/**
 * Unit of the viewport handed to the solver, and therefore of every pixel
 * quantity of the layout: "screen" sized labels, `paddingPx`, `leaderLengthPx`...
 * - "css": CSS pixels, independent of the hardware scaling level and of the device pixel ratio.
 * - "render": pixels of the render target.
 */
export type PixelUnit = "css" | "render";

export interface BabylonCameraProviderOptions {
  /** Camera to read. Default: the active camera of the scene, read again at every frame. */
  camera?: Camera;
  /** Default "css". */
  pixels?: PixelUnit;
}

/**
 * Camera port for Babylon.js (brief: BabylonCameraProvider).
 *
 * A plain camera gives one view. A camera with rig cameras (WebXR, stereoscopic
 * rigs) gives one view per rig camera, with the rig parent as reference view;
 * that path has not run in a headset yet.
 *
 * Matrices are copied at every call: Babylon.js rewrites its own in place, and
 * the solver keeps the view of its last solve. They are read as they are, in
 * left- and right-handed scenes alike, and in scenes with floating origin
 * (large world rendering), whose view matrix holds the true world position.
 */
export class BabylonCameraProvider implements CameraProvider {
  referenceFrameVersion = 0;
  private readonly fixed: Camera | undefined;
  private readonly pixels: PixelUnit;

  constructor(
    private readonly scene: Scene,
    options: BabylonCameraProviderOptions = {},
  ) {
    this.fixed = options.camera;
    this.pixels = options.pixels ?? "css";
  }

  /** Call on an XR session start or end, a recentering, a teleport: the layout starts over. */
  bumpReferenceFrame(): void {
    this.referenceFrameVersion++;
  }

  getViews(): CameraView[] {
    const camera = this.camera;
    if (!camera) return [];
    const rig = camera.rigCameras;
    if (rig.length > 1) return rig.map((eye, i) => this.viewOf(eye, i === 0 ? "left" : i === 1 ? "right" : `eye-${i}`)).filter((v): v is CameraView => v !== null);
    const mono = this.viewOf(camera, "mono");
    return mono ? [mono] : [];
  }

  getReferenceView(): CameraView | undefined {
    const camera = this.camera;
    if (!camera || camera.rigCameras.length <= 1) return undefined;
    return this.viewOf(camera, "center") ?? undefined;
  }

  private get camera(): Camera | null {
    return this.fixed ?? this.scene.activeCamera;
  }

  private viewOf(camera: Camera, id: string): CameraView | null {
    const engine = this.scene.getEngine();
    const scale = this.pixels === "css" ? engine.getHardwareScalingLevel() : 1;
    // The viewport of a camera is a fraction of the render target.
    const width = engine.getRenderWidth() * camera.viewport.width * scale;
    const height = engine.getRenderHeight() * camera.viewport.height * scale;
    if (!(width > 0 && height > 0)) return null;
    return {
      viewMatrix: Array.from(camera.getViewMatrix().m),
      projectionMatrix: Array.from(camera.getProjectionMatrix().m),
      viewport: { width, height },
      id,
    };
  }
}
