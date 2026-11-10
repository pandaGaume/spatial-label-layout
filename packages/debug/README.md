# @spacexr/spatial-label-layout-debug

Diagnostics for [`@spacexr/spatial-label-layout-core`](../core/README.md), with no rendering dependency. This package is private: it serves the tests, the benchmarks and the examples of this repository, and it is not published to npm.

- `renderViewSvg`: a layout seen from one view, as an SVG image (labels, pins, leaders, collisions).
- `MetricsRecorder`: a layout observer that keeps per-solve metrics.
- `RecordingLabelRenderer`, `RecordingLeaderRenderer`: in-memory implementations of the rendering ports. They double as the reference for adapter authors.

## License

Apache-2.0
