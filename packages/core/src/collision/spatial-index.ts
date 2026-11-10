import { rectsOverlap, type Rect2 } from "../geometry/rect2.js";

/**
 * Broad-phase index over screen-space rectangles.
 * Brief section 4: uniform grid first; quadtree / BVH / GPU binning can be
 * dropped in later by implementing this interface.
 */
export interface SpatialIndex2D {
  clear(): void;
  insert(id: number, rect: Rect2): void;
  /** Calls `cb(a, b)` once per overlapping pair, with a < b. */
  forEachOverlappingPair(cb: (a: number, b: number) => void): void;
  /** Calls `cb(id)` once per stored rectangle overlapping `rect`. */
  query(rect: Rect2, cb: (id: number) => void): void;
}

export type SpatialIndexFactory = () => SpatialIndex2D;

const KEY_RANGE = 32000;

/** Brute force O(n^2) index; reference implementation for tests. */
export class BruteForceIndex implements SpatialIndex2D {
  private ids: number[] = [];
  private rects: Rect2[] = [];

  clear(): void {
    this.ids = [];
    this.rects = [];
  }

  insert(id: number, rect: Rect2): void {
    this.ids.push(id);
    this.rects.push(rect);
  }

  forEachOverlappingPair(cb: (a: number, b: number) => void): void {
    for (let i = 0; i < this.rects.length; i++) {
      for (let j = i + 1; j < this.rects.length; j++) {
        if (rectsOverlap(this.rects[i] as Rect2, this.rects[j] as Rect2)) {
          const a = this.ids[i] as number;
          const b = this.ids[j] as number;
          cb(Math.min(a, b), Math.max(a, b));
        }
      }
    }
  }

  query(rect: Rect2, cb: (id: number) => void): void {
    for (let i = 0; i < this.rects.length; i++) if (rectsOverlap(rect, this.rects[i] as Rect2)) cb(this.ids[i] as number);
  }
}

export interface UniformGridOptions {
  /** Cell size in pixels. When omitted it is derived from the median rectangle size at the first pair query. */
  cellSize?: number;
  /** Rectangles covering more cells than this go into an overflow list (avoids pathological inserts). */
  maxCellsPerRect?: number;
}

/**
 * Uniform hash grid. Each overlapping pair is reported exactly once: only the
 * cell containing the top-left corner of the intersection reports it, so no
 * pair-deduplication set is needed.
 */
export class UniformGridIndex implements SpatialIndex2D {
  private readonly fixedCellSize: number | undefined;
  private readonly maxCellsPerRect: number;
  private ids: number[] = [];
  private rects: Rect2[] = [];
  private cellSize = 64;
  private cells = new Map<number, number[]>();
  private overflow: number[] = [];
  private built = false;

  constructor(options: UniformGridOptions = {}) {
    this.fixedCellSize = options.cellSize;
    this.maxCellsPerRect = options.maxCellsPerRect ?? 64;
  }

  clear(): void {
    this.ids = [];
    this.rects = [];
    this.cells.clear();
    this.overflow = [];
    this.built = false;
  }

  /** After the first query the grid is incremental: inserts go straight into cells, keeping the cell size. */
  insert(id: number, rect: Rect2): void {
    this.ids.push(id);
    this.rects.push(rect);
    if (this.built) this.place(this.rects.length - 1);
  }

  /** Injective for |cx|, |cy| <= KEY_RANGE; rectangles outside that range go to the overflow list. */
  private key(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  private build(): void {
    this.cells.clear();
    this.overflow = [];
    this.cellSize = this.fixedCellSize ?? this.autoCellSize();
    for (let i = 0; i < this.rects.length; i++) this.place(i);
    this.built = true;
  }

  private place(i: number): void {
    const s = this.cellSize;
    const r = this.rects[i] as Rect2;
    const x0 = Math.floor(r.minX / s), x1 = Math.floor(r.maxX / s);
    const y0 = Math.floor(r.minY / s), y1 = Math.floor(r.maxY / s);
    const outOfKeyRange = Math.min(x0, y0) < -KEY_RANGE || Math.max(x1, y1) > KEY_RANGE;
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.maxCellsPerRect || !Number.isFinite(x0 + x1 + y0 + y1) || outOfKeyRange) {
      this.overflow.push(i);
      return;
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        let cell = this.cells.get(k);
        if (!cell) this.cells.set(k, (cell = []));
        cell.push(i);
      }
    }
  }

  private autoCellSize(): number {
    // Mean of the larger rectangle side, O(n); oversized outliers are capped so they cannot blow the cell up.
    let sum = 0;
    let n = 0;
    for (const r of this.rects) {
      const s = Math.max(r.maxX - r.minX, r.maxY - r.minY);
      if (Number.isFinite(s) && s < 2048) {
        sum += s;
        n++;
      }
    }
    return n > 0 ? Math.max(8, sum / n) : 64;
  }

  forEachOverlappingPair(cb: (a: number, b: number) => void): void {
    if (!this.built) this.build();
    const s = this.cellSize;
    for (const [k, cell] of this.cells) {
      for (let m = 0; m < cell.length; m++) {
        const i = cell[m] as number;
        const ri = this.rects[i] as Rect2;
        for (let n = m + 1; n < cell.length; n++) {
          const j = cell[n] as number;
          const rj = this.rects[j] as Rect2;
          if (!rectsOverlap(ri, rj)) continue;
          const ox = Math.max(ri.minX, rj.minX);
          const oy = Math.max(ri.minY, rj.minY);
          if (this.key(Math.floor(ox / s), Math.floor(oy / s)) !== k) continue;
          this.emit(i, j, cb);
        }
      }
    }
    if (this.overflow.length > 0) {
      const isOverflow = new Set(this.overflow);
      for (const i of this.overflow) {
        const ri = this.rects[i] as Rect2;
        for (let j = 0; j < this.rects.length; j++) {
          if (j === i || (isOverflow.has(j) && j < i)) continue;
          if (rectsOverlap(ri, this.rects[j] as Rect2)) this.emit(i, j, cb);
        }
      }
    }
  }

  private emit(i: number, j: number, cb: (a: number, b: number) => void): void {
    const a = this.ids[i] as number;
    const b = this.ids[j] as number;
    cb(Math.min(a, b), Math.max(a, b));
  }

  query(rect: Rect2, cb: (id: number) => void): void {
    if (!this.built) this.build();
    const s = this.cellSize;
    const seen = new Set<number>();
    const x0 = Math.floor(rect.minX / s), x1 = Math.floor(rect.maxX / s);
    const y0 = Math.floor(rect.minY / s), y1 = Math.floor(rect.maxY / s);
    const visit = (i: number): void => {
      if (seen.has(i)) return;
      seen.add(i);
      if (rectsOverlap(rect, this.rects[i] as Rect2)) cb(this.ids[i] as number);
    };
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
      for (let i = 0; i < this.rects.length; i++) visit(i);
      return;
    }
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (const i of this.cells.get(this.key(cx, cy)) ?? []) visit(i);
    for (const i of this.overflow) visit(i);
  }
}
