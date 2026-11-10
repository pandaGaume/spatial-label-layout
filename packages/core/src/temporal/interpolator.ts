import { distance, lerp } from "../geometry/vec3.js";
import type { Vec3 } from "../types.js";

/**
 * Render-rate smoothing of solved positions (brief section 7: damped
 * interpolation of world positions). Solver output is a target; the renderer
 * reads `get()` every frame.
 */
export interface PlacementInterpolator {
  setTarget(id: string, target: Vec3): void;
  step(deltaTime: number): void;
  get(id: string): Vec3 | undefined;
  /** Jump to the target immediately (all ids when omitted). */
  snap(id?: string): void;
  remove(id: string): void;
  clear(): void;
}

export interface DampedInterpolatorOptions {
  /** Time (s) to cover half the remaining distance (default 0.08). */
  halfLife?: number;
  /** Distances above this (world units) snap instead of sliding (default Infinity). */
  snapDistance?: number;
}

export class DampedInterpolator implements PlacementInterpolator {
  private readonly current = new Map<string, Vec3>();
  private readonly target = new Map<string, Vec3>();
  private readonly halfLife: number;
  private readonly snapDistance: number;

  constructor(options: DampedInterpolatorOptions = {}) {
    this.halfLife = Math.max(1e-4, options.halfLife ?? 0.08);
    this.snapDistance = options.snapDistance ?? Infinity;
  }

  setTarget(id: string, t: Vec3): void {
    this.target.set(id, { ...t });
    const c = this.current.get(id);
    if (!c || distance(c, t) > this.snapDistance) this.current.set(id, { ...t });
  }

  step(deltaTime: number): void {
    const alpha = 1 - Math.pow(2, -Math.max(0, deltaTime) / this.halfLife);
    for (const [id, t] of this.target) {
      const c = this.current.get(id);
      this.current.set(id, c ? lerp(c, t, alpha) : { ...t });
    }
  }

  get(id: string): Vec3 | undefined {
    const c = this.current.get(id);
    return c ? { ...c } : undefined;
  }

  snap(id?: string): void {
    if (id !== undefined) {
      const t = this.target.get(id);
      if (t) this.current.set(id, { ...t });
      return;
    }
    for (const [k, t] of this.target) this.current.set(k, { ...t });
  }

  remove(id: string): void {
    this.current.delete(id);
    this.target.delete(id);
  }

  clear(): void {
    this.current.clear();
    this.target.clear();
  }
}
