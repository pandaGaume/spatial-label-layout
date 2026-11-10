/**
 * Fallback when density makes a collision-free layout impossible (brief
 * section 10). Priority hiding is the MVP; clustering strategies can implement
 * the same interface later (e.g. merge colliding labels into a group label).
 */
export interface DeclutterCandidate {
  id: string;
  priority: number;
  /** Number of residual collisions this label takes part in. */
  collisions: number;
}

export interface DeclutterStrategy {
  readonly kind: string;
  /**
   * Returns the ids to hide, given the residual colliding pairs.
   * Called once per solve after relaxation; hidden labels keep their leader topology.
   */
  select(pairs: ReadonlyArray<readonly [string, string]>, labels: ReadonlyMap<string, DeclutterCandidate>): string[];
}

/** Greedy: repeatedly hide the lowest-priority (then most-colliding) label until no pair remains. */
export class PriorityDeclutter implements DeclutterStrategy {
  readonly kind = "priority";

  select(pairs: ReadonlyArray<readonly [string, string]>, labels: ReadonlyMap<string, DeclutterCandidate>): string[] {
    let remaining = pairs.slice();
    const hidden: string[] = [];
    while (remaining.length > 0) {
      const count = new Map<string, number>();
      for (const [a, b] of remaining) {
        count.set(a, (count.get(a) ?? 0) + 1);
        count.set(b, (count.get(b) ?? 0) + 1);
      }
      let worst: string | null = null;
      let worstKey: [number, number, string] | null = null;
      for (const [id, c] of count) {
        const p = labels.get(id)?.priority ?? 0;
        const key: [number, number, string] = [p, -c, id];
        if (!worstKey || compare(key, worstKey) < 0) {
          worst = id;
          worstKey = key;
        }
      }
      if (worst === null) break;
      hidden.push(worst);
      remaining = remaining.filter(([a, b]) => a !== worst && b !== worst);
    }
    return hidden;
  }
}

const compare = (a: [number, number, string], b: [number, number, string]): number =>
  a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
