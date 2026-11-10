[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

# @spacexr/spatial-label-layout-babylon

Babylon.js adapter for [`@spacexr/spatial-label-layout-core`](https://www.npmjs.com/package/@spacexr/spatial-label-layout-core): it gives the solver the views of the camera, and places the 3D objects of the application where the layout puts their labels, with a leader from each to its pin.

The labels are objects the application builds itself: an extruded tag, a textured plane, a group of meshes. The adapter writes their position, orientation and scaling. It draws no text of its own.

## Install

```bash
npm install @spacexr/spatial-label-layout-babylon @spacexr/spatial-label-layout-core
```

`@babylonjs/core` 9 is a peer dependency.

## Use

```ts
import { BabylonLabelLayout } from "@spacexr/spatial-label-layout-babylon";

const layout = new BabylonLabelLayout({
  scene,
  labels: {
    // Called once per label: returns the object that shows it, with its local size.
    create: (label) => ({ node: buildMyTag(label), width: 2, height: 0.8, front: "+z" }),
  },
  leaders: { width: 1.5 }, // pixels
});

layout.engine.setAnchorPosition("summit", { x: 0, y: 2, z: 0 });
layout.controller.addLabel({
  id: "label-summit", anchorId: "summit", position: { x: 0, y: 2, z: 0 },
  dimensions: { width: 120, height: 48 }, sizing: "screen",
  priority: 1, visible: true, enabled: true,
});
```

The layout advances before each render of the scene. An application that runs its own frame loop passes `autoTick: false` and calls `layout.tick()` once the camera of the frame is set. `layout.dispose()` releases the label objects and the leaders.

## Label objects

`create` returns a `BabylonLabelNode`:

| Member | Meaning |
|---|---|
| `node` | A `TransformNode` with no parent that moves it. Its local x axis reads to the right, its local y axis upward. |
| `width`, `height` | Its size along local x and y, before scaling, in any unit. The adapter scales the node so that this size shows as the size the layout gives. |
| `front` | Local z direction the readable face looks toward: `"-z"` (default, as the planes Babylon.js builds) or `"+z"`. |
| `dispose` | Releases what the node owns. Default: `node.dispose()`. |

The node is oriented from the axes the layout measured the label with, not from a billboard mode of the engine, so the quad drawn is the quad solved. Leave `billboardMode` at 0 on it.

## Leaders

A leader is a polyline in the world, pin first. Each segment is a thin cylinder, so straight, elbow and polyline routes are all drawn, with a width in pixels (`widthUnit: "screen"`, the default here) or in world units. `material` gives a material per leader, and `configure` is applied once to each segment mesh (rendering group, metadata).

## Camera

`BabylonCameraProvider` reads the active camera of the scene, or the one given as `camera`. The viewport is in CSS pixels by default (`pixels: "css"`), and so is every pixel quantity of the layout: screen-sized labels, `paddingPx`, `leaderLengthPx`. `pixels: "render"` uses the pixels of the render target.

View matrices are read as they are in left- and right-handed scenes, and in scenes with floating origin (large world rendering), whose view matrix holds the true world position.

A camera with rig cameras (WebXR, stereoscopic rigs) gives one view per rig camera, with the rig parent as reference view. Call `bumpReferenceFrame()` on the provider when an XR session starts or ends. This path has not run in a headset yet.

## The pieces

`BabylonLabelLayout` builds the three ports and a controller. They can be used on their own with a `LabelLayoutController` of the core:

- `BabylonCameraProvider` (`CameraProvider`)
- `BabylonLabelRenderer` (`LabelRenderer`)
- `BabylonLeaderRenderer` (`LeaderRenderer`)

## License

Apache-2.0
