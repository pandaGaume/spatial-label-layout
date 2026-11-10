import type { LabelLeader, LeaderRouting } from "../types.js";

export class TopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopologyError";
  }
}

/** Frozen view of the (leaderId, anchorId, labelId) relation at a given instant. */
export type TopologySnapshot = ReadonlyArray<Readonly<LabelLeader>>;

export const leaderIdFor = (labelId: string): string => `${labelId}::leader`;

/**
 * Bipartite anchor/label relation. Each label owns exactly one leader to one
 * anchor; the pair never changes while the label exists. An anchor may carry
 * several labels.
 */
export class LeaderGraph {
  private readonly byLabel = new Map<string, LabelLeader>();

  add(labelId: string, anchorId: string, routing: LeaderRouting): LabelLeader {
    if (this.byLabel.has(labelId)) throw new TopologyError(`label "${labelId}" already has a leader`);
    const leader: LabelLeader = { id: leaderIdFor(labelId), anchorId, labelId, routing };
    this.byLabel.set(labelId, leader);
    return leader;
  }

  remove(labelId: string): void {
    this.byLabel.delete(labelId);
  }

  get(labelId: string): LabelLeader | undefined {
    return this.byLabel.get(labelId);
  }

  /** Routing is geometry, not topology: it may change at any time. */
  setRouting(labelId: string, routing: LeaderRouting): void {
    const l = this.byLabel.get(labelId);
    if (l) l.routing = routing;
  }

  labelsOfAnchor(anchorId: string): string[] {
    const out: string[] = [];
    for (const l of this.byLabel.values()) if (l.anchorId === anchorId) out.push(l.labelId);
    return out;
  }

  all(): LabelLeader[] {
    return [...this.byLabel.values()].map((l) => ({ ...l }));
  }

  get size(): number {
    return this.byLabel.size;
  }

  clear(): void {
    this.byLabel.clear();
  }

  snapshot(): TopologySnapshot {
    return Object.freeze([...this.byLabel.values()].map((l) => Object.freeze({ ...l })));
  }
}

export interface TopologyViolation {
  labelId: string;
  before: string | null;
  after: string | null;
}

/** Compares two snapshots on the (labelId -> anchorId) relation. Routing changes are ignored. */
export const diffTopology = (before: TopologySnapshot, after: TopologySnapshot): TopologyViolation[] => {
  const a = new Map(before.map((l) => [l.labelId, l.anchorId] as const));
  const b = new Map(after.map((l) => [l.labelId, l.anchorId] as const));
  const out: TopologyViolation[] = [];
  for (const [labelId, anchorId] of a) {
    const next = b.get(labelId) ?? null;
    if (next !== anchorId) out.push({ labelId, before: anchorId, after: next });
  }
  for (const [labelId, anchorId] of b) if (!a.has(labelId)) out.push({ labelId, before: null, after: anchorId });
  return out;
};
