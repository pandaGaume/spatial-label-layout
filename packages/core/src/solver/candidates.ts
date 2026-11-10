import { addScaled } from "../geometry/vec3.js";
import { pixelDeltaToAxes, pixelJacobian, type ResolvedView } from "../projection/view.js";
import type { BillboardFrame } from "../billboard/orienter.js";
import type { LabelDimensions, SpatialLabel, Vec3 } from "../types.js";

export interface CandidateInput {
  label: Readonly<SpatialLabel>;
  anchor: Vec3;
  view: ResolvedView;
  frame: BillboardFrame;
  size: LabelDimensions;
  /** Preferred gap between anchor and label edge, in pixels. */
  leaderLengthPx: number;
}

/**
 * Discrete initial placement proposals (brief 4.2). Returned in order of
 * preference; the engine scores them (overlap, viewport, occlusion) and keeps the best.
 */
export interface CandidateGenerator {
  generate(input: CandidateInput): Vec3[];
}

export interface RadialCandidateOptions {
  /** Number of directions around the pin (default 8). */
  directions?: number;
  /** Concentric rings; ring k uses (k + 1) x leaderLengthPx (default 2). */
  rings?: number;
  /** Angle of the first direction, radians, screen convention (default: upper-right, PI/4). */
  startAngle?: number;
}

/** N directions in the camera frame around the anchor, at increasing radius. */
export class RadialCandidateGenerator implements CandidateGenerator {
  private readonly directions: number;
  private readonly rings: number;
  private readonly startAngle: number;

  constructor(options: RadialCandidateOptions = {}) {
    this.directions = Math.max(1, options.directions ?? 8);
    this.rings = Math.max(1, options.rings ?? 2);
    this.startAngle = options.startAngle ?? Math.PI / 4;
  }

  generate(input: CandidateInput): Vec3[] {
    const { anchor, view, frame, size, leaderLengthPx } = input;
    const j = pixelJacobian(view, anchor, frame.right, frame.up);
    if (!j) return [addScaled(anchor, frame.up, size.height)];
    // Half label extents in pixels.
    const hwPx = Math.hypot(j.a, j.c) * (size.width / 2);
    const hhPx = Math.hypot(j.b, j.d) * (size.height / 2);
    const out: Vec3[] = [];
    for (let ring = 0; ring < this.rings; ring++) {
      const radius = leaderLengthPx * (ring + 1);
      for (let k = 0; k < this.directions; k++) {
        const a = this.startAngle + (k * 2 * Math.PI) / this.directions;
        const dx = Math.cos(a);
        const dy = -Math.sin(a); // screen y grows downward; positive angle = up
        const px = { x: dx * (radius + hwPx), y: dy * (radius + hhPx) };
        const axes = pixelDeltaToAxes(j, px);
        if (!axes) continue;
        out.push(addScaled(addScaled(anchor, frame.right, axes.x), frame.up, axes.y));
      }
    }
    return out;
  }
}
