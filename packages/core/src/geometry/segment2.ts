import type { Vec2 } from "../types.js";

export interface Segment2 {
  a: Vec2;
  b: Vec2;
}

const orient = (p: Vec2, q: Vec2, r: Vec2): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

/**
 * Proper intersection test between two segments. Segments that only touch at
 * an endpoint, or that are collinear, are not counted as crossing: leaders
 * sharing an anchor must not be reported as crossings.
 */
export const segmentsCross = (s: Segment2, t: Segment2, eps = 1e-9): boolean => {
  const d1 = orient(s.a, s.b, t.a);
  const d2 = orient(s.a, s.b, t.b);
  const d3 = orient(t.a, t.b, s.a);
  const d4 = orient(t.a, t.b, s.b);
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
};

export const segmentLength = (s: Segment2): number => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
