import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Writes `content` to examples/<example>/out/<name> and returns the path. */
export const writeOut = (importMetaUrl: string, name: string, content: string): string => {
  const dir = join(dirname(fileURLToPath(importMetaUrl)), "out");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

export const terrainHeight = (x: number, z: number): number => 1.2 * Math.sin(x * 0.35) * Math.cos(z * 0.3) + 0.4 * Math.sin(x * 1.1 + z * 0.7);

export const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
