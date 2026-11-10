import { viewDelta, type ResolvedView } from "../projection/view.js";

export interface TemporalConfig {
  /** Disable to solve on every call. */
  enabled: boolean;
  /** Re-solve when the reference view rotated more than this since the last solve (radians). */
  angularThreshold: number;
  /** Re-solve when the reference view moved more than this since the last solve (world units). */
  translationThreshold: number;
  /** Anchor displacement (world units) that marks the layout dirty. */
  anchorMoveThreshold: number;
  /** Above this angular speed (rad/s) the layout is frozen ("fast camera" policy). */
  fastAngularSpeed: number;
  /** Maximum time (s) the layout can stay frozen during fast camera motion. */
  maxDeferSeconds: number;
  /**
   * Hysteresis on discrete reorganizations (crossing swaps, collision repairs,
   * occlusion relocations) of already placed labels: the defect must be seen
   * in this many consecutive solves before a label jumps.
   */
  reorganizeAfterSolves: number;
  /** Minimum time (s) between two discrete jumps of the same label. */
  reorganizeCooldown: number;
}

export const defaultTemporalConfig = (): TemporalConfig => ({
  enabled: true,
  angularThreshold: (1.5 * Math.PI) / 180,
  translationThreshold: 0.05,
  anchorMoveThreshold: 1e-3,
  fastAngularSpeed: (120 * Math.PI) / 180,
  maxDeferSeconds: 0.5,
  reorganizeAfterSolves: 3,
  reorganizeCooldown: 2,
});

export type TemporalReason =
  | "dirty"
  | "first-solve"
  | "camera-moved"
  | "fast-camera"
  | "below-threshold"
  | "disabled"
  | "forced"
  | "defer-timeout"
  /** Nothing moved, but a defect is waiting for its hysteresis to elapse. */
  | "pending-reorganization";

export interface TemporalDecision {
  solve: boolean;
  reason: TemporalReason;
}

/**
 * Hysteresis gate in front of the solver (brief section 7): small head
 * motions keep the current layout; fast rotations freeze it briefly.
 */
export class TemporalStabilizer {
  private lastSolved: ResolvedView | null = null;
  private lastFrame: ResolvedView | null = null;
  private deferred = 0;

  constructor(private config: TemporalConfig) {}

  configure(config: TemporalConfig): void {
    this.config = config;
  }

  decide(ref: ResolvedView, deltaTime: number, dirty: boolean, force: boolean, pendingReorganization = false): TemporalDecision {
    const previousFrame = this.lastFrame;
    this.lastFrame = ref;
    if (force) return { solve: true, reason: "forced" };
    if (!this.config.enabled) return { solve: true, reason: "disabled" };
    if (!this.lastSolved) return { solve: true, reason: "first-solve" };

    if (previousFrame && deltaTime > 0) {
      const speed = viewDelta(previousFrame, ref).angle / deltaTime;
      if (speed > this.config.fastAngularSpeed) {
        this.deferred += deltaTime;
        if (this.deferred <= this.config.maxDeferSeconds) return { solve: false, reason: "fast-camera" };
        return { solve: true, reason: "defer-timeout" };
      }
    }
    if (dirty) return { solve: true, reason: "dirty" };
    const d = viewDelta(this.lastSolved, ref);
    if (d.angle > this.config.angularThreshold || d.translation > this.config.translationThreshold) {
      return { solve: true, reason: "camera-moved" };
    }
    if (pendingReorganization) return { solve: true, reason: "pending-reorganization" };
    return { solve: false, reason: "below-threshold" };
  }

  markSolved(ref: ResolvedView): void {
    this.lastSolved = ref;
    this.deferred = 0;
  }

  reset(): void {
    this.lastSolved = null;
    this.lastFrame = null;
    this.deferred = 0;
  }
}
