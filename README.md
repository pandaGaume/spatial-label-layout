# spatial-label-layout

Free placement of 3D labels around pins attached to meshes. The core has no rendering dependency: it projects billboards into each camera view (one for desktop, two eyes plus a head pose for WebXR), resolves overlaps there, and returns world positions. Each label keeps its leader to the same pin for its whole life. Labels are world-space billboards; there is no DOM overlay.

This repository implements the *Spatial Label Layout v1.0* brief up to milestone M1: core, debug tooling, tests and benchmarks. Engine adapters (Babylon.js for M2, three.js later) are not here yet. [docs/porting.md](docs/porting.md) lists what each one has to implement.

| Package | Contents |
|---|---|
| `@spatial-label-layout/core` | math, solver, public API, integration ports. No dependencies. |
| `@spatial-label-layout/debug` | SVG snapshots, metrics recorder, in-memory renderers that double as reference adapters |

## Getting started

Requires Node 20+ and pnpm (pinned through `packageManager`, so `corepack pnpm` works without a global install).

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm example:basic
```

Using the engine directly:

```ts
import { SpatialLabelLayoutEngine, createCameraView } from "@spatial-label-layout/core";

const engine = new SpatialLabelLayoutEngine();
engine.setAnchorPosition("summit", { x: 0, y: 2, z: 0 });
engine.addLabel({
  id: "label-summit", anchorId: "summit", position: { x: 0, y: 2, z: 0 },
  dimensions: { width: 1.4, height: 0.4 }, priority: 1, visible: true, enabled: true,
});

const view = createCameraView({ eye: { x: 0, y: 4, z: 9 }, target: { x: 0, y: 1, z: 0 }, viewport: { width: 1280, height: 720 } });
const result = engine.solve({ views: [view], deltaTime: 0.016 });
// result.placements: world positions and visibility
// result.diagnostics: per-view collisions, occlusions, crossings, explicit messages
```

An application would normally go through `LabelLayoutController`. It resolves anchors, runs the solver at a reduced rate, interpolates positions and pushes billboards and leaders to the renderer every frame:

```ts
const controller = new LabelLayoutController({ camera, anchors, labelRenderer, leaderRenderer });
renderLoop((dt) => controller.tick(dt));
```

## How it behaves

Labels are placed once from candidate positions around their pin. After that they move continuously, and only by small corrections. The solver runs at 10 Hz and skips work while the head moves less than 1.5° or 5 cm. Discrete jumps (swapping two labels to uncross their leaders, re-placing a stuck label) need the defect to persist for three solves and are rate-limited per label. Small head motion produces no reorganization; a test checks this over 60 jittered solves of a 100-label scene.

Collision detection goes through a quadtree, so the number of pair tests follows local density rather than the label count squared. A uniform grid and a brute-force index sit behind the same `SpatialIndex2D` interface.

Rendering engine dependencies all go through ports, and every member added for future ports is optional:

- `MeshResolver` or `AnchorProvider` for mesh world matrices and deformed triangles
- `CameraProvider` for mono or XR views and the reference frame version
- `LabelRenderer`, `LeaderRenderer` for the native objects
- `OcclusionProvider` (raycast, depth, hybrid)
- `BillboardOrienter`, `SpatialIndex2D`, `CandidateGenerator`, `DeclutterStrategy`, `LeaderRouter` for strategies

Coordinate conventions (column-major matrices, any handedness, pixels with y down) and the full pipeline are in [docs/architecture.md](docs/architecture.md).

## Scripts

| Command | |
|---|---|
| `pnpm build` | compile the packages (`tsc -b`) |
| `pnpm typecheck` | packages plus tests, benchmarks and examples |
| `pnpm test` | Vitest: unit, integration, stereo |
| `pnpm bench` | Vitest micro-benchmarks |
| `pnpm bench:budget` | brief §11 budgets, worst case and realistic XR loop |
| `pnpm example:basic`, `example:dense`, `example:terrain`, `example:webxr` | Node examples; SVG output in `examples/*/out/` |

## Performance

The brief targets under 5 ms per solve for 100 labels and under 15 ms for 500, measured on the reference machine and with no guarantee. Numbers below come from `pnpm bench:budget` on a Windows laptop (Node 22, compiled output), labels scattered on a terrain over 24 × 24 m, 1920 × 1080 viewport. "Clustered" puts 60% of the pins in a 3 × 3 m hotspot.

Worst case, a full solve every 5° of orbit with stabilization off (mean / p95 ms):

| Labels | Mono, uniform | Mono, clustered | Stereo, uniform | Stereo, clustered |
|---|---|---|---|---|
| 10 | 0.3 / 0.6 | 0.2 / 0.4 | 0.2 / 0.5 | 0.2 / 0.5 |
| 100 | 4.6 / 12.0 | 19.1 / 26.3 | 9.5 / 19.3 | 42.8 / 52.9 |
| 500 | 122 / 137 | 246 / 272 | 352 / 629 | 699 / 876 |

At 100 labels the uniform scenes converge on every step. The clustered ones keep about 9 overlapping pairs per view, and at 500 labels nothing converges.

Realistic loop: 90 fps rendering, solver at 10 Hz, stabilization on, 20°/s orbit plus head jitter, 10 s.

| Labels | Cost per rendered frame (amortized) | Solve p95 | Discrete jumps per second | Residual collisions per view |
|---|---|---|---|---|
| 100 | 0.28 ms | 7.1 ms | 2.3 | 0 |
| 500 | 13.2 ms | 159 ms | 51 | 16 |

So the 100-label MVP case fits a 90 Hz frame comfortably. 500 labels does not: a single solve takes several frames, and while the camera keeps orbiting the layout keeps reorganizing. That needs the M4 work (incremental evaluation, worker thread) before it is usable.

## Known limitations

Collisions use the bounding box of the projected corners. Tilted billboards near the edge of a wide field of view are therefore kept slightly further apart than necessary.

`elbow` and `polyline` leaders exist but do not avoid obstacles.

Very dense scenes, with hundreds of labels packed into a few centimetres of screen, are not solved without overlap. The engine reports `impossible-density` and can hide labels by priority. Clustering would plug into `DeclutterStrategy` and is not written.

None of this has run inside Babylon.js, three.js or a headset yet: every test uses synthetic cameras.
