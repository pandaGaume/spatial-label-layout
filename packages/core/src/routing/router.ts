import { addScaled, clone, dot, sub } from "../geometry/vec3.js";
import type { BillboardFrame } from "../billboard/orienter.js";
import type { LabelDimensions, LabelLeader, LeaderRouting, Vec3 } from "../types.js";

export interface LeaderRouteInput {
  leader: LabelLeader;
  anchor: Vec3;
  labelCenter: Vec3;
  frame: BillboardFrame;
  size: LabelDimensions;
}

/**
 * Computes leader geometry (brief section 9: straight MVP, elbow and polyline
 * as extensions). Output is a world-space polyline: first point is the anchor,
 * last point is the attachment on the label. Routers never change topology:
 * they only produce geometry for an existing (anchorId, labelId) pair.
 */
export interface LeaderRouter {
  readonly kind: LeaderRouting | (string & {});
  route(input: LeaderRouteInput): Vec3[];
}

export type AttachMode = "center" | "border";

/** Point where the segment center -> anchor leaves the label rectangle (in the billboard plane). */
export const borderAttachPoint = (input: Pick<LeaderRouteInput, "anchor" | "labelCenter" | "frame" | "size">): Vec3 => {
  const { anchor, labelCenter: c, frame, size } = input;
  const d = sub(anchor, c);
  const u = dot(d, frame.right);
  const v = dot(d, frame.up);
  const hw = size.width / 2;
  const hh = size.height / 2;
  if (Math.abs(u) <= hw && Math.abs(v) <= hh) {
    // Anchor projects inside the label footprint: attach to the bottom edge midpoint.
    return addScaled(c, frame.up, -hh);
  }
  const s = Math.min(Math.abs(u) > 1e-12 ? hw / Math.abs(u) : Infinity, Math.abs(v) > 1e-12 ? hh / Math.abs(v) : Infinity);
  return addScaled(addScaled(c, frame.right, u * s), frame.up, v * s);
};

export class StraightRouter implements LeaderRouter {
  readonly kind = "straight";
  constructor(private readonly attach: AttachMode = "border") {}
  route(input: LeaderRouteInput): Vec3[] {
    const end = this.attach === "center" ? clone(input.labelCenter) : borderAttachPoint(input);
    return [clone(input.anchor), end];
  }
}

export interface ElbowRouterOptions {
  /** Length of the horizontal stub, as a fraction of the label width (default 0.25). */
  stubFraction?: number;
  /**
   * - "orthogonal" (default, brief section 9): the leader leaves the pin along the label's
   *   horizontal, turns along its vertical, and enters the label through a horizontal stub.
   * - "diagonal": a straight run from the pin to the stub.
   */
  shape?: "orthogonal" | "diagonal";
}

/**
 * Pin -> elbow -> midpoint of the label's left or right edge (whichever faces the pin).
 * A pin standing above or below the label gets a straight leader to its border.
 */
export class ElbowRouter implements LeaderRouter {
  readonly kind = "elbow";
  private readonly stubFraction: number;
  private readonly orthogonal: boolean;
  constructor(options: ElbowRouterOptions = {}) {
    this.stubFraction = options.stubFraction ?? 0.25;
    this.orthogonal = (options.shape ?? "orthogonal") === "orthogonal";
  }
  route(input: LeaderRouteInput): Vec3[] {
    const { anchor, labelCenter: c, frame, size } = input;
    const d = sub(anchor, c);
    const u = dot(d, frame.right);
    const side = u >= 0 ? 1 : -1;
    const attach = addScaled(c, frame.right, (side * size.width) / 2);
    const gap = Math.abs(u) - size.width / 2;
    if (gap <= 0) return [clone(anchor), borderAttachPoint(input)];
    if (!this.orthogonal) return [clone(anchor), addScaled(attach, frame.right, side * size.width * this.stubFraction), attach];
    // The turn stands between the pin and the label, at most one stub away from the label.
    const elbow = addScaled(attach, frame.right, side * Math.min(size.width * this.stubFraction, gap / 2));
    const v = dot(d, frame.up);
    // A pin level with the middle of the label needs no turn.
    if (Math.abs(v) < 1e-9 * Math.max(1, size.height)) return [clone(anchor), attach];
    // The corner lies in the plane of the label, level with the pin: the run from it to the stub is vertical.
    return [clone(anchor), addScaled(elbow, frame.up, v), elbow, attach];
  }
}

/**
 * Polyline routing through caller-provided via points (e.g. computed by an
 * obstacle-aware path finder in an adapter). Falls back to straight routing.
 */
export class PolylineRouter implements LeaderRouter {
  readonly kind = "polyline";
  constructor(private readonly viaPoints: (input: LeaderRouteInput) => readonly Vec3[] = () => []) {}
  route(input: LeaderRouteInput): Vec3[] {
    return [clone(input.anchor), ...this.viaPoints(input).map(clone), borderAttachPoint(input)];
  }
}

/** Router lookup by routing kind; adapters may register custom kinds. */
export class LeaderRouterRegistry {
  private readonly routers = new Map<string, LeaderRouter>();

  constructor(routers: readonly LeaderRouter[] = [new StraightRouter(), new ElbowRouter(), new PolylineRouter()]) {
    for (const r of routers) this.register(r);
  }

  register(router: LeaderRouter): this {
    this.routers.set(router.kind, router);
    return this;
  }

  get(kind: string): LeaderRouter {
    return this.routers.get(kind) ?? this.routers.get("straight") ?? new StraightRouter();
  }

  route(input: LeaderRouteInput): Vec3[] {
    return this.get(input.leader.routing).route(input);
  }
}
