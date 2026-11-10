import type {
  BillboardTransform,
  LabelLeader,
  LabelRenderer,
  LeaderRenderer,
  SpatialLabel,
  Vec3,
} from "@spacexr/spatial-label-layout-core";

/**
 * In-memory implementations of the rendering ports. They double as the
 * reference for adapter authors: a Babylon/three adapter does the same thing
 * with meshes and line systems instead of maps.
 */
export class RecordingLabelRenderer implements LabelRenderer {
  readonly labels = new Map<string, { label: Readonly<SpatialLabel>; transform: BillboardTransform | null; visible: boolean; updates: number }>();
  frames = 0;

  createLabel(label: Readonly<SpatialLabel>): void {
    this.labels.set(label.id, { label, transform: null, visible: false, updates: 0 });
  }
  updateLabel(id: string, transform: BillboardTransform, visible: boolean): void {
    const e = this.labels.get(id);
    if (!e) throw new Error(`updateLabel on unknown label "${id}"`);
    e.transform = transform;
    e.visible = visible;
    e.updates++;
  }
  refreshLabel(label: Readonly<SpatialLabel>): void {
    const e = this.labels.get(label.id);
    if (e) e.label = label;
  }
  removeLabel(id: string): void {
    this.labels.delete(id);
  }
  endFrame(): void {
    this.frames++;
  }
}

export class RecordingLeaderRenderer implements LeaderRenderer {
  readonly leaders = new Map<string, { leader: Readonly<LabelLeader>; points: readonly Vec3[]; visible: boolean }>();

  createLeader(leader: Readonly<LabelLeader>): void {
    this.leaders.set(leader.id, { leader, points: [], visible: false });
  }
  updateLeader(id: string, points: readonly Vec3[], visible: boolean): void {
    const e = this.leaders.get(id);
    if (!e) throw new Error(`updateLeader on unknown leader "${id}"`);
    e.points = points;
    e.visible = visible;
  }
  removeLeader(id: string): void {
    this.leaders.delete(id);
  }
}
