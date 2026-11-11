[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

# @spacexr/spatial-label-layout-babylon

Babylon.js adapter for [`@spacexr/spatial-label-layout-core`](https://www.npmjs.com/package/@spacexr/spatial-label-layout-core): it gives the solver the views of the camera, and places the 3D objects of the application where the layout puts their labels, with a leader from each to its pin.

The labels are objects the application builds itself: an extruded tag, a textured plane, a group of meshes. The adapter writes their position, orientation and scaling. It draws no text of its own.

## Install

```bash
npm install @spacexr/spatial-label-layout-babylon @spacexr/spatial-label-layout-core
```

`@babylonjs/core` 9 is a peer dependency. `@babylonjs/loaders` and `@babylonjs/serializers` are optional ones, needed only to read and to write glTF labels.

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

## glTF labels: `SPACEXR_label`

A glTF node may declare itself a label. The package reads the extension, writes it, and presents the nodes that carry it.

```json
"SPACEXR_label": {
  "facing": "screen",
  "size": { "referenceHeight": 0.35, "pixels": 14 },
  "overlay": true,
  "leader": { "color": [0.87, 0.47, 0.01], "width": 1.6, "anchorRadius": 6 },
  "priority": 1
}
```

A label is an object made to be read. The origin of its node is where it stands. The point it names, its anchor, is given by `anchor`: a position in the frame of the parent of the node, as the translation of the node, on the ground the client displays when `ground` is given. A leader links the label to its anchor. With `leader` and no `anchor`, the anchor is the origin of the node, as before version 0.6 of the GeoModels v2 specification; a label with neither names nothing but its own place and has no leader. It reads along its local +X axis, its height along +Y, its face toward +Z. Every property is optional.

| Property | Role |
|---|---|
| `facing` | `screen`: the label stays parallel to the screen. Without it, it keeps the orientation of the glTF. |
| `size` | The length `referenceHeight` of its local +Y axis takes `pixels` CSS pixels on screen. Without it, its size is metric. |
| `overlay` | The label is drawn over the rest of the scene, never occluded. |
| `leader` | The style of the line that links the label to its anchor. Without `anchor`, it also makes the origin of the node the anchor. |
| `anchor` | The point the label names: `position` in the frame of the parent of the node, and `ground` (`{ offset }`) to stand it on the displayed ground. |
| `priority` | Labels of higher priority move less and are hidden last. Defaults to 1. |

`leader.color` is linear RGB, white by default; `leader.width` is in pixels, 1.5 by default; `leader.anchorRadius` is the radius in pixels of the mark drawn on the anchor, 0 by default for no mark. The extension is listed in `extensionsUsed` and never in `extensionsRequired`: a client that does not know it shows the node with the transform written in the glTF.

Reading, with `@babylonjs/loaders`:

```ts
import "@babylonjs/loaders/glTF/2.0/index.js";
import { LabelRuntime } from "@spacexr/spatial-label-layout-babylon";
import { registerSpaceXrLabelLoader } from "@spacexr/spatial-label-layout-babylon/gltf-loader";

registerSpaceXrLabelLoader();
const labels = new LabelRuntime(scene, { hides, layout });
```

The loader declares the label on the Babylon node it creates and attaches the node to the `LabelRuntime` of the scene it loads into. A scene has one runtime at most; without one, the declaration is kept and the node is not presented. `layout` holds settings of the layout engine, merged over the defaults: the length of the leaders, the gap between labels, the routing of the leaders. `hides(anchor, eye)` tells when the scene hides an anchor, the far side of a globe for instance: the label and its leader are then hidden.

Writing, with `@babylonjs/serializers`:

```ts
import { setNodeLabel } from "@spacexr/spatial-label-layout-babylon";
import { registerSpaceXrLabelExporter } from "@spacexr/spatial-label-layout-babylon/gltf-exporter";

registerSpaceXrLabelExporter();
setNodeLabel(node, { facing: "screen", size: { referenceHeight: 0.35, pixels: 14 }, overlay: true, leader: { anchorRadius: 6 } });
```

An application that holds its own copy of Babylon.js passes its `GLTFExporter` to `registerSpaceXrLabelExporter`.

How the runtime presents a label:

- **Anchor.** The node is the anchor and is never moved: something else may place it, on the ground for instance. What the node holds is put under a body node, which the runtime turns, scales and moves.
- **Facing.** A label that faces the screen looks along the axis of the camera, toward the viewer, not at the position of the camera: labels are parallel to one another, and two neighbours never cut through each other. In a headset, where the plane of the screen turns with the head, the label faces the head.
- **Size.** The label is scaled by `pixels × m / H`: `H` is the reference height in the scene with the authored scale, `m` the length a CSS pixel covers at the view depth of the anchor.
- **Overlay.** The meshes of the label go to a rendering group drawn last on a cleared depth buffer. Overlays are drawn back to front, the depth buffer cleared between two of them: each one covers those behind it, and its own parts still hide one another.
- **Leader.** A label with an anchor is handed to a `BabylonLabelLayout`. It stands on its node when nothing is in the way, is moved around it where it would cover another label, the least important ones hidden where they cannot all fit, and the leader is drawn to the anchor. The runtime draws the anchor mark, and stands an anchor with `ground` on the ground the `ground` option of `LabelRuntime` gives. An anchor the scene hides (the `hides` option) takes its leader and its mark away; the label stays while its own place shows.

Limits: a label with a leader always faces the screen, since the layout places a rectangle of the screen; leaders share one width, that of the first label that has one; a mesh shared by several nodes is one Babylon mesh with instances, drawn in one rendering group; in a headset, how a pixel maps to an angle of view is not settled.

## The pieces

`BabylonLabelLayout` builds the three ports and a controller. They can be used on their own with a `LabelLayoutController` of the core:

- `BabylonCameraProvider` (`CameraProvider`)
- `BabylonLabelRenderer` (`LabelRenderer`)
- `BabylonLeaderRenderer` (`LeaderRenderer`)

## License

Apache-2.0
