import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@spacexr/spatial-label-layout-core": r("./packages/core/src/index.ts"),
      "@spacexr/spatial-label-layout-debug": r("./packages/debug/src/index.ts"),
      "@spacexr/spatial-label-layout-babylon": r("./packages/babylon/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    benchmark: {
      include: ["benchmarks/**/*.bench.ts"],
    },
  },
});
