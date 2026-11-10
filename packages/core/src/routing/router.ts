import { addScaled, dot, sub } from "../geometry/vec3.js";
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
    const end = this.attach === "center" ? { ...input.labelCenter } : borderAttachPoint(input);
    return [{ ...input.anchor }, end];
  }
}

export interface ElbowRouterOptions {
  /** Length of the horizontal stub, as a fraction of the label width (default 0.25). */
  stubFraction?: number;
}

/** Anchor -> elbow -> midpoint of the label's left or right edge (whichever faces the anchor). */
export class ElbowRouter implements LeaderRouter {
  readonly kind = "elbow";
  private readonly stubFraction: number;
  constructor(options: ElbowRouterOptions = {}) {
    this.stubFraction = options.stubFraction ?? 0.25;
  }
  route(input: LeaderRouteInput): Vec3[] {
    const { anchor, labelCenter: c, frame, size } = input;
    const u = dot(sub(anchor, c), frame.right);
    const side = u >= 0 ? 1 : -1;
    const attach = addScaled(c, frame.right, (side * size.width) / 2);
    if (Math.abs(u) <= size.width / 2) return [{ ...anchor }, borderAttachPoint(input)];
    const elbow = addScaled(attach, frame.right, side * size.width * this.stubFraction);
    return [{ ...anchor }, elbow, attach];
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
    return [{ ...input.anchor }, ...this.viaPoints(input).map((p) => ({ ...p })), borderAttachPoint(input)];
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
