import { rectsOverlap, type Rect2 } from "../geometry/rect2.js";
import type { SpatialIndex2D } from "./spatial-index.js";

export interface QuadTreeOptions {
  /** Items per leaf before it splits (default 8). */
  capacity?: number;
  /** Maximum subdivision depth (default 10). */
  maxDepth?: number;
}

interface QNode {
  bounds: Rect2;
  depth: number;
  /** Items that fit no child entirely (straddlers) or items of a leaf. */
  items: number[];
  children: [QNode, QNode, QNode, QNode] | null;
}

/**
 * Region quadtree over screen-space rectangles. Adapts to clustering: dense
 * hotspots subdivide deeply while empty screen areas cost nothing, so pair
 * detection stays close to O(n log n + k) where a uniform grid degrades
 * toward O(n^2) inside crowded cells.
 *
 * A rectangle lives in the deepest node that fully contains it. Pairs are
 * found in one traversal: items of a node are tested against each other and
 * against the straddlers of their ancestors that overlap the node, so every
 * pair is reported exactly once.
 */
export class QuadTreeIndex implements SpatialIndex2D {
  private readonly capacity: number;
  private readonly maxDepth: number;
  private ids: number[] = [];
  private rects: Rect2[] = [];
  private root: QNode | null = null;

  constructor(options: QuadTreeOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 8);
    this.maxDepth = Math.max(0, options.maxDepth ?? 10);
  }

  clear(): void {
    this.ids = [];
    this.rects = [];
    this.root = null;
  }

  insert(id: number, rect: Rect2): void {
    this.ids.push(id);
    this.rects.push(rect);
    const k = this.rects.length - 1;
    // Incremental insert when the tree exists and the rectangle fits its bounds; otherwise rebuild lazily.
    if (this.root && contains(this.root.bounds, rect)) this.insertInto(this.root, k);
    else this.root = null;
  }

  forEachOverlappingPair(cb: (a: number, b: number) => void): void {
    const root = this.ensureBuilt();
    if (!root) return;
    const emit = (i: number, j: number): void => {
      const a = this.ids[i] as number;
      const b = this.ids[j] as number;
      cb(Math.min(a, b), Math.max(a, b));
    };
    const visit = (node: QNode, ancestors: number[]): void => {
      const items = node.items;
      for (let m = 0; m < items.length; m++) {
        const i = items[m] as number;
        const ri = this.rects[i] as Rect2;
        for (const j of ancestors) if (rectsOverlap(ri, this.rects[j] as Rect2)) emit(j, i);
        for (let n = m + 1; n < items.length; n++) {
          const j = items[n] as number;
          if (rectsOverlap(ri, this.rects[j] as Rect2)) emit(i, j);
        }
      }
      if (!node.children) return;
      const carried = ancestors.concat(items);
      for (const child of node.children) {
        // Only straddlers overlapping this child can meet its items.
        const relevant = carried.filter((j) => rectsOverlap(this.rects[j] as Rect2, child.bounds));
        if (relevant.length > 0 || child.items.length > 0 || child.children) visit(child, relevant);
      }
    };
    visit(root, []);
  }

  query(rect: Rect2, cb: (id: number) => void): void {
    const root = this.ensureBuilt();
    if (!root) return;
    const stack: QNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop() as QNode;
      for (const i of node.items) if (rectsOverlap(rect, this.rects[i] as Rect2)) cb(this.ids[i] as number);
      if (node.children) for (const c of node.children) if (overlapsOrTouches(rect, c.bounds)) stack.push(c);
    }
  }

  /** Depth of the deepest node; useful for diagnostics and tests. */
  get depth(): number {
    const root = this.ensureBuilt();
    let d = 0;
    const walk = (n: QNode): void => {
      d = Math.max(d, n.depth);
      if (n.children) for (const c of n.children) walk(c);
    };
    if (root) walk(root);
    return d;
  }

  private ensureBuilt(): QNode | null {
    if (this.root || this.rects.length === 0) return this.root;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of this.rects) {
      if (!isFiniteRect(r)) continue;
      if (r.minX < minX) minX = r.minX;
      if (r.minY < minY) minY = r.minY;
      if (r.maxX > maxX) maxX = r.maxX;
      if (r.maxY > maxY) maxY = r.maxY;
    }
    if (!Number.isFinite(minX)) return null;
    // Square, slightly padded root so incremental inserts near the border still fit.
    const size = Math.max(maxX - minX, maxY - minY, 1) * 1.05;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    this.root = { bounds: { minX: cx - size / 2, minY: cy - size / 2, maxX: cx + size / 2, maxY: cy + size / 2 }, depth: 0, items: [], children: null };
    for (let k = 0; k < this.rects.length; k++) if (isFiniteRect(this.rects[k] as Rect2)) this.insertInto(this.root, k);
    return this.root;
  }

  private insertInto(root: QNode, k: number): void {
    const rect = this.rects[k] as Rect2;
    let node = root;
    for (;;) {
      if (node.children) {
        const child = node.children.find((c) => contains(c.bounds, rect));
        if (child) {
          node = child;
          continue;
        }
        node.items.push(k); // straddler
        return;
      }
      node.items.push(k);
      if (node.items.length > this.capacity && node.depth < this.maxDepth) this.split(node);
      return;
    }
  }

  private split(node: QNode): void {
    const { minX, minY, maxX, maxY } = node.bounds;
    const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    const d = node.depth + 1;
    const mk = (b: Rect2): QNode => ({ bounds: b, depth: d, items: [], children: null });
    node.children = [
      mk({ minX, minY, maxX: mx, maxY: my }),
      mk({ minX: mx, minY, maxX, maxY: my }),
      mk({ minX, minY: my, maxX: mx, maxY }),
      mk({ minX: mx, minY: my, maxX, maxY }),
    ];
    const old = node.items;
    node.items = [];
    for (const k of old) {
      const r = this.rects[k] as Rect2;
      const child = node.children.find((c) => contains(c.bounds, r));
      if (child) {
        child.items.push(k);
      } else {
        node.items.push(k);
      }
    }
    for (const c of node.children) if (c.items.length > this.capacity && c.depth < this.maxDepth) this.split(c);
  }
}

const contains = (outer: Rect2, inner: Rect2): boolean =>
  inner.minX >= outer.minX && inner.minY >= outer.minY && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY;

const overlapsOrTouches = (a: Rect2, b: Rect2): boolean => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

const isFiniteRect = (r: Rect2): boolean => Number.isFinite(r.minX + r.minY + r.maxX + r.maxY);
