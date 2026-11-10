import { distance, lerp, sub } from "../geometry/vec3.js";
import type { ResolvedView } from "../projection/view.js";
import type { Vec3 } from "../types.js";

export type OcclusionStrategy = "none" | "raycast" | "depth" | "hybrid" | "custom";

/**
 * Brief section 6. `viewIndex` indexes `LayoutContext.views`.
 * Optional members are extension points for 3D library ports:
 * - `beginQueries`: receive camera positions, read back a depth buffer, build a BVH...
 * - `endQueries`: release per-solve resources.
 */
export interface OcclusionProvider {
  isOccluded(worldPosition: Vec3, viewIndex: number): boolean;
  readonly strategy?: OcclusionStrategy;
  beginQueries?(views: readonly ResolvedView[]): void;
  endQueries?(): void;
}

export class NoOcclusionProvider implements OcclusionProvider {
  readonly strategy = "none";
  isOccluded(): boolean {
    return false;
  }
}

/** Wraps a plain function; handy for tests and quick adapters. */
export class FunctionOcclusionProvider implements OcclusionProvider {
  readonly strategy = "custom";
  constructor(private readonly fn: (p: Vec3, viewIndex: number) => boolean) {}
  isOccluded(p: Vec3, viewIndex: number): boolean {
    return this.fn(p, viewIndex);
  }
}

/**
 * "hybrid" strategy: asks the primary provider (e.g. GPU depth) and falls back
 * to the secondary (e.g. raycast) when the primary is unavailable for a view.
 */
export class HybridOcclusionProvider implements OcclusionProvider {
  readonly strategy = "hybrid";
  constructor(
    private readonly primary: OcclusionProvider & { isAvailable?(viewIndex: number): boolean },
    private readonly fallback: OcclusionProvider,
  ) {}
  beginQueries(views: readonly ResolvedView[]): void {
    this.primary.beginQueries?.(views);
    this.fallback.beginQueries?.(views);
  }
  endQueries(): void {
    this.primary.endQueries?.();
    this.fallback.endQueries?.();
  }
  isOccluded(p: Vec3, viewIndex: number): boolean {
    const usePrimary = this.primary.isAvailable?.(viewIndex) ?? true;
    return usePrimary ? this.primary.isOccluded(p, viewIndex) : this.fallback.isOccluded(p, viewIndex);
  }
}

/** Memoizes queries during one solve (positions quantized to `resolution` world units). */
export class CachedOcclusionProvider implements OcclusionProvider {
  private cache = new Map<string, boolean>();
  constructor(
    private readonly inner: OcclusionProvider,
    private readonly resolution = 1e-3,
  ) {}
  get strategy(): OcclusionStrategy {
    return this.inner.strategy ?? "custom";
  }
  beginQueries(views: readonly ResolvedView[]): void {
    this.cache.clear();
    this.inner.beginQueries?.(views);
  }
  endQueries(): void {
    this.inner.endQueries?.();
  }
  isOccluded(p: Vec3, viewIndex: number): boolean {
    const q = (v: number): number => Math.round(v / this.resolution);
    const k = `${viewIndex}:${q(p.x)}:${q(p.y)}:${q(p.z)}`;
    let r = this.cache.get(k);
    if (r === undefined) this.cache.set(k, (r = this.inner.isOccluded(p, viewIndex)));
    return r;
  }
}

export interface RaymarchOptions {
  /** World-space step between samples (default 0.25). */
  step?: number;
  /** Ignore the last `endMargin` world units before the target (avoids self-occlusion on surfaces). */
  endMargin?: number;
  maxSteps?: number;
}

/**
 * Engine-agnostic "raycast" strategy against an implicit solid (`isInsideSolid`),
 * e.g. a terrain heightfield: `p => p.y < height(p.x, p.z)`.
 * Real adapters would rather use the engine's picking / physics raycasts.
 */
export class RaymarchOcclusionProvider implements OcclusionProvider {
  readonly strategy = "raycast";
  private eyes: Vec3[] = [];
  private readonly step: number;
  private readonly endMargin: number;
  private readonly maxSteps: number;

  constructor(
    private readonly isInsideSolid: (p: Vec3) => boolean,
    options: RaymarchOptions = {},
  ) {
    this.step = options.step ?? 0.25;
    this.endMargin = options.endMargin ?? 0.05;
    this.maxSteps = options.maxSteps ?? 2048;
  }

  beginQueries(views: readonly ResolvedView[]): void {
    this.eyes = [];
    for (const v of views) this.eyes[v.index] = v.position;
  }

  isOccluded(p: Vec3, viewIndex: number): boolean {
    const eye = this.eyes[viewIndex];
    if (!eye) return false;
    const len = distance(eye, p) - this.endMargin;
    if (len <= 0) return false;
    const n = Math.min(this.maxSteps, Math.ceil(len / this.step));
    const total = distance(eye, p);
    for (let i = 1; i <= n; i++) {
      const t = Math.min(len, i * this.step) / total;
      if (this.isInsideSolid(lerp(eye, p, t))) return true;
    }
    return false;
  }
}

/** Exported for adapters that build their own ray from a view. */
export const rayFromView = (view: ResolvedView, target: Vec3): { origin: Vec3; direction: Vec3; length: number } => {
  const d = sub(target, view.position);
  const length = Math.hypot(d.x, d.y, d.z);
  return { origin: view.position, direction: length > 0 ? { x: d.x / length, y: d.y / length, z: d.z / length } : view.forward, length };
};
