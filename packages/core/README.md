[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

# @spacexr/spatial-label-layout-core

Free placement of 3D labels around pins attached to meshes, with no rendering dependency. The solver projects billboards into each camera view (one for a desktop, two eyes plus a head pose for WebXR), resolves overlaps there, and returns world positions. Each label keeps its leader to the same pin for its whole life.

Math, solver, public API and integration ports. No dependencies.

## Install

```bash
npm install @spacexr/spatial-label-layout-core
```

With Babylon.js, add [`@spacexr/spatial-label-layout-babylon`](https://www.npmjs.com/package/@spacexr/spatial-label-layout-babylon), which implements the ports below.

## Use the engine directly

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

## Use the controller

An application normally goes through `LabelLayoutController`. It resolves anchors, runs the solver at a reduced rate (10 Hz by default), interpolates positions and pushes billboards and leaders to the renderer at every frame:

```ts
import { LabelLayoutController } from "@spacexr/spatial-label-layout-core";

const controller = new LabelLayoutController({ camera, anchors, labelRenderer, leaderRenderer });
renderLoop((deltaSeconds) => controller.tick(deltaSeconds));
```

The four options are ports an adapter implements for its rendering engine:

| Port | Job |
|---|---|
| `CameraProvider` | one view for a mono camera, one per eye in XR, and the reference frame version |
| `AnchorProvider` or `MeshResolver` | world position of a pin, from a mesh world matrix or a deformed triangle |
| `LabelRenderer` | create, place and hide the label objects |
| `LeaderRenderer` | create and update the leaders, as polylines in the world |
| `OcclusionProvider` (optional) | raycast, depth buffer or both |

`BillboardOrienter`, `SpatialIndex2D`, `CandidateGenerator`, `DeclutterStrategy`, `LeaderRouter` and `PlacementInterpolator` are strategies that can be replaced the same way.

Matrices go in as they are: 16 numbers, column-major, translation at 12, 13 and 14, in a left- or right-handed frame. Vectors are plain `{ x, y, z }` shapes read through their properties, so engine vectors can be passed as they are.

## Labels with a constant size on screen

By default `dimensions` are world units, and a label shrinks on screen as the camera moves away. A label with `sizing: "screen"` gives its dimensions in pixels instead, which suits maps, globes and any scene whose camera distance varies by orders of magnitude:

```ts
engine.addLabel({ id: "city", anchorId: "city", position, dimensions: { width: 120, height: 24 }, sizing: "screen", priority: 1, visible: true, enabled: true });
```

- its world size is resolved for each solve, and by the controller for each rendered frame, at the depth of its pin;
- each solve starts from where the label stood on screen relative to its pin;
- between two solves the default interpolator holds it at that pixel offset, so it follows the camera through a zoom.

Two engine options go with it: `anchorOutOfView: "hide"` hides the label of a pin that left every view, and `temporal.screenThresholdPx` measures camera and pin motion in pixels instead of world units.

## Leader routing

`straight` (default) attaches the leader where the line from the pin meets the border of the label. `elbow` leaves the pin horizontally, turns vertically and enters the label through a horizontal stub. `polyline` goes through points the caller gives. Crossings are detected in projection and reduced by swapping label positions, never by reassigning a leader.

## More

The pipeline, the objective function, the coordinate conventions and the failure cases are in the [architecture notes](https://github.com/pandaGaume/spatial-label-layout/blob/main/docs/architecture.md). What an adapter has to implement is in the [porting guide](https://github.com/pandaGaume/spatial-label-layout/blob/main/docs/porting.md).

## License

Apache-2.0
