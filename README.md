# spatial-label-layout

Free placement of 3D labels around pins attached to meshes. The core has no rendering dependency: it projects billboards into each camera view (one for desktop, two eyes plus a head pose for WebXR), resolves overlaps there, and returns world positions. Each label keeps its leader to the same pin for its whole life. Labels are world-space billboards; there is no DOM overlay.

This repository implements the *Spatial Label Layout v1.0* brief up to milestone M1 (core, debug tooling, tests and benchmarks) and the Babylon.js adapter of M2. The three.js adapter is not here yet. [docs/porting.md](docs/porting.md) lists what an adapter has to implement.

| Package | Contents |
|---|---|
| `@spacexr/spatial-label-layout-core` | math, solver, public API, integration ports. No dependencies. |
| `@spacexr/spatial-label-layout-debug` | SVG snapshots, metrics recorder, in-memory renderers that double as reference adapters. Private: not published to npm. |
| `@spacexr/spatial-label-layout-babylon` | Babylon.js adapter: camera views, renderers that place the application's own 3D label objects and their leaders, render loop hook. Peer dependency on `@babylonjs/core` 9. |

## Getting started

Requires Node 20 or later. The repository is an npm workspace.

```bash
npm install
npm test
npm run example:basic
```

Using the engine directly:

```ts
import { SpatialLabelLayoutEngine, createCameraView } from "@spacexr/spatial-label-layout-core";

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

With Babylon.js, `BabylonLabelLayout` wires the controller to a scene. The labels are 3D objects the application builds itself; the adapter places, orients and scales them:

```ts
import { BabylonLabelLayout } from "@spacexr/spatial-label-layout-babylon";

const layout = new BabylonLabelLayout({
  scene,
  // Any node whose local x reads to the right and y upward; `front` tells which way its face looks.
  labels: { create: (label) => ({ node: buildMyTag(label), width: 2, height: 0.8, front: "+z" }) },
  leaders: { width: 1.5 }, // pixels
});
layout.engine.setAnchorPosition("summit", { x: 0, y: 2, z: 0 });
layout.controller.addLabel({ id: "label-summit", anchorId: "summit", position: { x: 0, y: 2, z: 0 }, dimensions: { width: 120, height: 48 }, sizing: "screen", priority: 1, visible: true, enabled: true });
```

The layout advances before each render of the scene. An application with its own frame loop passes `autoTick: false` and calls `layout.tick()`.

## Labels with a constant size on screen

By default `dimensions` are world units, and a label shrinks on screen as the camera moves away. A label with `sizing: "screen"` gives its dimensions in pixels instead, which suits maps, globes and any scene whose camera distance varies by orders of magnitude:

- the engine resolves its world size for each solve, and the controller for each rendered frame, at the depth of its pin;
- each solve starts from where the label stood on screen relative to its pin, not from where it stood in the world;
- between two solves the default interpolator (`ScreenLockedInterpolator`) holds it at that pixel offset, so it follows the camera rigidly during a zoom instead of drifting away from its pin or falling on it.

Two engine options go with it. `anchorOutOfView: "hide"` hides the label of a pin that left every view, where the default keeps it on screen with a leader running off it. `temporal.screenThresholdPx` replaces the world-unit thresholds of the stabilizer (5 cm, 1 mm) by one in pixels: the layout is solved again once a pin moved more than that on screen, whatever the scale of the scene.

## How it behaves

Labels are placed once from candidate positions around their pin. After that they move continuously, and only by small corrections. The solver runs at 10 Hz and skips work while the head moves less than 1.5° or 5 cm. Discrete jumps (swapping two labels to uncross their leaders, re-placing a stuck label) need the defect to persist for three solves and are rate-limited per label. Small head motion produces no reorganization; a test checks this over 60 jittered solves of a 100-label scene.

Collision detection goes through a quadtree, so the number of pair tests follows local density rather than the label count squared. A uniform grid and a brute-force index sit behind the same `SpatialIndex2D` interface.

Rendering engine dependencies all go through ports, and every member added for future ports is optional:

- `MeshResolver` or `AnchorProvider` for mesh world matrices and deformed triangles
- `CameraProvider` for mono or XR views and the reference frame version
- `LabelRenderer`, `LeaderRenderer` for the native objects
- `OcclusionProvider` (raycast, depth, hybrid)
- `BillboardOrienter`, `SpatialIndex2D`, `CandidateGenerator`, `DeclutterStrategy`, `LeaderRouter`, `PlacementInterpolator` for strategies

Vectors go in as plain `{ x, y, z }` shapes and are read through their properties, so engine vectors that keep their coordinates behind accessors (Babylon.js) can be passed as they are.

Coordinate conventions (column-major matrices, any handedness, pixels with y down) and the full pipeline are in [docs/architecture.md](docs/architecture.md).

## Scripts

| Command | |
|---|---|
| `npm run build` | compile the packages (`tsc -b`) |
| `npm run typecheck` | packages plus tests, benchmarks and examples |
| `npm test` | Vitest: unit, integration, stereo |
| `npm run bench` | Vitest micro-benchmarks |
| `npm run bench:budget` | brief §11 budgets, worst case and realistic XR loop |
| `npm run example:basic`, `example:dense`, `example:terrain`, `example:webxr` | Node examples; SVG output in `examples/*/out/` |

## Releasing

The core and the Babylon.js adapter are published to npm under the `@spacexr` organization, at the same version, by [.github/workflows/release.yaml](.github/workflows/release.yaml) when a tag `vX.Y.Z` is pushed. The workflow checks that the tag carries the version of every `packages/*/package.json`, builds, runs the type check and the tests, and publishes each package from its workspace.

```bash
npm version 0.2.0 --workspaces --no-git-tag-version   # every package, debug included
# then set the same version where a package names another: the dependency of debug
# and the peer range of babylon on the core
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

The workflow publishes through npm trusted publishing (OIDC), with no token. A package must exist on npm before a trusted publisher can be set on it, so the first version is published by hand, from the root, after `npm run build`:

```bash
npm publish --workspace @spacexr/spatial-label-layout-core --access public
npm publish --workspace @spacexr/spatial-label-layout-babylon --access public
```

Then, on npmjs.com, each of the two packages gets this repository and `release.yaml` as its trusted publisher.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Performance

The brief targets under 5 ms per solve for 100 labels and under 15 ms for 500, measured on the reference machine and with no guarantee. Numbers below come from `npm run bench:budget` on a Windows laptop (Node 22, compiled output), labels scattered on a terrain over 24 × 24 m, 1920 × 1080 viewport. "Clustered" puts 60% of the pins in a 3 × 3 m hotspot.

Worst case, a full solve every 5° of orbit with stabilization off (mean / p95 ms):

| Labels | Mono, uniform | Mono, clustered | Stereo, uniform | Stereo, clustered |
|---|---|---|---|---|
| 10 | 0.3 / 0.7 | 0.3 / 1.4 | 0.1 / 0.4 | 0.2 / 0.4 |
| 100 | 3.8 / 9.1 | 15.7 / 19.7 | 7.0 / 15.1 | 32.2 / 39.7 |
| 500 | 134 / 180 | 232 / 312 | 279 / 344 | 537 / 739 |

At 100 labels the uniform scenes converge on every step. The clustered ones converge about half the time and keep 1.3 to 1.4 overlapping pairs per view on average. At 500 labels the uniform scene converges on 12 of 72 steps with about 2.7 residual pairs per view; the clustered one never converges (around 200 pairs per view), which is where the priority declutter is meant to take over.

Realistic loop: 90 fps rendering, solver at 10 Hz, stabilization on, 20°/s orbit plus head jitter, 10 s.

| Labels | Cost per rendered frame (amortized) | Solve p95 | Discrete jumps per second | Residual collisions per view |
|---|---|---|---|---|
| 100 | 0.24 ms | 6.0 ms | 2.5 | 0.01 |
| 500 | 8.3 ms | 99 ms | 52 | 15 |

So the 100-label MVP case fits a 90 Hz frame comfortably. 500 labels does not: a single solve takes several frames, and while the camera keeps orbiting the layout keeps reorganizing. That needs the M4 work (incremental evaluation, worker thread) before it is usable.

## Known limitations

Collisions use the bounding box of the projected corners. Tilted billboards near the edge of a wide field of view are therefore kept slightly further apart than necessary.

`elbow` leaders are orthogonal by default, as in the brief (horizontal from the pin, vertical, horizontal into the label); `polyline` leaders go through points the caller gives. Neither avoids obstacles.

With `temporal.screenThresholdPx`, a camera moving straight toward a pin at the center of the view moves no pin on screen: world-sized labels grow there without a new solve. The option is meant for screen-sized labels.

The performance figures above were measured before screen sizing was added and have not been run again.

Very dense scenes, with hundreds of labels packed into a few centimetres of screen, are not solved without overlap. The engine reports `impossible-density` and can hide labels by priority. Clustering would plug into `DeclutterStrategy` and is not written.

The Babylon.js adapter is tested with Babylon's null engine, in left- and right-handed scenes, and runs in one application on a streamed globe with a mono camera. Its WebXR path (one view per rig camera) has not run in a headset. Nothing has run in three.js.
