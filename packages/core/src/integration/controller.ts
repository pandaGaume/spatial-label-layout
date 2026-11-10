import type { AnchorProvider } from "../anchors/anchor-provider.js";
import { resolveView } from "../projection/view.js";
import { DampedInterpolator, type PlacementInterpolator } from "../temporal/interpolator.js";
import { FixedRateScheduler, type SolveScheduler } from "../temporal/scheduler.js";
import { SpatialLabelLayoutEngine, type EngineOptions } from "../solver/engine.js";
import type { LabelAnchor, LayoutResult, SpatialLabel } from "../types.js";
import type { CameraProvider, LabelRenderer, LeaderRenderer } from "./ports.js";

export interface LabelLayoutControllerOptions {
  camera: CameraProvider;
  /** Existing engine, or options to build one. */
  engine?: SpatialLabelLayoutEngine | EngineOptions;
  /** Resolves registered anchor definitions every frame (mesh-local / barycentric anchors). */
  anchors?: AnchorProvider;
  labelRenderer?: LabelRenderer;
  leaderRenderer?: LeaderRenderer;
  /** Solver cadence (default 10 Hz, decoupled from rendering). */
  scheduler?: SolveScheduler;
  /** Render-rate smoothing (default: damped, 80 ms half-life). */
  interpolator?: PlacementInterpolator;
  onSolve?: (result: LayoutResult) => void;
}

/**
 * Renderer-agnostic lifecycle orchestration (brief: BabylonLabelLayoutController).
 * A 3D-library adapter only has to call `tick(deltaSeconds)` from its render
 * loop and implement the ports. Per frame:
 *   anchors -> (scheduled) solve -> interpolation -> billboard + leader updates.
 * Leader geometry is refreshed every frame from the live anchor positions; the
 * (anchorId, labelId) topology never changes.
 */
export class LabelLayoutController {
  readonly engine: SpatialLabelLayoutEngine;
  private readonly camera: CameraProvider;
  private readonly anchors: AnchorProvider | undefined;
  private readonly labelRenderer: LabelRenderer | undefined;
  private readonly leaderRenderer: LeaderRenderer | undefined;
  private readonly scheduler: SolveScheduler;
  private readonly interpolator: PlacementInterpolator;
  private readonly onSolve: ((r: LayoutResult) => void) | undefined;
  private readonly visibility = new Map<string, boolean>();
  private frameVersion: number | undefined;
  private lastResult: LayoutResult | null = null;
  private disposed = false;

  constructor(options: LabelLayoutControllerOptions) {
    this.engine = options.engine instanceof SpatialLabelLayoutEngine ? options.engine : new SpatialLabelLayoutEngine(options.engine);
    this.camera = options.camera;
    this.anchors = options.anchors;
    this.labelRenderer = options.labelRenderer;
    this.leaderRenderer = options.leaderRenderer;
    this.scheduler = options.scheduler ?? new FixedRateScheduler(10);
    this.interpolator = options.interpolator ?? new DampedInterpolator();
    this.onSolve = options.onSolve;
    this.frameVersion = this.camera.referenceFrameVersion;
  }

  get result(): LayoutResult | null {
    return this.lastResult;
  }

  addAnchor(anchor: LabelAnchor): void {
    this.engine.addAnchor(anchor);
  }

  removeAnchor(id: string): void {
    this.engine.removeAnchor(id);
  }

  addLabel(label: SpatialLabel): void {
    this.engine.addLabel(label);
    this.visibility.set(label.id, false);
    this.labelRenderer?.createLabel(label);
    const leader = this.engine.getLeader(label.id);
    if (leader) this.leaderRenderer?.createLeader(leader);
  }

  removeLabel(id: string): void {
    const leader = this.engine.getLeader(id);
    this.engine.removeLabel(id);
    this.visibility.delete(id);
    this.interpolator.remove(id);
    this.labelRenderer?.removeLabel(id);
    if (leader) this.leaderRenderer?.removeLeader(leader.id);
  }

  updateLabel(id: string, patch: Partial<SpatialLabel>): void {
    this.engine.updateLabel(id, patch);
    if (patch.position) {
      this.interpolator.setTarget(id, patch.position);
      this.interpolator.snap(id);
    }
    const label = this.engine.getLabel(id);
    if (label) this.labelRenderer?.refreshLabel?.(label);
  }

  /** Call on XR session start/end, AR/VR switch, teleport... */
  notifyReferenceFrameChange(): void {
    this.engine.reset();
    this.scheduler.reset();
    this.interpolator.clear();
  }

  /** Advances one rendered frame. */
  tick(deltaTime: number): void {
    if (this.disposed) return;
    if (this.anchors) this.engine.updateAnchors(this.anchors);

    const version = this.camera.referenceFrameVersion;
    if (version !== this.frameVersion) {
      this.frameVersion = version;
      this.notifyReferenceFrameChange();
    }

    const views = this.camera.getViews();
    const reference = this.camera.getReferenceView?.();
    if (views.length === 0) return;

    if (this.scheduler.shouldSolve(deltaTime)) {
      const ctx = reference
        ? { views, deltaTime: this.scheduler.elapsedSinceSolve, referenceView: reference }
        : { views, deltaTime: this.scheduler.elapsedSinceSolve };
      const result = this.engine.solve(ctx);
      this.lastResult = result;
      for (const p of result.placements) {
        this.visibility.set(p.id, p.visible);
        if (p.visible) this.interpolator.setTarget(p.id, p.position);
      }
      this.onSolve?.(result);
    }
    this.interpolator.step(deltaTime);
    this.render(reference ?? (views[0] as NonNullable<typeof reference>));
  }

  private render(referenceView: NonNullable<ReturnType<NonNullable<CameraProvider["getReferenceView"]>>>): void {
    if (!this.labelRenderer && !this.leaderRenderer) return;
    const ref = resolveView(referenceView, -1);
    const orienter = this.engine.settings.orienter;
    const routers = this.engine.leaderRouters;
    for (const label of this.engine.getLabels()) {
      const visible = this.visibility.get(label.id) ?? false;
      const position = this.interpolator.get(label.id) ?? label.position;
      const frame = orienter.frame(position, ref);
      this.labelRenderer?.updateLabel(
        label.id,
        { position, right: frame.right, up: frame.up, normal: frame.normal, width: label.dimensions.width, height: label.dimensions.height },
        visible,
      );
      const leader = this.engine.getLeader(label.id);
      const anchor = this.engine.getAnchorPosition(label.anchorId);
      if (leader && this.leaderRenderer) {
        const points = anchor ? routers.route({ leader, anchor, labelCenter: position, frame, size: label.dimensions }) : [];
        this.leaderRenderer.updateLeader(leader.id, points, visible && anchor !== null);
      }
    }
    this.labelRenderer?.endFrame?.();
    this.leaderRenderer?.endFrame?.();
  }

  dispose(): void {
    if (this.disposed) return;
    for (const label of this.engine.getLabels()) {
      this.labelRenderer?.removeLabel(label.id);
      const leader = this.engine.getLeader(label.id);
      if (leader) this.leaderRenderer?.removeLeader(leader.id);
    }
    this.labelRenderer?.dispose?.();
    this.leaderRenderer?.dispose?.();
    this.engine.dispose();
    this.interpolator.clear();
    this.disposed = true;
  }
}
