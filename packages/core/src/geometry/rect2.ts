import type { Vec2 } from "../types.js";

/** Axis-aligned rectangle in pixel space (y grows downward). */
export interface Rect2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const rectWidth = (r: Rect2): number => r.maxX - r.minX;
export const rectHeight = (r: Rect2): number => r.maxY - r.minY;
export const rectCenter = (r: Rect2): Vec2 => ({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });

export const inflate = (r: Rect2, d: number): Rect2 => ({
  minX: r.minX - d,
  minY: r.minY - d,
  maxX: r.maxX + d,
  maxY: r.maxY + d,
});

export const rectsOverlap = (a: Rect2, b: Rect2): boolean =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

/** Overlap area (0 when disjoint). */
export const overlapArea = (a: Rect2, b: Rect2): number => {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * Minimal translation vector to apply to `a` so it no longer overlaps `b`
 * (separating along the axis of least penetration). Null when disjoint.
 */
export const minimumTranslation = (a: Rect2, b: Rect2): Vec2 | null => {
  const px = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const py = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  if (px <= 0 || py <= 0) return null;
  const ca = rectCenter(a);
  const cb = rectCenter(b);
  if (px < py) {
    const dir = ca.x < cb.x ? -1 : ca.x > cb.x ? 1 : tieBreak(ca, cb);
    return { x: dir * px, y: 0 };
  }
  const dir = ca.y < cb.y ? -1 : ca.y > cb.y ? 1 : tieBreak(ca, cb);
  return { x: 0, y: dir * py };
};

/** Deterministic tie break for perfectly superimposed rectangles. */
const tieBreak = (a: Vec2, b: Vec2): number => (a.x + a.y * 0.618 <= b.x + b.y * 0.618 ? -1 : 1);

/** Translation that brings `r` inside `bounds` (zero when it already fits; centered when it is larger). */
export const containmentTranslation = (r: Rect2, bounds: Rect2): Vec2 => {
  const shift = (min: number, max: number, bmin: number, bmax: number): number => {
    if (max - min > bmax - bmin) return (bmin + bmax) / 2 - (min + max) / 2;
    if (min < bmin) return bmin - min;
    if (max > bmax) return bmax - max;
    return 0;
  };
  return { x: shift(r.minX, r.maxX, bounds.minX, bounds.maxX), y: shift(r.minY, r.maxY, bounds.minY, bounds.maxY) };
};

export const rectInside = (r: Rect2, bounds: Rect2, tolerance = 0): boolean =>
  r.minX >= bounds.minX - tolerance &&
  r.minY >= bounds.minY - tolerance &&
  r.maxX <= bounds.maxX + tolerance &&
  r.maxY <= bounds.maxY + tolerance;

/** Closest point of the rectangle boundary/interior to `p`. */
export const closestPointOnRect = (r: Rect2, p: Vec2): Vec2 => ({
  x: Math.min(r.maxX, Math.max(r.minX, p.x)),
  y: Math.min(r.maxY, Math.max(r.minY, p.y)),
});

export const rectFromPoints = (points: readonly Vec2[]): Rect2 => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
};
