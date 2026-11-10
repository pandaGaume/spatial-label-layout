import { clone, distance, lerp } from "../geometry/vec3.js";
import { placeAtScreenOffset, screenOffset } from "../projection/screen.js";
import type { ResolvedView } from "../projection/view.js";
import type { Vec2, Vec3 } from "../types.js";

/** What an interpolator may need to know about the frame being drawn. */
export interface InterpolationFrame {
  /** Reference view of the frame. */
  view: ResolvedView;
  /** Live world position of the pin of a label, or null when it is unknown. */
  anchorOf(labelId: string): Vec3 | null;
  /** True for labels with "screen" sizing. */
  screenLocked(labelId: string): boolean;
}

/**
 * Render-rate smoothing of solved positions (brief section 7: damped
 * interpolation of world positions). Solver output is a target; the renderer
 * reads `get()` every frame.
 */
export interface PlacementInterpolator {
  /** Optional: called by the controller once per rendered frame, before any other call of that frame. */
  beginFrame?(frame: InterpolationFrame): void;
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
    this.target.set(id, clone(t));
    const c = this.current.get(id);
    if (!c || distance(c, t) > this.snapDistance) this.current.set(id, clone(t));
  }

  step(deltaTime: number): void {
    const alpha = 1 - Math.pow(2, -Math.max(0, deltaTime) / this.halfLife);
    for (const [id, t] of this.target) {
      const c = this.current.get(id);
      this.current.set(id, c ? lerp(c, t, alpha) : clone(t));
    }
  }

  get(id: string): Vec3 | undefined {
    const c = this.current.get(id);
    return c ? clone(c) : undefined;
  }

  snap(id?: string): void {
    if (id !== undefined) {
      const t = this.target.get(id);
      if (t) this.current.set(id, clone(t));
      return;
    }
    for (const [k, t] of this.target) this.current.set(k, clone(t));
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

/**
 * Default interpolator of the controller.
 *
 * World-sized labels are damped in world space, as `DampedInterpolator` does.
 * "screen" sized labels are held as a pixel offset from their pin instead:
 * between two solves they follow the camera rigidly, where a world position
 * would drift away from the pin (camera moving in) or fall on it (camera
 * moving out), and solver corrections slide in pixels.
 */
export class ScreenLockedInterpolator implements PlacementInterpolator {
  private readonly world: DampedInterpolator;
  private readonly held = new Map<string, { current: Vec2; target: Vec2 }>();
  private readonly halfLife: number;
  private frame: InterpolationFrame | null = null;

  constructor(options: DampedInterpolatorOptions = {}) {
    this.world = new DampedInterpolator(options);
    this.halfLife = Math.max(1e-4, options.halfLife ?? 0.08);
  }

  beginFrame(frame: InterpolationFrame): void {
    this.frame = frame;
  }

  setTarget(id: string, t: Vec3): void {
    const frame = this.frame;
    if (!frame?.screenLocked(id)) {
      this.held.delete(id);
      this.world.setTarget(id, t);
      return;
    }
    this.world.remove(id);
    const anchor = frame.anchorOf(id);
    const offset = anchor && screenOffset(frame.view, anchor, t);
    // Pin unknown or behind the camera: the offset known so far stays.
    if (!offset) return;
    const label = this.held.get(id);
    if (label) label.target = offset;
    else this.held.set(id, { current: { ...offset }, target: offset });
  }

  step(deltaTime: number): void {
    this.world.step(deltaTime);
    const alpha = 1 - Math.pow(2, -Math.max(0, deltaTime) / this.halfLife);
    for (const label of this.held.values()) {
      label.current = {
        x: label.current.x + (label.target.x - label.current.x) * alpha,
        y: label.current.y + (label.target.y - label.current.y) * alpha,
      };
    }
  }

  get(id: string): Vec3 | undefined {
    const label = this.held.get(id);
    if (!label) return this.world.get(id);
    const anchor = this.frame?.anchorOf(id);
    return (anchor && this.frame && placeAtScreenOffset(this.frame.view, anchor, label.current)) || undefined;
  }

  snap(id?: string): void {
    this.world.snap(id);
    for (const [key, label] of this.held) if (id === undefined || key === id) label.current = { ...label.target };
  }

  remove(id: string): void {
    this.world.remove(id);
    this.held.delete(id);
  }

  clear(): void {
    this.world.clear();
    this.held.clear();
  }
}
