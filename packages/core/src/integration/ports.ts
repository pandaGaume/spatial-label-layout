import type { CameraView, LabelLeader, SpatialLabel, Vec3 } from "../types.js";

/**
 * Ports implemented by rendering adapters (Babylon.js, three.js, raw WebXR...).
 *
 * The full adapter surface is:
 *   - MeshResolver (or AnchorProvider)  -> anchors/anchor-provider.ts
 *   - CameraProvider                    -> below
 *   - LabelRenderer, LeaderRenderer     -> below
 *   - OcclusionProvider (optional)      -> visibility/occlusion.ts
 * and a few lines hooking `LabelLayoutController.tick()` into the render loop.
 *
 * Optional members are the planned extension points; adding new optional
 * members never breaks existing adapters.
 */

/** Supplies camera views every frame (brief: BabylonCameraProvider "mono matrix / WebXR views"). */
export interface CameraProvider {
  /** One view for a mono camera, one per eye in XR. */
  getViews(): CameraView[];
  /** Central pose used to propose placements; defaults to `getViews()[0]`. */
  getReferenceView?(): CameraView | undefined;
  /**
   * Incremented by the adapter on large reference-space changes (XR session
   * start/end, AR/VR switch, teleport). The controller resets the layout when it changes.
   */
  readonly referenceFrameVersion?: number;
}

/** World transform of a billboard, as produced by the solver + orienter. */
export interface BillboardTransform {
  position: Vec3;
  /** Unit vectors of the label plane; `normal` faces the viewer. */
  right: Vec3;
  up: Vec3;
  normal: Vec3;
  /** World size (already includes the billboard scale factor). */
  width: number;
  height: number;
}

/** Brief: BabylonBillboardAdapter. Owns the native label meshes. */
export interface LabelRenderer {
  createLabel(label: Readonly<SpatialLabel>): void;
  updateLabel(id: string, transform: BillboardTransform, visible: boolean): void;
  removeLabel(id: string): void;
  /** Optional: label payload changed (text, style...), dimensions included. */
  refreshLabel?(label: Readonly<SpatialLabel>): void;
  /** Optional: called once per frame after all updates (batching, instance buffers...). */
  endFrame?(): void;
  dispose?(): void;
}

/** Brief: BabylonLeaderRenderer. Polyline in world space, anchor first. */
export interface LeaderRenderer {
  createLeader(leader: Readonly<LabelLeader>): void;
  updateLeader(id: string, points: readonly Vec3[], visible: boolean): void;
  removeLeader(id: string): void;
  endFrame?(): void;
  dispose?(): void;
}

/** Fixed views; useful for tests, offline rendering and server-side layout. */
export class StaticCameraProvider implements CameraProvider {
  referenceFrameVersion = 0;
  constructor(
    private views: CameraView[],
    private reference?: CameraView,
  ) {}
  set(views: CameraView[], reference?: CameraView): void {
    this.views = views;
    this.reference = reference;
  }
  bumpReferenceFrame(): void {
    this.referenceFrameVersion++;
  }
  getViews(): CameraView[] {
    return this.views;
  }
  getReferenceView(): CameraView | undefined {
    return this.reference;
  }
}
