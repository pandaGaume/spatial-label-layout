import { describe, expect, it } from "vitest";
import {
  BruteForceIndex,
  containmentTranslation,
  minimumTranslation,
  QuadTreeIndex,
  rectsOverlap,
  segmentsCross,
  UniformGridIndex,
  type Rect2,
} from "@spatial-label-layout/core";
import { rng } from "../helpers/scene.js";

describe("rect2", () => {
  it("separates overlapping rectangles along the least penetration axis", () => {
    const a: Rect2 = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const b: Rect2 = { minX: 8, minY: 2, maxX: 18, maxY: 12 };
    const t = minimumTranslation(a, b);
    expect(t).toEqual({ x: -2, y: 0 });
    const moved = { minX: a.minX + t!.x, minY: a.minY, maxX: a.maxX + t!.x, maxY: a.maxY };
    expect(rectsOverlap(moved, b)).toBe(false);
  });

  it("returns null for disjoint rectangles and handles exact superposition", () => {
    expect(minimumTranslation({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { minX: 2, minY: 2, maxX: 3, maxY: 3 })).toBeNull();
    const r = { minX: 0, minY: 0, maxX: 4, maxY: 2 };
    const t = minimumTranslation(r, { ...r });
    expect(t).not.toBeNull();
    expect(Math.abs(t!.x) + Math.abs(t!.y)).toBeGreaterThan(0);
  });

  it("computes containment translations", () => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(containmentTranslation({ minX: -5, minY: 10, maxX: 5, maxY: 20 }, bounds)).toEqual({ x: 5, y: 0 });
    expect(containmentTranslation({ minX: 95, minY: 98, maxX: 105, maxY: 108 }, bounds)).toEqual({ x: -5, y: -8 });
  });
});

describe("segment2", () => {
  it("detects proper crossings only", () => {
    expect(segmentsCross({ a: { x: 0, y: 0 }, b: { x: 10, y: 10 } }, { a: { x: 0, y: 10 }, b: { x: 10, y: 0 } })).toBe(true);
    // Shared endpoint (two leaders from the same pin) is not a crossing.
    expect(segmentsCross({ a: { x: 0, y: 0 }, b: { x: 10, y: 10 } }, { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } })).toBe(false);
    expect(segmentsCross({ a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }, { a: { x: 2, y: 0 }, b: { x: 3, y: 0 } })).toBe(false);
  });
});

describe("spatial index", () => {
  const randomRects = (n: number, seed: number): Rect2[] => {
    const r = rng(seed);
    return Array.from({ length: n }, () => {
      const x = r() * 1000, y = r() * 700, w = 5 + r() * 120, h = 5 + r() * 40;
      return { minX: x, minY: y, maxX: x + w, maxY: y + h };
    });
  };
  const pairs = (idx: { forEachOverlappingPair(cb: (a: number, b: number) => void): void }): string[] => {
    const out: string[] = [];
    idx.forEachOverlappingPair((a, b) => out.push(`${a}-${b}`));
    return out.sort();
  };

  it.each([1, 2, 3])("uniform grid reports exactly the brute-force pairs, once each (seed %i)", (seed) => {
    const rects = randomRects(300, seed);
    // A huge rectangle exercises the overflow path.
    rects.push({ minX: -50, minY: -50, maxX: 5000, maxY: 5000 });
    const grid = new UniformGridIndex();
    const brute = new BruteForceIndex();
    rects.forEach((r, i) => {
      grid.insert(i, r);
      brute.insert(i, r);
    });
    const g = pairs(grid);
    expect(new Set(g).size).toBe(g.length);
    expect(g).toEqual(pairs(brute));
  });

  it.each([1, 2, 3])("quadtree reports exactly the brute-force pairs, once each (seed %i)", (seed) => {
    const rects = randomRects(300, seed);
    rects.push({ minX: -50, minY: -50, maxX: 5000, maxY: 5000 });
    // Dense hotspot: 200 small rectangles in a 60x60 px square.
    const r = rng(seed + 100);
    for (let i = 0; i < 200; i++) {
      const x = 500 + r() * 60, y = 300 + r() * 60;
      rects.push({ minX: x, minY: y, maxX: x + 4 + r() * 10, maxY: y + 3 + r() * 5 });
    }
    const tree = new QuadTreeIndex();
    const brute = new BruteForceIndex();
    rects.forEach((rc, i) => {
      tree.insert(i, rc);
      brute.insert(i, rc);
    });
    const t = pairs(tree);
    expect(new Set(t).size).toBe(t.length);
    expect(t).toEqual(pairs(brute));
    expect(tree.depth).toBeGreaterThan(2); // the hotspot subdivided
  });

  it("quadtree answers rect queries and incremental inserts like brute force", () => {
    const rects = randomRects(200, 9);
    const tree = new QuadTreeIndex({ capacity: 4 });
    const brute = new BruteForceIndex();
    rects.slice(0, 150).forEach((rc, i) => {
      tree.insert(i, rc);
      brute.insert(i, rc);
    });
    const q = { minX: 200, minY: 100, maxX: 600, maxY: 400 };
    const collect = (idx: { query(r: Rect2, cb: (id: number) => void): void }) => {
      const out: number[] = [];
      idx.query(q, (id) => out.push(id));
      return out.sort((a, b) => a - b);
    };
    expect(collect(tree)).toEqual(collect(brute));
    // Incremental inserts after the tree is built, including one outside its bounds.
    rects.slice(150).forEach((rc, k) => {
      tree.insert(150 + k, rc);
      brute.insert(150 + k, rc);
    });
    tree.insert(999, { minX: -3000, minY: -3000, maxX: 300, maxY: 300 });
    brute.insert(999, { minX: -3000, minY: -3000, maxX: 300, maxY: 300 });
    expect(collect(tree)).toEqual(collect(brute));
    expect(pairs(tree)).toEqual(pairs(brute));
  });

  it("supports incremental inserts and rect queries", () => {
    const grid = new UniformGridIndex({ cellSize: 32 });
    grid.insert(0, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
    const hits: number[] = [];
    grid.query({ minX: 5, minY: 5, maxX: 6, maxY: 6 }, (id) => hits.push(id));
    grid.insert(1, { minX: 4, minY: 4, maxX: 40, maxY: 40 });
    grid.query({ minX: 5, minY: 5, maxX: 6, maxY: 6 }, (id) => hits.push(id));
    expect(hits).toEqual([0, 0, 1]);
  });
});
