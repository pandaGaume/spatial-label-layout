# Architecture

## Layout of the core

```
packages/core/src
  types.ts          public data model (brief §3, §5, §6, §8)
  geometry/         Vec3, Mat4 (column-major), Rect2, Segment2
  projection/       ResolvedView, pixel projection, Jacobian, camera builders
  billboard/        orienters (screen-aligned, viewpoint, fixed), corner projection
  collision/        SpatialIndex2D: QuadTreeIndex (default), UniformGridIndex, BruteForceIndex
  anchors/          AnchorProvider, MeshResolver, TransformAnchorProvider
  visibility/       OcclusionProvider: none, function, raymarch, hybrid, cached
  routing/          LeaderRouter: straight (MVP), elbow, polyline
  topology/         LeaderGraph, topology diff
  temporal/         TemporalStabilizer, SolveScheduler, PlacementInterpolator
  solver/           SpatialLabelLayoutEngine, config, candidates, declutter
  diagnostics/      LayoutObserver, LayoutSnapshot
  integration/      rendering ports and LabelLayoutController
packages/debug/src  SVG snapshots, MetricsRecorder, recording renderers
```

Nothing in `core` imports a rendering library, the DOM or a Node API.

## Coordinate conventions

World units are free; use meters for XR. Labels live in world space and are never parented to the camera.

Matrices are 16 numbers, column-major storage, column vectors, translation at indices 12, 13 and 14. Element (row r, column c) is `m[c * 4 + r]`. WebGL, three.js `Matrix4.elements` and Babylon.js `Matrix.m` all use this memory layout, so adapters pass their arrays through unchanged.

Handedness and NDC depth range are not fixed. `ResolvedView.forward` comes from the sign of `P[11]` for a perspective projection (clip `w = P[11] * z_view`), or `P[10]` for an orthographic one. That second case assumes non-reversed depth; a reversed-Z orthographic camera will get the wrong forward axis. A point is in front of the camera when `w > 0` (perspective) or when its depth along `forward` is positive (orthographic).

The camera's `right` and `up` axes are rows 0 and 1 of the view matrix. They map to increasing screen x and decreasing screen y whatever the handedness.

Pixels: origin top-left, y down. `x = (ndcX * 0.5 + 0.5) * width`, `y = (0.5 - ndcY * 0.5) * height`.

A billboard's corners are `center ± right * w/2 ± up * h/2`, with the frame given by the `BillboardOrienter` evaluated in the reference view. XR eyes therefore test the same quad that gets rendered.

## The solve pipeline (brief §4)

1. Read anchor positions (from an `AnchorProvider` or `setAnchorPosition`) and resolve every view: inverse view matrix, `viewProjection`, camera axes. The reference view is `referenceView` when given, otherwise `views[0]`.
2. Sort labels into active and hidden: disabled, user-hidden, missing anchor, or pin behind the camera (policy `hide`, `reposition` or `keep`).
3. Labels without a usable position get a discrete initial placement. A `CandidateGenerator` proposes positions around the pin (8 directions in the camera frame, two rings by default) and each one is scored on overlap with already placed labels, area outside the viewport and occlusion. Higher priority labels are placed first.
4. Continuous relaxation, Jacobi-style constraint projection. Each iteration first applies annealed soft forces (leader length, return toward the start position, depth preference), then projects hard constraints in every view: pairwise separation through the spatial index, pins not covered, labels kept in the viewport. Pixel corrections become world displacements through the exact projection Jacobian and are averaged across the views that asked for them. The loop stops when no real overlap remains above tolerance, when it stagnates (8 iterations without progress at small step sizes), or when the budget runs out.
5. Secondary objectives: swap the positions of two labels whose leaders cross (the `(anchorId, labelId)` pairs never change), then move occluded labels to visible candidates.
6. Repair. Relaxation gets stuck in local minima, typically a label wedged between a neighbour and a pin. The most mobile label of each remaining pair is re-placed at the best candidate on wider rings, followed by a short refinement.
7. If density makes a clean layout impossible, the optional priority declutter hides labels. Otherwise the result carries `unresolved-collision` and `impossible-density`.
8. Per-view evaluation: collisions, occlusions, crossings, labels out of view, stereo-only collisions, energy.

Interpolation and leader geometry run at render rate in `LabelLayoutController.tick()`, outside the solver.

## Objective function (brief §4.1)

`E = wo·Eoverlap + wx·Ecrossing + wm·Emotion + wa·Eocclusion + wd·Edepth`

| Term | Measured as |
|---|---|
| `Eoverlap` | overlapping pairs, summed over views |
| `Ecrossing` | leader crossings in the reference view |
| `Emotion` | sum of squared world displacements during the solve |
| `Eocclusion` | occluded labels (`any` or `all` views, configurable) |
| `Edepth` | squared relative distance error against the depth mode's target |

The solver does not minimise `E` globally. Collisions and visibility are handled as constraints and everything else as preferences. `E` shows up in the diagnostics so that two configurations can be compared on the same scene.

## Mathematical assumptions

Clip coordinates are affine in world position, so the four corners need only three matrix-vector products: clip(center) and the clip images of the two frame axes. The same terms give the exact pixel Jacobian at the center, by the quotient rule on `x/w` and `y/w`.

Collision tests use the axis-aligned bounding box of the projected corners. For a tilted billboard (viewpoint orienter near the edge of a wide field of view) that box is larger than the quad, so the solver keeps labels a bit further apart than needed. A separating-axis test on the actual quads would fix this; it is not implemented.

Corrections are linearised at the label center. That holds while displacements stay small compared with the camera distance, which is why each step is damped by `relaxation` (0.9) and iterated.

Moving a label along the camera ray keeps its position in the reference view but changes its projected size, and its position in each XR eye. A depth change alone may not remove an overlap (brief §4.1).

Occlusion is tested at the label center only. The pin and the leader can be hidden by terrain without changing the label's visibility (brief §6).

## Temporal stability: no relayout every frame (brief §7)

Three layers, from most to least frequent.

**Every rendered frame** (90 Hz or whatever the display runs at): `DampedInterpolator` eases displayed positions toward their targets (80 ms half-life) and leaders are re-routed from the live anchor positions. No layout work.

**Solver ticks** (`FixedRateScheduler`, 10 Hz by default). `TemporalStabilizer` skips the solve while the reference view has turned less than 1.5° and moved less than 5 cm since the last solve and nothing in the scene changed. Above 120°/s of rotation it freezes the layout for up to 0.5 s. A solve that does run starts from the previous positions and applies continuous corrections.

**Discrete reorganizations** of labels that are already placed (crossing swaps, collision repairs, occlusion relocations) go through a separate hysteresis:

- the defect has to be seen in `reorganizeAfterSolves` consecutive solves (3);
- a label cannot jump twice within `reorganizeCooldown` (2 s);
- if a defect survives a fix, the next attempt waits `reorganizeCooldown × 2^attempts` (4 s, 8 s, 16 s...). The counter resets once the defect disappears.

After a jump, the motion term targets the new position. Without that it pulled the label straight back to where the defect was, which showed up as a relocate / drift back / relocate loop in the terrain example.

New labels are exempt because they are still being placed. The cost of all this: a collision appearing on an established layout can stay visible for about three solver ticks (0.3 s at 10 Hz). And while the camera keeps orbiting, labels do get relocated as hills start hiding them; the terrain example (100 labels, 160° orbit in 8 s) does about 20 jumps per second, two thirds of them occlusion relocations. Pure head jitter produces none, and a test checks that.

`forceReset`, or a change of `CameraProvider.referenceFrameVersion`, triggers a controlled reset: XR reference space change, AR/VR switch, teleport.

## Failure cases (brief §10)

| Case | Behaviour | Diagnostic |
|---|---|---|
| No view, invalid view | empty result, labels hidden, no exception | `no-views`, `invalid-view` |
| Anchor without a position | label hidden, leader kept | `missing-anchor` |
| Pin behind the camera | `hide` (default), `reposition` toward the matching screen edge, or `keep` | `anchor-behind-camera` |
| Pin hidden by terrain | leader kept; label visibility decided on its own | counted in `perView[].occlusions` when the label itself is occluded |
| Mesh moved or deformed | recomputed by `TransformAnchorProvider` (matrix or barycentric) | |
| Fast camera | layout frozen, then re-solved | `reason: "fast-camera"` |
| Label resized | corners and collisions recomputed on the next solve | |
| Impossible density | violations reported; priority declutter if enabled | `unresolved-collision`, `impossible-density`, `label-decluttered` |
| Collision in one eye only | corrected in each view | `stereo-only-collision` if it remains |
| Label out of view | pushed back into the viewport, or reported | `label-out-of-view` |
| Iteration budget spent | best state reached is returned | `iteration-budget-exhausted` |
| Topology change | refused: `updateLabel` rejects a new `anchorId`; the relation is checked after every solve | `TopologyError` |

## Performance (brief §11)

The brief's targets are indicative: under 5 ms for 100 labels and under 15 ms for 500, to be measured on the reference machine. `npm run bench:budget` prints two tables. The worst case runs a full solve every 5° of a 360° orbit with stabilization off. The realistic one runs a 90 fps render loop with the solver at 10 Hz, stabilization on, a slow orbit and head jitter, and reports amortised cost per frame and discrete jumps per second. Numbers measured during development are in the README.

Cost depends heavily on density. What remains to try (M4 in the brief): incremental evaluation that only re-projects labels whose view or anchor changed, allocation-free typed buffers, and moving the solve to a worker or WASM.
