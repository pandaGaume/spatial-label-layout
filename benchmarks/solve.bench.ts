import { bench, describe } from "vitest";
import { buildScene, orbitStereo, orbitView } from "./scenes.js";

/**
 * Brief section 11 indicative targets (to be measured on the reference
 * machine, no a-priori guarantee): < 5 ms for 100 labels, < 15 ms for 500.
 * "warm" = steady-state solve after a small camera motion (the XR case).
 */
for (const count of [10, 100, 500]) {
  describe(`${count} labels`, () => {
    bench(
      "cold solve (candidates + relaxation)",
      () => {
        buildScene(count).solve({ views: [orbitView(0)], deltaTime: 0.1 });
      },
      { iterations: count >= 500 ? 5 : 20 },
    );

    const warm = buildScene(count);
    warm.solve({ views: [orbitView(0)], deltaTime: 0.1 });
    let a = 0;
    bench("warm solve, mono, small camera motion", () => {
      a += 0.01;
      warm.solve({ views: [orbitView(a)], deltaTime: 0.1 });
    });

    const stereoEngine = buildScene(count);
    let b = 0;
    stereoEngine.solve({ views: [orbitView(0)], deltaTime: 0.1 });
    bench("warm solve, stereo (2 eyes + center)", () => {
      b += 0.01;
      const { center, left, right } = orbitStereo(b);
      stereoEngine.solve({ views: [left, right], referenceView: center, deltaTime: 0.1 });
    });
  });
}

describe("dense hotspot", () => {
  const dense = buildScene(100, "clustered", { declutter: { enabled: true } });
  let a = 0;
  dense.solve({ views: [orbitView(0)], deltaTime: 0.1 });
  bench("100 clustered labels, warm, declutter on", () => {
    a += 0.01;
    dense.solve({ views: [orbitView(a)], deltaTime: 0.1 });
  });
});
