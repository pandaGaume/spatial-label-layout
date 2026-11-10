# Porting to a 3D library

The core knows nothing about engines. An adapter for Babylon.js, three.js, PlayCanvas or raw WebXR implements a handful of ports and calls `LabelLayoutController.tick(dt)` from its render loop. Projection, collisions, the solver, temporal stability and leader routing all stay in the core.

## What an adapter implements

| Core port | Job | Brief §9 name | Rough size |
|---|---|---|---|
| `MeshResolver` | world matrix of a mesh; optionally a deformed triangle | `BabylonAnchorProvider` | 15 lines |
| `CameraProvider` | mono view or XR eyes, center pose, reference frame version | `BabylonCameraProvider` | 30 lines |
| `LabelRenderer` | create, place and hide billboards | `BabylonBillboardAdapter` | 40 lines |
| `LeaderRenderer` | create and update 3D polylines | `BabylonLeaderRenderer` | 30 lines |
| `OcclusionProvider` (optional) | raycast, depth buffer or hybrid | `BabylonOcclusionProvider` | 30 lines |
| `BillboardOrienter` (optional) | match the engine's billboard mode | | 10 lines |
| render loop hook | `controller.tick(dt)` | `BabylonLabelLayoutController` | 10 lines |

If `TransformAnchorProvider` (world matrix plus barycentric interpolation) is not enough, implement `AnchorProvider` directly.

`RecordingLabelRenderer` and `RecordingLeaderRenderer` in `@spacexr/spatial-label-layout-debug` are the reference implementations. A real adapter does the same work with meshes instead of maps.

## Extension points

Members added for future ports are optional, so an adapter written against the minimal interfaces keeps compiling as the core grows.

- `AnchorProvider.beginFrame()` and `hasChanged()`: cache invalidation, world-matrix update counters.
- `MeshResolver.getTriangle()`: vertices after skinning or morph targets.
- `CameraProvider.getReferenceView()`: the head (center-eye) pose in XR.
- `CameraProvider.referenceFrameVersion`: bump it when an XR session starts or ends, on recentering, teleport, or an AR/VR switch. The controller resets the layout when it changes.
- `OcclusionProvider.beginQueries(views)` / `endQueries()`: read back a depth buffer, build a BVH, batch raycasts.
- `LabelRenderer.refreshLabel()` for text, style or size changes; `endFrame()` for instancing and buffer uploads.
- `SpatialIndex2D`: swap the quadtree for a BVH or GPU binning.
- `CandidateGenerator`, `DeclutterStrategy` (clustering would go here), `LeaderRouter` (obstacle-avoiding routes).

## Conventions the adapter must respect

Matrices go in as-is: 16 numbers, column-major, column vectors, translation at 12, 13 and 14. That is the memory layout of WebGL, `Matrix4.elements` and Babylon's `Matrix.m`. No transpose.

Handedness does not matter. Babylon (left-handed) and three (right-handed) both work without conversion, and the test suite runs both. Same for NDC depth: `[-1, 1]` and `[0, 1]` are both fine since only `x/w`, `y/w` and the sign of `w` are read.

`viewport` is in pixels of the render target, per eye in XR. Label `dimensions` are world units with the billboard scale already applied.

Use the controller's orientation. `BillboardTransform` carries `right`, `up` and `normal`; orient the mesh from those axes rather than from a native billboard mode. If the rendered quad and the solver's quad disagree, collisions are computed on the wrong shape.

## Babylon.js

The adapter is the package `@spacexr/spatial-label-layout-babylon`:

| Class | Port | Notes |
|---|---|---|
| `BabylonCameraProvider` | `CameraProvider` | Copies the matrices at each call. Viewport in CSS pixels by default. One view per rig camera when the camera has a rig (not run in a headset). |
| `BabylonLabelRenderer` | `LabelRenderer` | Places the application's own 3D objects: position, orientation from the controller's axes, scaling from the size the layout gives. `front` tells which local z the face of an object looks toward. |
| `BabylonLeaderRenderer` | `LeaderRenderer` | One thin cylinder per segment of the route, width in pixels or world units. |
| `BabylonLabelLayout` | | Builds the three above and a controller, and ticks before each render of the scene. |

It reads view matrices as they are in left- and right-handed scenes, and in scenes with floating origin (large world rendering), whose view matrix holds the true world position.

The sketch below is what the package does, kept as a guide for other engines.


```ts
import { LabelLayoutController, FixedRateScheduler, TransformAnchorProvider, type CameraProvider, type CameraView } from "@spacexr/spatial-label-layout-core";

const meshes = new TransformAnchorProvider({
  getWorldMatrix: (id) => scene.getMeshById(id)?.computeWorldMatrix(false).m ?? null,
});

const toView = (cam: BABYLON.Camera, engine: BABYLON.AbstractEngine, id?: string): CameraView => ({
  viewMatrix: cam.getViewMatrix().m,
  projectionMatrix: cam.getProjectionMatrix().m,
  viewport: { width: engine.getRenderWidth(), height: engine.getRenderHeight() },
  ...(id ? { id } : {}),
});

const inXR = () => xr.baseExperience.state === BABYLON.WebXRState.IN_XR;
const camera: CameraProvider = {
  getViews: () => (inXR()
    ? xr.baseExperience.camera.rigCameras.map((c, i) => toView(c, engine, i === 0 ? "left" : "right"))
    : [toView(scene.activeCamera!, engine, "mono")]),
  getReferenceView: () => (inXR() ? toView(xr.baseExperience.camera, engine, "center") : undefined),
  get referenceFrameVersion() { return xrSessionCounter; },
};

const controller = new LabelLayoutController({
  camera, anchors: meshes, labelRenderer, leaderRenderer, scheduler: new FixedRateScheduler(10),
});
scene.onBeforeRenderObservable.add(() => controller.tick(engine.getDeltaTime() / 1000));
```

For `LabelRenderer`, one plane mesh per label (dynamic texture or MSDF text), positioned from `transform.position` and oriented from the `(right, up, normal)` basis. `LeaderRenderer` maps to `MeshBuilder.CreateLines` with `updatable: true`, updated through `instance` on each `updateLeader`. Occlusion can use `scene.pickWithRay` (raycast strategy) or the depth renderer (depth strategy), combined with `HybridOcclusionProvider`.

The per-eye viewport above uses the full render size, which is wrong for side-by-side XR rendering. Take the eye's viewport from the rig camera instead. Not verified against a headset yet.

## three.js sketch

```ts
const toView = (cam: THREE.PerspectiveCamera, w: number, h: number, id?: string): CameraView => ({
  viewMatrix: cam.matrixWorldInverse.elements,
  projectionMatrix: cam.projectionMatrix.elements,
  viewport: { width: w, height: h },
  ...(id ? { id } : {}),
});
// XR: renderer.xr.getCamera().cameras are the eyes; renderer.xr.getCamera() is the center pose.
renderer.setAnimationLoop(() => { controller.tick(clock.getDelta()); renderer.render(scene, camera); });
```

`MeshResolver.getWorldMatrix` returns `object.matrixWorld.elements`, after `updateMatrixWorld`. Leaders fit `Line2` with `LineGeometry.setPositions`, or a plain `BufferGeometry` with `setDrawRange`.

## Raw WebXR

For each `XRView` in `frame.getViewerPose(refSpace).views`: `viewMatrix = view.transform.inverse.matrix`, `projectionMatrix = view.projectionMatrix`, viewport from `glLayer.getViewport(view)`. The center pose is `viewerPose.transform.inverse.matrix` with one eye's projection. Bump `referenceFrameVersion` on the reference space's `reset` event.
