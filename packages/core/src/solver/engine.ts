import { projectBillboard, type ProjectedBillboard } from "../billboard/billboard.js";
import type { BillboardFrame } from "../billboard/orienter.js";
import type { SpatialIndex2D } from "../collision/spatial-index.js";
import {
  containmentTranslation,
  inflate,
  minimumTranslation,
  overlapArea,
  rectInside,
  type Rect2,
} from "../geometry/rect2.js";
import { segmentsCross, type Segment2 } from "../geometry/segment2.js";
import { add, addScaled, clone, distance, dot, isFiniteVec3, length, normalize, scale, sub } from "../geometry/vec3.js";
import type { AnchorProvider } from "../anchors/anchor-provider.js";
import type { LayoutObserver, SolvePhase } from "../diagnostics/observer.js";
import type { LabelSnapshot, LayoutSnapshot, ViewSnapshot } from "../diagnostics/snapshot.js";
import {
  InvalidViewError,
  pixelDeltaToAxes,
  projectPoint,
  resolveView,
  type ProjectedPoint,
  type ResolvedView,
} from "../projection/view.js";
import { LeaderRouterRegistry } from "../routing/router.js";
import { TemporalStabilizer } from "../temporal/stabilizer.js";
import { diffTopology, LeaderGraph, TopologyError } from "../topology/leader-graph.js";
import type {
  EnergyBreakdown,
  HiddenReason,
  LabelAnchor,
  LabelLeader,
  LabelPlacement,
  LayoutContext,
  LayoutDiagnostic,
  LayoutResult,
  LeaderRouting,
  SpatialLabel,
  Vec2,
  Vec3,
  ViewMetrics,
} from "../types.js";
import { NoOcclusionProvider, type OcclusionProvider } from "../visibility/occlusion.js";
import { resolveSolverConfig, type SolverConfig, type SolverConfigInput } from "./config.js";
import { PriorityDeclutter } from "./declutter.js";

/** Public engine API (brief section 8). */
export interface LabelLayoutEngine {
  addLabel(label: SpatialLabel): void;
  removeLabel(id: string): void;
  updateLabel(id: string, patch: Partial<SpatialLabel>): void;
  setAnchorPosition(id: string, worldPosition: Vec3): void;
  solve(context: LayoutContext): LayoutResult;
  reset(): void;
  dispose(): void;
}

export interface EngineOptions extends SolverConfigInput {
  occlusion?: OcclusionProvider;
  observers?: LayoutObserver[];
  routers?: LeaderRouterRegistry;
}

interface LabelRecord {
  label: SpatialLabel;
  leader: LabelLeader;
  position: Vec3;
  /** True once the label has a position worth warm-starting from. */
  placed: boolean;
}

interface AnchorRecord {
  def?: LabelAnchor;
  world: Vec3 | null;
}

/** Per-solve working state of an active label. */
interface Work {
  rec: LabelRecord;
  id: string;
  anchorId: string;
  /** Real anchor (leader start). */
  anchor: Vec3;
  /** Attraction target for the leader-length pull (proxy when the pin is behind the camera). */
  pullTarget: Vec3;
  /** `pullTarget` projected in the reference view (fixed for the whole solve). */
  pullPx: ProjectedPoint;
  pos: Vec3;
  /** Motion-energy target: position at solve start, then the landing point of any discrete jump. */
  start: Vec3;
  /** Position at solve start (or initial placement); used for travelled-distance metrics only. */
  origin: Vec3;
  hadPlacement: boolean;
  /** Placed by candidate initialization during this solve: exempt from reorganization hysteresis. */
  fresh: boolean;
  mobility: number;
  frame: BillboardFrame;
}

/** Defect categories: leader crossing pair, residual collision, occlusion. */
type DefectKind = "crossing" | "collision" | "occlusion";

interface ReorgState {
  /** Consecutive solves in which each defect was observed. */
  streaks: Record<DefectKind, Map<string, number>>;
  /** Discrete fixes already attempted on a defect that is still present (drives exponential backoff). */
  failures: Map<string, number>;
  /** Clock time of the last attempt per defect. */
  lastAttempt: Map<string, number>;
  /** Clock time of each label's last discrete jump. */
  lastJump: Map<string, number>;
  /** A defect is waiting for its hysteresis: keep solving even if nothing moves. */
  pending: boolean;
}

const newReorgState = (): ReorgState => ({
  streaks: { crossing: new Map(), collision: new Map(), occlusion: new Map() },
  failures: new Map(),
  lastAttempt: new Map(),
  lastJump: new Map(),
  pending: false,
});

interface Evaluation {
  /** Label pairs overlapping in at least one view. */
  pairs: Array<[string, string]>;
  /** Pairs overlapping in some views but not all (stereo-only collisions). */
  stereoOnly: Array<[string, string]>;
  perView: ViewMetrics[];
  occluded: Set<string>;
  colliding: Set<string>;
  outOfView: Set<string>;
}

/** Relaxation iterations without improvement before handing over to the discrete repair. */
const STALL_ITERATIONS = 8;

const EMPTY_ENERGY: EnergyBreakdown = { overlap: 0, crossing: 0, motion: 0, occlusion: 0, depth: 0, total: 0 };

export class EngineDisposedError extends Error {
  constructor() {
    super("SpatialLabelLayoutEngine has been disposed");
    this.name = "EngineDisposedError";
  }
}

/**
 * Renderer-agnostic implementation of the brief's pipeline:
 * anchors -> views -> billboard projection -> candidate init -> projected
 * collision relaxation (multi-view) -> crossings / occlusion -> refinement ->
 * declutter fallback -> diagnostics.
 */
export class SpatialLabelLayoutEngine implements LabelLayoutEngine {
  private config: SolverConfig;
  private readonly records = new Map<string, LabelRecord>();
  private readonly anchors = new Map<string, AnchorRecord>();
  private readonly graph = new LeaderGraph();
  private readonly observers: LayoutObserver[];
  private readonly stabilizer: TemporalStabilizer;
  private occlusion: OcclusionProvider;
  private routers: LeaderRouterRegistry;
  private dirty = true;
  private lastResult: LayoutResult | null = null;
  private disposed = false;
  /** Accumulated `deltaTime` (s); drives reorganization cooldowns. */
  private clock = 0;
  /** Hysteresis state for discrete reorganizations (see TemporalConfig.reorganizeAfterSolves). */
  private reorg: ReorgState = newReorgState();

  constructor(options: EngineOptions = {}) {
    const { occlusion, observers, routers, ...config } = options;
    this.config = resolveSolverConfig(config);
    this.occlusion = occlusion ?? new NoOcclusionProvider();
    this.observers = [...(observers ?? [])];
    this.routers = routers ?? new LeaderRouterRegistry();
    this.stabilizer = new TemporalStabilizer(this.config.temporal);
  }

  // ---------------------------------------------------------------- configuration

  get settings(): Readonly<SolverConfig> {
    return this.config;
  }

  configure(input: SolverConfigInput): void {
    this.assertAlive();
    this.config = resolveSolverConfig(input, this.config);
    this.stabilizer.configure(this.config.temporal);
    this.dirty = true;
  }

  setOcclusionProvider(provider: OcclusionProvider | null): void {
    this.occlusion = provider ?? new NoOcclusionProvider();
    this.dirty = true;
  }

  setRouters(routers: LeaderRouterRegistry): void {
    this.routers = routers;
  }

  get leaderRouters(): LeaderRouterRegistry {
    return this.routers;
  }

  addObserver(o: LayoutObserver): void {
    this.observers.push(o);
  }

  removeObserver(o: LayoutObserver): void {
    const i = this.observers.indexOf(o);
    if (i >= 0) this.observers.splice(i, 1);
  }

  // ---------------------------------------------------------------- labels

  addLabel(label: SpatialLabel): void {
    this.assertAlive();
    if (this.records.has(label.id)) throw new Error(`label "${label.id}" already exists`);
    validateLabel(label);
    const copy: SpatialLabel = { ...label, position: clone(label.position), dimensions: { ...label.dimensions } };
    const leader = this.graph.add(label.id, label.anchorId, label.routing ?? this.config.defaultRouting);
    this.records.set(label.id, {
      label: copy,
      leader,
      position: clone(label.position),
      placed: this.config.initialization === "provided" && isFiniteVec3(label.position),
    });
    this.dirty = true;
  }

  removeLabel(id: string): void {
    this.assertAlive();
    if (!this.records.delete(id)) return;
    this.graph.remove(id);
    this.dirty = true;
  }

  updateLabel(id: string, patch: Partial<SpatialLabel>): void {
    this.assertAlive();
    const rec = this.records.get(id);
    if (!rec) throw new Error(`unknown label "${id}"`);
    if (patch.id !== undefined && patch.id !== id) throw new TopologyError(`label id is immutable ("${id}")`);
    if (patch.anchorId !== undefined && patch.anchorId !== rec.label.anchorId) {
      throw new TopologyError(`label "${id}": anchorId is immutable; remove and re-add the label to rebind it`);
    }
    const next: SpatialLabel = {
      ...rec.label,
      ...patch,
      position: patch.position ? clone(patch.position) : rec.label.position,
      dimensions: patch.dimensions ? { ...patch.dimensions } : rec.label.dimensions,
    };
    validateLabel(next);
    rec.label = next;
    if (patch.position) {
      rec.position = clone(patch.position);
      rec.placed = true;
    }
    if (patch.routing) this.graph.setRouting(id, patch.routing);
    const onlyPayload = Object.keys(patch).every((k) => k === "userData" || k === "routing");
    if (!onlyPayload) this.dirty = true;
  }

  getLabel(id: string): SpatialLabel | undefined {
    const r = this.records.get(id);
    return r ? { ...r.label, position: clone(r.position) } : undefined;
  }

  getLabels(): SpatialLabel[] {
    return [...this.records.values()].map((r) => ({ ...r.label, position: clone(r.position) }));
  }

  getLeaders(): LabelLeader[] {
    return this.graph.all();
  }

  getLeader(labelId: string): LabelLeader | undefined {
    const l = this.graph.get(labelId);
    return l ? { ...l } : undefined;
  }

  setLeaderRouting(labelId: string, routing: LeaderRouting): void {
    this.graph.setRouting(labelId, routing);
    const rec = this.records.get(labelId);
    if (rec) rec.label = { ...rec.label, routing };
  }

  // ---------------------------------------------------------------- anchors

  addAnchor(anchor: LabelAnchor): void {
    this.assertAlive();
    const prev = this.anchors.get(anchor.id);
    this.anchors.set(anchor.id, { def: { ...anchor, localPosition: clone(anchor.localPosition) }, world: prev?.world ?? null });
    this.dirty = true;
  }

  removeAnchor(id: string): void {
    this.assertAlive();
    if (this.anchors.delete(id)) this.dirty = true;
  }

  getAnchor(id: string): LabelAnchor | undefined {
    const d = this.anchors.get(id)?.def;
    return d ? { ...d } : undefined;
  }

  setAnchorPosition(id: string, worldPosition: Vec3): void {
    this.assertAlive();
    if (!isFiniteVec3(worldPosition)) throw new RangeError(`anchor "${id}": position must be finite`);
    let rec = this.anchors.get(id);
    if (!rec) this.anchors.set(id, (rec = { world: null }));
    if (!rec.world || distance(rec.world, worldPosition) > this.config.temporal.anchorMoveThreshold) this.dirty = true;
    rec.world = clone(worldPosition);
  }

  getAnchorPosition(id: string): Vec3 | null {
    const w = this.anchors.get(id)?.world;
    return w ? clone(w) : null;
  }

  /** Resolves every registered anchor definition through `provider`. Returns the number of anchors that moved. */
  updateAnchors(provider: AnchorProvider): number {
    this.assertAlive();
    provider.beginFrame?.();
    let moved = 0;
    for (const [id, rec] of this.anchors) {
      if (!rec.def) continue;
      if (rec.world && provider.hasChanged && !provider.hasChanged(rec.def)) continue;
      const p = provider.resolve(rec.def);
      if (!p) {
        if (rec.world) this.dirty = true;
        rec.world = null;
        continue;
      }
      const before = rec.world;
      this.setAnchorPosition(id, p);
      if (!before || distance(before, p) > this.config.temporal.anchorMoveThreshold) moved++;
    }
    return moved;
  }

  // ---------------------------------------------------------------- lifecycle

  get lastLayout(): LayoutResult | null {
    return this.lastResult;
  }

  getPlacement(id: string): LabelPlacement | undefined {
    return this.lastResult?.placements.find((p) => p.id === id);
  }

  /** Forgets solved positions: the next solve re-initializes every label from candidates. */
  reset(): void {
    this.assertAlive();
    for (const r of this.records.values()) r.placed = this.config.initialization === "provided";
    for (const r of this.records.values()) if (r.placed) r.position = clone(r.label.position);
    this.lastResult = null;
    this.stabilizer.reset();
    this.reorg = newReorgState();
    this.dirty = true;
  }

  dispose(): void {
    this.records.clear();
    this.anchors.clear();
    this.graph.clear();
    this.observers.length = 0;
    this.lastResult = null;
    this.disposed = true;
  }

  // ---------------------------------------------------------------- solve

  solve(context: LayoutContext): LayoutResult {
    this.assertAlive();
    const cfg = this.config;
    const t0 = cfg.now();
    for (const o of this.observers) o.onSolveStart?.(context);

    const messages: LayoutDiagnostic[] = [];
    if (context.views.length === 0) {
      messages.push({ code: "no-views", message: "LayoutContext.views is empty" });
      return this.finishEarly(t0, messages, "no-views");
    }

    let views: ResolvedView[];
    let ref: ResolvedView;
    try {
      views = context.views.map((v, i) => resolveView(v, i));
      ref = context.referenceView ? resolveView(context.referenceView, -1) : (views[0] as ResolvedView);
    } catch (e) {
      if (!(e instanceof InvalidViewError)) throw e;
      messages.push({ code: "invalid-view", message: e.message });
      return this.finishEarly(t0, messages, "invalid-view");
    }

    if (context.forceReset) this.reset();
    this.clock += Math.max(0, context.deltaTime);

    const decision = this.stabilizer.decide(ref, context.deltaTime, this.dirty, context.forceReset === true, this.reorg.pending);
    if (!decision.solve && this.lastResult) {
      const result = this.reuseLast(t0, decision.reason);
      for (const o of this.observers) o.onSolveEnd?.(result);
      return result;
    }

    const topologyBefore = this.graph.snapshot();
    const relaxViews = context.referenceView ? [ref, ...views] : views;
    this.occlusion.beginQueries?.(views);

    try {
      // 1. Classify labels, resolve anchors, apply the behind-camera policy.
      const hidden = new Map<string, HiddenReason>();
      const work: Work[] = [];
      for (const rec of this.records.values()) {
        const reason = this.classify(rec);
        if (reason) {
          hidden.set(rec.label.id, reason);
          if (reason === "missing-anchor") {
            messages.push({ code: "missing-anchor", message: `anchor "${rec.label.anchorId}" has no world position`, labelIds: [rec.label.id] });
          }
          continue;
        }
        const anchor = this.anchors.get(rec.label.anchorId)?.world as Vec3;
        const anchorDepth = dot(sub(anchor, ref.position), ref.forward);
        let pullTarget = anchor;
        if (anchorDepth <= 0) {
          if (cfg.behindCamera === "hide") {
            hidden.set(rec.label.id, "anchor-behind-camera");
            messages.push({ code: "anchor-behind-camera", message: `anchor "${rec.label.anchorId}" is behind the camera`, labelIds: [rec.label.id] });
            continue;
          }
          if (cfg.behindCamera === "reposition") pullTarget = this.behindCameraProxy(ref, anchor);
        }
        work.push({
          rec,
          id: rec.label.id,
          anchorId: rec.label.anchorId,
          anchor,
          pullTarget,
          pullPx: projectPoint(ref, pullTarget),
          pos: clone(rec.position),
          start: clone(rec.position),
          origin: clone(rec.position),
          hadPlacement: rec.placed,
          fresh: !rec.placed,
          mobility: 1 / (1 + Math.max(0, rec.label.priority)),
          frame: cfg.orienter.frame(rec.position, ref),
        });
      }

      // 2-3. Candidate initialization for new labels (and labels lost behind the camera).
      const initialized = this.initialize(work, ref, views);
      this.emitPhase("initialize", { initialized });

      // 4-5. Projected collision relaxation in every view, with warm start.
      let iterations = 0;
      const relax1 = this.relax(work, ref, relaxViews, cfg.maxIterations, "relax");
      iterations += relax1.iterations;

      // 6. Secondary objectives: crossings, then occlusions.
      const swaps = cfg.minimizeCrossings ? this.reduceCrossings(work, ref) : 0;
      this.emitPhase("crossings", { swaps });
      const relocations = cfg.avoidOcclusion ? this.avoidOcclusions(work, ref, views) : 0;
      this.emitPhase("occlusion", { relocations });
      let budgetHit = relax1.iterations >= cfg.maxIterations;
      if (swaps + relocations > 0) {
        const r2 = this.relax(work, ref, relaxViews, cfg.refinementIterations, "refine");
        iterations += r2.iterations;
        budgetHit = r2.iterations >= cfg.refinementIterations;
      }

      // Escape local minima of the continuous relaxation (label wedged between
      // a neighbour and a pin): discrete re-placement of the most mobile label
      // of each residual pair, then a short refinement (hybrid strategy, brief 4.2).
      // Gated by the reorganization hysteresis for already placed labels.
      let evaluation = this.evaluate(work, views, false);
      this.observeDefects("collision", new Set(evaluation.pairs.flat()));
      let repaired = false;
      for (let round = 0; round < cfg.repairRounds && evaluation.pairs.length > 0; round++) {
        const moved = this.repairCollisions(work, ref, views, evaluation.pairs);
        this.emitPhase("repair", { moved, round });
        if (moved === 0) break;
        repaired = true;
        const r3 = this.relax(work, ref, relaxViews, cfg.refinementIterations, "refine");
        iterations += r3.iterations;
        budgetHit = r3.iterations >= cfg.refinementIterations;
        evaluation = this.evaluate(work, views, false);
      }
      // Full metrics (crossings included) once the layout is final.
      evaluation = this.evaluate(work, views, true);

      // Fall back to decluttering when density is impossible.
      const budgetExhausted = budgetHit && evaluation.pairs.length > 0;
      if (evaluation.pairs.length > 0 && cfg.declutter.enabled) {
        const strategy = cfg.declutter.strategy ?? new PriorityDeclutter();
        const counts = new Map<string, number>();
        for (const [a, b] of evaluation.pairs) {
          counts.set(a, (counts.get(a) ?? 0) + 1);
          counts.set(b, (counts.get(b) ?? 0) + 1);
        }
        const candidates = new Map(
          work.map((w) => [w.id, { id: w.id, priority: w.rec.label.priority, collisions: counts.get(w.id) ?? 0 }] as const),
        );
        const toHide = new Set(strategy.select(evaluation.pairs, candidates));
        if (toHide.size > 0) {
          for (const id of toHide) hidden.set(id, "decluttered");
          messages.push({ code: "label-decluttered", message: `${toHide.size} label(s) hidden by ${strategy.kind} declutter`, labelIds: [...toHide] });
          const kept = work.filter((w) => !toHide.has(w.id));
          // Hidden labels keep their position for a smooth return.
          for (const w of work) if (toHide.has(w.id)) this.commit(w);
          work.length = 0;
          work.push(...kept);
          evaluation = this.evaluate(work, views);
        }
        this.emitPhase("declutter", { hidden: toHide.size });
      }

      // 7. Diagnostics and result.
      if (evaluation.pairs.length > 0) {
        messages.push({
          code: "unresolved-collision",
          message: `${evaluation.pairs.length} label pair(s) still overlap`,
          labelIds: [...new Set(evaluation.pairs.flat())],
        });
        if (budgetExhausted) messages.push({ code: "iteration-budget-exhausted", message: `iteration budget (${iterations}) exhausted` });
        if (this.densityImpossible(work, ref)) {
          messages.push({ code: "impossible-density", message: "total label area exceeds the usable viewport area" });
        }
      }
      if (evaluation.stereoOnly.length > 0) {
        messages.push({
          code: "stereo-only-collision",
          message: `${evaluation.stereoOnly.length} pair(s) overlap in one eye only`,
          labelIds: [...new Set(evaluation.stereoOnly.flat())],
        });
      }
      if (evaluation.outOfView.size > 0) {
        messages.push({ code: "label-out-of-view", message: `${evaluation.outOfView.size} label(s) outside the viewport`, labelIds: [...evaluation.outOfView] });
      }

      let travelled = 0;
      let motion = 0;
      for (const w of work) {
        if (w.hadPlacement) {
          const d = distance(w.pos, w.origin);
          travelled += d;
          motion += d * d;
        }
        this.commit(w);
      }

      const energy = this.energy(work, ref, evaluation, motion);
      const placements = this.buildPlacements(hidden, evaluation);
      const converged = evaluation.pairs.length === 0 && evaluation.outOfView.size === 0;

      const result: LayoutResult = {
        placements,
        converged,
        iterations,
        unresolvedCollisions: evaluation.pairs.length,
        unresolvedOcclusions: evaluation.occluded.size,
        computationTimeMs: cfg.now() - t0,
        diagnostics: {
          skipped: false,
          reason: decision.reason,
          perView: evaluation.perView,
          energy,
          distanceTravelled: travelled,
          collidingPairs: evaluation.pairs,
          hiddenLabels: [...hidden].map(([id, reason]) => ({ id, reason })),
          messages,
        },
      };

      if (cfg.validateTopology) {
        const violations = diffTopology(topologyBefore, this.graph.snapshot());
        if (violations.length > 0) throw new TopologyError(`leader topology changed during solve: ${JSON.stringify(violations)}`);
      }

      this.lastResult = result;
      this.dirty = false;
      this.reorg.pending = this.computePending();
      this.stabilizer.markSolved(ref);
      this.emitPhase("evaluate", { collisions: result.unresolvedCollisions, occlusions: result.unresolvedOcclusions, repaired: repaired ? 1 : 0 });
      for (const o of this.observers) o.onSolveEnd?.(result);
      return result;
    } finally {
      this.occlusion.endQueries?.();
    }
  }

  /**
   * Debug snapshot of the current state seen from each view of `context`
   * (no solving). Hidden reasons come from the last solve.
   */
  inspect(context: LayoutContext): LayoutSnapshot {
    this.assertAlive();
    const views = context.views.map((v, i) => resolveView(v, i));
    const ref = context.referenceView ? resolveView(context.referenceView, -1) : views[0];
    if (!ref) return { views: [] };
    const hiddenById = new Map((this.lastResult?.diagnostics?.hiddenLabels ?? []).map((h) => [h.id, h.reason] as const));
    const occludedById = new Set(this.lastResult?.placements.filter((p) => p.occluded).map((p) => p.id));

    const out: ViewSnapshot[] = [];
    for (const view of views) {
      const labels: LabelSnapshot[] = [];
      const rects: Array<Rect2 | null> = [];
      const segs: Array<{ id: string; s: Segment2[] }> = [];
      for (const rec of this.records.values()) {
        const anchorWorld = this.anchors.get(rec.label.anchorId)?.world ?? null;
        const reason = this.classify(rec) ?? hiddenById.get(rec.label.id);
        const frame = this.config.orienter.frame(rec.position, ref);
        const pb = projectBillboard(view, rec.position, frame, rec.label.dimensions);
        const ap = anchorWorld ? projectPoint(view, anchorWorld) : null;
        let leader: Vec2[] | null = null;
        if (anchorWorld) {
          const pts = this.routers.route({ leader: rec.leader, anchor: anchorWorld, labelCenter: rec.position, frame, size: rec.label.dimensions });
          const proj = pts.map((p) => projectPoint(view, p));
          leader = proj.every((p) => p.inFront) ? proj.map((p) => ({ x: p.x, y: p.y })) : null;
        }
        const visible = reason === undefined && rec.label.enabled && rec.label.visible;
        const snap: LabelSnapshot = {
          id: rec.label.id,
          anchorId: rec.label.anchorId,
          visible,
          priority: rec.label.priority,
          rect: pb.valid ? pb.rect : null,
          corners: pb.valid ? pb.corners : null,
          center: pb.valid ? pb.center : null,
          anchor: ap && ap.inFront ? { x: ap.x, y: ap.y } : null,
          leader,
          colliding: false,
          occluded: occludedById.has(rec.label.id),
          outOfView: !pb.valid || !rectInside(pb.rect, view.bounds, 1),
        };
        if (reason !== undefined) snap.hiddenReason = reason;
        labels.push(snap);
        rects.push(visible && pb.valid ? pb.rect : null);
        if (visible && leader) segs.push({ id: rec.label.id, s: toSegments(leader) });
      }
      const collidingPairs: Array<[string, string]> = [];
      const tol = this.config.collisionTolerancePx;
      const rectIndex = this.config.spatialIndex();
      rectIndex.clear();
      rects.forEach((r, i) => {
        if (r) rectIndex.insert(i, inflate(r, -tol / 2));
      });
      rectIndex.forEachOverlappingPair((i, j) => {
        collidingPairs.push([(labels[i] as LabelSnapshot).id, (labels[j] as LabelSnapshot).id]);
        (labels[i] as LabelSnapshot).colliding = true;
        (labels[j] as LabelSnapshot).colliding = true;
      });
      const crossingPairs: Array<[string, string]> = [];
      const segIndex = this.config.spatialIndex();
      segIndex.clear();
      segs.forEach((s, i) => segIndex.insert(i, polylineBounds(s.s)));
      segIndex.forEachOverlappingPair((i, j) => {
        const si = segs[i] as { id: string; s: Segment2[] };
        const sj = segs[j] as { id: string; s: Segment2[] };
        if (polylinesCross(si.s, sj.s)) crossingPairs.push([si.id, sj.id]);
      });
      const vs: ViewSnapshot = { viewIndex: view.index, viewport: view.viewport, labels, collidingPairs, crossingPairs };
      if (view.id !== undefined) vs.viewId = view.id;
      out.push(vs);
    }
    return { views: out };
  }

  // ================================================================ internals

  private assertAlive(): void {
    if (this.disposed) throw new EngineDisposedError();
  }

  private emitPhase(phase: SolvePhase, detail: Record<string, number>): void {
    for (const o of this.observers) o.onPhase?.(phase, detail);
  }

  private classify(rec: LabelRecord): HiddenReason | undefined {
    if (!rec.label.enabled) return "disabled";
    if (!rec.label.visible) return "user-hidden";
    const a = this.anchors.get(rec.label.anchorId)?.world;
    if (!a) return "missing-anchor";
    return undefined;
  }

  private commit(w: Work): void {
    w.rec.position = clone(w.pos);
    w.rec.placed = true;
  }

  /** A point in front of the camera, pushed toward the side where the hidden pin lies. */
  private behindCameraProxy(ref: ResolvedView, anchor: Vec3): Vec3 {
    const rel = sub(anchor, ref.position);
    const lateral = sub(rel, scale(ref.forward, dot(rel, ref.forward)));
    const dir = normalize(lateral, scale(ref.up, -1));
    const d = Math.max(this.config.depth.comfortRange.min, Math.min(length(rel), this.config.depth.comfortRange.max));
    return addScaled(addScaled(ref.position, ref.forward, d), dir, d * 2);
  }

  private targetDistance(w: Work, ref: ResolvedView, current: number): number {
    const d = this.config.depth;
    switch (d.mode) {
      case "surface-relative":
        return Math.max(1e-3, distance(w.pullTarget, ref.position) + d.surfaceOffset);
      case "comfort-depth":
        return Math.min(d.comfortRange.max, Math.max(d.comfortRange.min, current));
      default:
        return current;
    }
  }

  private applyDepthLimits(w: Work, ref: ResolvedView): void {
    const lim = this.config.depth.limits;
    if (!lim) return;
    const r = sub(w.pos, ref.position);
    const d = length(r);
    if (d < 1e-9) return;
    const c = Math.min(lim.max, Math.max(lim.min, d));
    if (c !== d) w.pos = addScaled(ref.position, r, c / d);
  }

  private isOccluded(p: Vec3, views: readonly ResolvedView[]): boolean {
    if (this.occlusion.strategy === "none" || views.length === 0) return false;
    if (this.config.occlusionMode === "all") return views.every((v) => this.occlusion.isOccluded(p, v.index));
    return views.some((v) => this.occlusion.isOccluded(p, v.index));
  }

  private obstacleRect(view: ResolvedView, p: Vec3): Rect2 | null {
    const ap = projectPoint(view, p);
    if (!ap.inFront) return null;
    const r = this.config.anchorRadiusPx;
    return { minX: ap.x - r, minY: ap.y - r, maxX: ap.x + r, maxY: ap.y + r };
  }

  /** Index of padded label rectangles (ref view) plus pin obstacles; rects[i] is the rectangle of id i. */
  private buildPlacementIndex(
    work: readonly Work[],
    ref: ResolvedView,
    include: (w: Work) => boolean,
  ): { index: SpatialIndex2D; rects: Rect2[]; insert: (r: Rect2) => number; ids: Map<Work, number> } {
    const cfg = this.config;
    const index: SpatialIndex2D = cfg.spatialIndex();
    index.clear();
    const rects: Rect2[] = [];
    const ids = new Map<Work, number>();
    const insert = (r: Rect2): number => {
      index.insert(rects.length, r);
      rects.push(r);
      return rects.length - 1;
    };
    for (const w of work) {
      if (!include(w)) continue;
      const pb = projectBillboard(ref, w.pos, w.frame, w.rec.label.dimensions);
      if (pb.valid) ids.set(w, insert(inflate(pb.rect, cfg.paddingPx / 2)));
    }
    if (cfg.avoidAnchors) {
      const seen = new Set<string>();
      for (const w of work) {
        if (seen.has(w.anchorId)) continue;
        seen.add(w.anchorId);
        const r = this.obstacleRect(ref, w.anchor);
        if (r) insert(r);
      }
    }
    return { index, rects, insert, ids };
  }

  /**
   * Cost of putting label `w` at `c` in the reference view: overlap with
   * indexed rectangles, area outside the viewport, occlusion, plus `bias`.
   * Returns null when the billboard is (partly) behind the camera.
   */
  private placementCost(
    w: Work,
    c: Vec3,
    ref: ResolvedView,
    views: readonly ResolvedView[],
    index: SpatialIndex2D,
    rects: readonly Rect2[],
    bias: number,
    bestSoFar: number,
    skip?: ReadonlySet<number>,
  ): { rect: Rect2; cost: number } | null {
    const cfg = this.config;
    const size = w.rec.label.dimensions;
    const pb = projectBillboard(ref, c, cfg.orienter.frame(c, ref), size);
    if (!pb.valid) return null;
    const r = inflate(pb.rect, cfg.paddingPx / 2);
    let cost = bias;
    index.query(r, (id) => {
      if (!skip?.has(id)) cost += overlapArea(r, rects[id] as Rect2) * cfg.weights.overlap;
    });
    const area = (pb.rect.maxX - pb.rect.minX) * (pb.rect.maxY - pb.rect.minY);
    if (cfg.keepInViewport) cost += (area - overlapArea(pb.rect, inflate(ref.bounds, -cfg.viewportMarginPx))) * cfg.weights.overlap * 2;
    if (cost < bestSoFar && cfg.avoidOcclusion && this.occlusion.strategy !== "none" && this.isOccluded(c, views)) {
      cost += area * cfg.weights.occlusion;
    }
    return { rect: r, cost };
  }

  private bestCandidate(
    w: Work,
    candidates: readonly Vec3[],
    ref: ResolvedView,
    views: readonly ResolvedView[],
    index: SpatialIndex2D,
    rects: readonly Rect2[],
    skip?: ReadonlySet<number>,
  ): { pos: Vec3; rect: Rect2; cost: number } | null {
    let best: { pos: Vec3; rect: Rect2; cost: number } | null = null;
    for (let k = 0; k < candidates.length; k++) {
      const c = candidates[k] as Vec3;
      const scored = this.placementCost(w, c, ref, views, index, rects, k * 1e-3, best?.cost ?? Infinity, skip);
      if (!scored) continue;
      if (!best || scored.cost < best.cost) best = { pos: c, ...scored };
      if (best.cost < 1e-2) break;
    }
    return best;
  }

  private generateCandidates(w: Work, ref: ResolvedView, lengthScales: readonly number[]): Vec3[] {
    const cfg = this.config;
    const frame = cfg.orienter.frame(w.pullTarget, ref);
    const out: Vec3[] = [];
    for (const s of lengthScales) {
      out.push(
        ...cfg.candidates.generate({
          label: w.rec.label,
          anchor: w.pullTarget,
          view: ref,
          frame,
          size: w.rec.label.dimensions,
          leaderLengthPx: cfg.leaderLengthPx * s,
        }),
      );
    }
    return out;
  }

  /** Scores candidate positions and places labels without a usable warm start. */
  private initialize(work: Work[], ref: ResolvedView, views: readonly ResolvedView[]): number {
    const cfg = this.config;
    const pending: Work[] = [];
    for (const w of work) {
      const pb = w.hadPlacement ? projectBillboard(ref, w.pos, w.frame, w.rec.label.dimensions) : null;
      if (!pb || !pb.valid) pending.push(w);
    }
    if (pending.length === 0) return 0;
    const isPending = new Set(pending);
    const { index, rects, insert } = this.buildPlacementIndex(work, ref, (w) => !isPending.has(w));
    pending.sort((a, b) => b.rec.label.priority - a.rec.label.priority || (a.id < b.id ? -1 : 1));

    for (const w of pending) {
      const best = this.bestCandidate(w, this.generateCandidates(w, ref, [1]), ref, views, index, rects);
      if (best) {
        w.pos = best.pos;
        insert(best.rect);
      } else {
        w.pos = addScaled(w.pullTarget, cfg.orienter.frame(w.pullTarget, ref).up, w.rec.label.dimensions.height);
      }
      w.start = clone(w.pos);
      w.origin = clone(w.pos);
      w.fresh = true;
      w.frame = cfg.orienter.frame(w.pos, ref);
    }
    return pending.length;
  }

  /**
   * Re-places the most mobile label of each residual pair at the best
   * candidate (wider rings than initialization), when that lowers its cost.
   */
  private repairCollisions(work: Work[], ref: ResolvedView, views: readonly ResolvedView[], pairs: ReadonlyArray<readonly [string, string]>): number {
    const byId = new Map(work.map((w) => [w.id, w] as const));
    const movers = new Set<Work>();
    for (const [a, b] of pairs) {
      const wa = byId.get(a), wb = byId.get(b);
      if (!wa || !wb || movers.has(wa) || movers.has(wb)) continue;
      const pick = wa.mobility > wb.mobility ? wa : wb.mobility > wa.mobility ? wb : wa.id > wb.id ? wa : wb;
      if (this.mayReorganize("collision", pick.id, [pick])) movers.add(pick);
    }
    if (movers.size === 0) return 0;
    // One index per round; a mover's stale rectangle is skipped and its new one appended.
    const { index, rects, insert, ids } = this.buildPlacementIndex(work, ref, () => true);
    const skip = new Set<number>();
    let moved = 0;
    for (const w of movers) {
      const own = ids.get(w);
      if (own !== undefined) skip.add(own);
      const current = this.placementCost(w, w.pos, ref, views, index, rects, 0, Infinity, skip);
      const best = this.bestCandidate(w, this.generateCandidates(w, ref, [1, 2.5, 4, 6]), ref, views, index, rects, skip);
      if (best && (!current || best.cost < current.cost - 1e-6)) {
        w.pos = best.pos;
        w.frame = this.config.orienter.frame(w.pos, ref);
        insert(best.rect);
        this.markJumped("collision", w.id, [w]);
        moved++;
      } else if (current) {
        insert(current.rect);
      }
    }
    return moved;
  }

  // ---------------------------------------------------------------- reorganization hysteresis

  /**
   * Records the defects observed in this solve. A defect absent from `keys`
   * loses its streak and its retry backoff (it was fixed or went away).
   */
  private observeDefects(kind: DefectKind, keys: Iterable<string>): void {
    const prev = this.reorg.streaks[kind];
    const next = new Map<string, number>();
    for (const k of keys) next.set(k, (prev.get(k) ?? 0) + 1);
    for (const k of prev.keys()) {
      if (!next.has(k)) {
        this.reorg.failures.delete(`${kind}:${k}`);
        this.reorg.lastAttempt.delete(`${kind}:${k}`);
      }
    }
    this.reorg.streaks[kind] = next;
  }

  /**
   * Gate for discrete jumps of already placed labels (brief section 7: no
   * reorganization on every small head motion). Fresh labels are exempt.
   * A defect must persist `reorganizeAfterSolves` solves; each label waits
   * `reorganizeCooldown` between jumps; and a defect that survived earlier
   * attempts backs off exponentially (cooldown x 2^attempts), so an
   * unfixable defect cannot make a label jump forever.
   */
  private mayReorganize(kind: DefectKind, key: string, labels: readonly Work[]): boolean {
    const t = this.config.temporal;
    if (!t.enabled) return true;
    const placed = labels.filter((w) => !w.fresh);
    if (placed.length === 0) return true;
    if ((this.reorg.streaks[kind].get(key) ?? 0) < t.reorganizeAfterSolves) return false;
    const defect = `${kind}:${key}`;
    const failures = this.reorg.failures.get(defect) ?? 0;
    if (failures > 0 && this.clock - (this.reorg.lastAttempt.get(defect) ?? -Infinity) < t.reorganizeCooldown * 2 ** failures) return false;
    return placed.every((w) => this.clock - (this.reorg.lastJump.get(w.id) ?? -Infinity) >= t.reorganizeCooldown);
  }

  private markJumped(kind: DefectKind, key: string, labels: readonly Work[]): void {
    const defect = `${kind}:${key}`;
    this.reorg.failures.set(defect, (this.reorg.failures.get(defect) ?? 0) + 1);
    this.reorg.lastAttempt.set(defect, this.clock);
    for (const w of labels) {
      if (!w.fresh) this.reorg.lastJump.set(w.id, this.clock);
      // The motion term must hold the label at its new place, not pull it back to where the defect was.
      w.start = clone(w.pos);
    }
  }

  /** True when some defect is still building its streak: keep solving even if nothing moves. */
  private computePending(): boolean {
    const t = this.config.temporal;
    if (!t.enabled) return false;
    for (const kind of ["crossing", "collision", "occlusion"] as const) {
      for (const streak of this.reorg.streaks[kind].values()) if (streak < t.reorganizeAfterSolves) return true;
    }
    return false;
  }

  /**
   * Iterative projection solver. Each iteration applies annealed soft forces
   * (leader length, motion, depth) and then projects hard constraints
   * (pairwise separation, pin avoidance, viewport containment) in every view;
   * corrections from several views are averaged per label.
   */
  private relax(work: Work[], ref: ResolvedView, views: readonly ResolvedView[], budget: number, phase: SolvePhase): { iterations: number; collisions: number } {
    const cfg = this.config;
    const n = work.length;
    if (n === 0 || budget <= 0) return { iterations: 0, collisions: 0 };
    const pad = cfg.paddingPx / 2;
    const acc = new Float64Array(n * 3);
    const cnt = new Uint16Array(n);
    const pxd = new Float64Array(n * 2);
    const touched = new Uint8Array(n);
    const rects: Array<Rect2 | null> = new Array(n);
    const projections: Array<ProjectedBillboard | null> = new Array(n);
    const tol = cfg.collisionTolerancePx;
    let lastCollisions = 0;
    let bestResidual = Infinity;
    let stall = 0;
    let it = 0;

    for (; it < budget; it++) {
      const gain = 1 - it / budget;
      let maxStepPx = 0;

      // Soft forces (annealed so that constraints dominate the final iterations).
      for (const w of work) {
        const pb = projectBillboard(ref, w.pos, w.frame, w.rec.label.dimensions);
        const delta = this.softDelta(w, ref, gain, pb);
        if (delta) {
          w.pos = add(w.pos, delta);
          const j = pb.jacobian;
          if (j) {
            // Linearized pixel step (depth component ignored).
            const du = dot(delta, w.frame.right), dv = dot(delta, w.frame.up);
            maxStepPx = Math.max(maxStepPx, Math.hypot(j.a * du + j.b * dv, j.c * du + j.d * dv));
          }
        }
        this.applyDepthLimits(w, ref);
        w.frame = cfg.orienter.frame(w.pos, ref);
      }

      // Hard constraints in each view.
      acc.fill(0);
      cnt.fill(0);
      let collisions = 0;
      let violations = 0;
      for (const view of views) {
        pxd.fill(0);
        touched.fill(0);
        const index = cfg.spatialIndex();
        index.clear();
        for (let i = 0; i < n; i++) {
          const w = work[i] as Work;
          const pb = projectBillboard(view, w.pos, w.frame, w.rec.label.dimensions);
          projections[i] = pb;
          rects[i] = pb.valid ? inflate(pb.rect, pad) : null;
          if (rects[i]) index.insert(i, rects[i] as Rect2);
        }
        const obstacles: Rect2[] = [];
        if (cfg.avoidAnchors) {
          const seen = new Set<string>();
          for (const w of work) {
            if (seen.has(w.anchorId)) continue;
            seen.add(w.anchorId);
            const r = this.obstacleRect(view, w.anchor);
            if (r) {
              index.insert(n + obstacles.length, r);
              obstacles.push(r);
            }
          }
        }
        index.forEachOverlappingPair((a, b) => {
          if (a >= n) return; // obstacle-obstacle
          const ra = rects[a] as Rect2;
          if (b >= n) {
            const t = minimumTranslation(ra, obstacles[b - n] as Rect2);
            if (!t) return;
            bump(pxd, a * 2, t.x);
            bump(pxd, a * 2 + 1, t.y);
            touched[a] = 1;
            if (Math.abs(t.x) + Math.abs(t.y) > pad + tol) violations++;
            return;
          }
          const t = minimumTranslation(ra, rects[b] as Rect2);
          if (!t) return;
          // Intrusions into the padding band are corrected (visual gap) but only real
          // overlaps beyond tolerance block convergence, as in the final evaluation.
          if (Math.abs(t.x) + Math.abs(t.y) > 2 * pad + tol) collisions++;
          const wa = (work[a] as Work).mobility;
          const wb = (work[b] as Work).mobility;
          const sa = wa / (wa + wb);
          bump(pxd, a * 2, t.x * sa);
          bump(pxd, a * 2 + 1, t.y * sa);
          bump(pxd, b * 2, -t.x * (1 - sa));
          bump(pxd, b * 2 + 1, -t.y * (1 - sa));
          touched[a] = 1;
          touched[b] = 1;
        });
        if (cfg.keepInViewport) {
          const inset = inflate(view.bounds, -cfg.viewportMarginPx);
          for (let i = 0; i < n; i++) {
            const pb = projections[i];
            if (!pb || !pb.valid) continue;
            const t = containmentTranslation(pb.rect, inset);
            if (t.x !== 0 || t.y !== 0) {
              bump(pxd, i * 2, t.x);
              bump(pxd, i * 2 + 1, t.y);
              touched[i] = 1;
              if (Math.abs(t.x) + Math.abs(t.y) > tol) violations++;
            }
          }
        }
        for (let i = 0; i < n; i++) {
          if (!touched[i]) continue;
          const w = work[i] as Work;
          const d = { x: pxd[i * 2] as number, y: pxd[i * 2 + 1] as number };
          maxStepPx = Math.max(maxStepPx, Math.hypot(d.x, d.y) * cfg.relaxation);
          const j = projections[i]?.jacobian;
          const ax = j ? pixelDeltaToAxes(j, d) : null;
          if (!ax) continue;
          bump(acc, i * 3, w.frame.right.x * ax.x + w.frame.up.x * ax.y);
          bump(acc, i * 3 + 1, w.frame.right.y * ax.x + w.frame.up.y * ax.y);
          bump(acc, i * 3 + 2, w.frame.right.z * ax.x + w.frame.up.z * ax.y);
          bump(cnt, i, 1);
        }
      }
      for (let i = 0; i < n; i++) {
        const c = cnt[i] as number;
        if (c === 0) continue;
        const w = work[i] as Work;
        const k = cfg.relaxation / c;
        w.pos = { x: w.pos.x + (acc[i * 3] as number) * k, y: w.pos.y + (acc[i * 3 + 1] as number) * k, z: w.pos.z + (acc[i * 3 + 2] as number) * k };
        this.applyDepthLimits(w, ref);
        w.frame = cfg.orienter.frame(w.pos, ref);
      }
      lastCollisions = collisions;
      for (const o of this.observers) o.onIteration?.({ phase, iteration: it, collisions, violations, maxStepPx });
      // Stop on collision threshold (constraints satisfied), small motion, or stagnation (brief 4.2).
      const residual = collisions + violations;
      if (residual === 0) {
        it++;
        break;
      }
      if (residual < bestResidual) {
        bestResidual = residual;
        stall = 0;
      } else if (++stall >= STALL_ITERATIONS && maxStepPx < cfg.convergenceTolerancePx * 8) {
        // Local minimum (no progress, small steps): leave it to the discrete repair phase.
        // Oscillating states (large steps) keep relaxing: cutting them early was measured
        // to triple residual collisions in dense scenes.
        it++;
        break;
      }
    }
    return { iterations: it, collisions: lastCollisions };
  }

  private softDelta(w: Work, ref: ResolvedView, gain: number, pb: ProjectedBillboard): Vec3 | null {
    const cfg = this.config;
    const wt = cfg.weights;
    let delta: Vec3 = { x: 0, y: 0, z: 0 };
    let any = false;

    if (wt.anchorPull > 0) {
      const pa = w.pullPx;
      const j = pb.jacobian;
      if (pa.inFront && j) {
        const vx = pb.center.x - pa.x;
        const vy = pb.center.y - pa.y;
        const d = Math.hypot(vx, vy);
        if (d > 1e-6) {
          const hw = Math.hypot(j.a, j.c) * (w.rec.label.dimensions.width / 2);
          const hh = Math.hypot(j.b, j.d) * (w.rec.label.dimensions.height / 2);
          const ux = vx / d, uy = vy / d;
          const border = Math.min(Math.abs(ux) > 1e-9 ? hw / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? hh / Math.abs(uy) : Infinity);
          const excess = d - (cfg.leaderLengthPx + border);
          if (excess > 0) {
            const k = Math.min(1, wt.anchorPull * gain * 0.5);
            const ax = pixelDeltaToAxes(j, { x: -ux * excess * k, y: -uy * excess * k });
            if (ax) {
              delta = addScaled(addScaled(delta, w.frame.right, ax.x), w.frame.up, ax.y);
              any = true;
            }
          }
        }
      }
    }

    if (wt.motion > 0 && w.hadPlacement) {
      delta = addScaled(delta, sub(w.start, w.pos), Math.min(1, wt.motion * gain * 0.25));
      any = true;
    }

    if (wt.depth > 0 && cfg.depth.mode !== "free") {
      const r = sub(w.pos, ref.position);
      const d = length(r);
      if (d > 1e-9) {
        const target = this.targetDistance(w, ref, d);
        delta = addScaled(delta, r, ((target - d) / d) * Math.min(1, wt.depth * gain * 0.5));
        any = true;
      }
    }
    return any ? delta : null;
  }

  private leaderSegments(w: Work, view: ResolvedView): Segment2[] | null {
    const pts = this.routers.route({
      leader: w.rec.leader,
      anchor: w.anchor,
      labelCenter: w.pos,
      frame: w.frame,
      size: w.rec.label.dimensions,
    });
    const proj = pts.map((p) => projectPoint(view, p));
    if (!proj.every((p) => p.inFront)) return null;
    return toSegments(proj.map((p) => ({ x: p.x, y: p.y })));
  }

  /** Swaps positions of labels whose leaders cross when that uncrosses them (topology untouched). */
  private reduceCrossings(work: Work[], ref: ResolvedView): number {
    const cfg = this.config;
    let swaps = 0;
    const pairs = this.crossingPairs(work, ref);
    const keyOf = (a: Work, b: Work): string => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
    this.observeDefects("crossing", pairs.map(([i, j]) => keyOf(work[i] as Work, work[j] as Work)));
    const swapped = new Set<number>();
    for (const [i, j] of pairs) {
      if (swaps >= cfg.maxSwapsPerSolve) break;
      if (swapped.has(i) || swapped.has(j)) continue;
      const a = work[i] as Work;
      const b = work[j] as Work;
      if (a.anchorId === b.anchorId) continue;
      const key = keyOf(a, b);
      if (!this.mayReorganize("crossing", key, [a, b])) continue;
      const pa = projectPoint(ref, a.anchor), pb = projectPoint(ref, b.anchor);
      const ca = projectPoint(ref, a.pos), cb = projectPoint(ref, b.pos);
      if (!pa.inFront || !pb.inFront || !ca.inFront || !cb.inFront) continue;
      const before = Math.hypot(ca.x - pa.x, ca.y - pa.y) + Math.hypot(cb.x - pb.x, cb.y - pb.y);
      const after = Math.hypot(cb.x - pa.x, cb.y - pa.y) + Math.hypot(ca.x - pb.x, ca.y - pb.y);
      const stillCross = segmentsCross({ a: pa, b: cb }, { a: pb, b: ca });
      if (stillCross || after > before * 1.25 + 1) continue;
      const tmp = a.pos;
      a.pos = b.pos;
      b.pos = tmp;
      a.frame = cfg.orienter.frame(a.pos, ref);
      b.frame = cfg.orienter.frame(b.pos, ref);
      this.markJumped("crossing", key, [a, b]);
      swapped.add(i);
      swapped.add(j);
      swaps++;
    }
    return swaps;
  }

  private crossingPairs(work: Work[], view: ResolvedView): Array<[number, number]> {
    const segs = work.map((w) => this.leaderSegments(w, view));
    const index = this.config.spatialIndex();
    index.clear();
    segs.forEach((s, i) => {
      if (s) index.insert(i, polylineBounds(s));
    });
    const out: Array<[number, number]> = [];
    index.forEachOverlappingPair((i, j) => {
      const si = segs[i], sj = segs[j];
      if (si && sj && polylinesCross(si, sj)) out.push([i, j]);
    });
    return out;
  }

  /** Moves occluded labels to the best visible candidate around their pin. */
  private avoidOcclusions(work: Work[], ref: ResolvedView, views: readonly ResolvedView[]): number {
    const cfg = this.config;
    if (this.occlusion.strategy === "none") return 0;
    const occluded = work.filter((w) => this.isOccluded(w.pos, views));
    this.observeDefects("occlusion", occluded.map((w) => w.id));
    const movers = occluded.filter((w) => this.mayReorganize("occlusion", w.id, [w])).slice(0, cfg.maxOcclusionRelocations);
    if (movers.length === 0) return 0;
    const { index, rects, insert, ids } = this.buildPlacementIndex(work, ref, () => true);
    const skip = new Set<number>();
    let moved = 0;
    for (const w of movers) {
      const own = ids.get(w);
      if (own !== undefined) skip.add(own);
      let best: { pos: Vec3; rect: Rect2; cost: number } | null = null;
      const candidates = this.generateCandidates(w, ref, [1, 2]);
      for (let k = 0; k < candidates.length; k++) {
        const c = candidates[k] as Vec3;
        const scored = this.placementCost(w, c, ref, [], index, rects, distance(c, w.pos) * 1e-3, best?.cost ?? Infinity, skip);
        if (!scored || (best && scored.cost >= best.cost)) continue;
        if (this.isOccluded(c, views)) continue;
        best = { pos: c, ...scored };
      }
      if (best) {
        w.pos = best.pos;
        w.frame = cfg.orienter.frame(w.pos, ref);
        insert(best.rect);
        this.markJumped("occlusion", w.id, [w]);
        moved++;
      }
    }
    return moved;
  }

  private evaluate(work: Work[], views: readonly ResolvedView[], withCrossings = true): Evaluation {
    const cfg = this.config;
    const tol = cfg.collisionTolerancePx;
    const pairKeys = new Map<string, [string, string]>();
    const pairViews = new Map<string, Set<number>>();
    const occluded = new Set<string>();
    const colliding = new Set<string>();
    const outOfView = new Set<string>();
    const perView: ViewMetrics[] = [];

    const occludedIn = new Map<string, number>();
    const checkOcclusion = this.occlusion.strategy !== "none";

    for (const view of views) {
      const index = cfg.spatialIndex();
      index.clear();
      let out = 0;
      let occ = 0;
      for (let i = 0; i < work.length; i++) {
        const w = work[i] as Work;
        const pb = projectBillboard(view, w.pos, w.frame, w.rec.label.dimensions);
        if (pb.valid) index.insert(i, inflate(pb.rect, -tol / 2));
        if (!pb.valid || !rectInside(pb.rect, view.bounds, 1)) {
          out++;
          outOfView.add(w.id);
        }
        if (checkOcclusion && this.occlusion.isOccluded(w.pos, view.index)) {
          occ++;
          occludedIn.set(w.id, (occludedIn.get(w.id) ?? 0) + 1);
        }
      }
      let collisions = 0;
      index.forEachOverlappingPair((i, j) => {
        const a = (work[i] as Work).id;
        const b = (work[j] as Work).id;
        const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
        if (!pairKeys.has(key)) pairKeys.set(key, a < b ? [a, b] : [b, a]);
        let s = pairViews.get(key);
        if (!s) pairViews.set(key, (s = new Set()));
        s.add(view.index);
        colliding.add(a);
        colliding.add(b);
        collisions++;
      });
      const crossings = withCrossings ? this.crossingPairs(work, view).length : 0;
      const m: ViewMetrics = { viewIndex: view.index, collisions, occlusions: occ, crossings, outOfView: out };
      if (view.id !== undefined) m.viewId = view.id;
      perView.push(m);
    }
    for (const [id, c] of occludedIn) {
      if (cfg.occlusionMode === "any" ? c > 0 : c === views.length) occluded.add(id);
    }
    const stereoOnly: Array<[string, string]> = [];
    if (views.length > 1) {
      for (const [key, s] of pairViews) if (s.size < views.length) stereoOnly.push(pairKeys.get(key) as [string, string]);
    }
    return { pairs: [...pairKeys.values()], stereoOnly, perView, occluded, colliding, outOfView };
  }

  private energy(work: Work[], ref: ResolvedView, ev: Evaluation, motion: number): EnergyBreakdown {
    const wt = this.config.weights;
    const overlap = ev.perView.reduce((s, v) => s + v.collisions, 0);
    const crossing = ev.perView[0]?.crossings ?? 0;
    const occlusion = ev.occluded.size;
    let depth = 0;
    if (this.config.depth.mode !== "free") {
      for (const w of work) {
        const d = distance(w.pos, ref.position);
        const t = this.targetDistance(w, ref, d);
        depth += ((d - t) / Math.max(t, 1e-6)) ** 2;
      }
    }
    const total = wt.overlap * overlap + wt.crossing * crossing + wt.motion * motion + wt.occlusion * occlusion + wt.depth * depth;
    return { overlap, crossing, motion, occlusion, depth, total };
  }

  private buildPlacements(hidden: Map<string, HiddenReason>, ev: Evaluation): LabelPlacement[] {
    const out: LabelPlacement[] = [];
    for (const rec of this.records.values()) {
      const id = rec.label.id;
      const reason = hidden.get(id);
      const p: LabelPlacement = {
        id,
        position: clone(rec.position),
        visible: reason === undefined,
        anchorId: rec.label.anchorId,
        anchorPosition: this.anchors.get(rec.label.anchorId)?.world ?? null,
        occluded: ev.occluded.has(id),
        colliding: ev.colliding.has(id),
      };
      if (reason !== undefined) p.hiddenReason = reason;
      out.push(p);
    }
    return out;
  }

  private densityImpossible(work: Work[], ref: ResolvedView): boolean {
    let area = 0;
    for (const w of work) {
      const pb = projectBillboard(ref, w.pos, w.frame, w.rec.label.dimensions);
      if (pb.valid) area += (pb.rect.maxX - pb.rect.minX + this.config.paddingPx) * (pb.rect.maxY - pb.rect.minY + this.config.paddingPx);
    }
    const m = this.config.viewportMarginPx * 2;
    return area > Math.max(0, ref.viewport.width - m) * Math.max(0, ref.viewport.height - m);
  }

  private reuseLast(t0: number, reason: string): LayoutResult {
    const last = this.lastResult as LayoutResult;
    const diagnostics = last.diagnostics
      ? { ...last.diagnostics, skipped: true, reason, distanceTravelled: 0 }
      : undefined;
    const result: LayoutResult = {
      ...last,
      placements: last.placements.map((p) => ({ ...p, position: clone(p.position) })),
      iterations: 0,
      computationTimeMs: this.config.now() - t0,
    };
    if (diagnostics) result.diagnostics = diagnostics;
    return result;
  }

  private finishEarly(t0: number, messages: LayoutDiagnostic[], reason: string): LayoutResult {
    const hidden = new Map<string, HiddenReason>();
    for (const rec of this.records.values()) hidden.set(rec.label.id, this.classify(rec) ?? "out-of-view");
    const placements: LabelPlacement[] = [...this.records.values()].map((rec) => ({
      id: rec.label.id,
      position: clone(rec.position),
      visible: false,
      anchorId: rec.label.anchorId,
      hiddenReason: hidden.get(rec.label.id) as HiddenReason,
    }));
    const result: LayoutResult = {
      placements,
      converged: false,
      iterations: 0,
      unresolvedCollisions: 0,
      unresolvedOcclusions: 0,
      computationTimeMs: this.config.now() - t0,
      diagnostics: {
        skipped: false,
        reason,
        perView: [],
        energy: { ...EMPTY_ENERGY },
        distanceTravelled: 0,
        collidingPairs: [],
        hiddenLabels: [...hidden].map(([id, r]) => ({ id, reason: r })),
        messages,
      },
    };
    for (const o of this.observers) o.onSolveEnd?.(result);
    return result;
  }
}

/** arr[i] += v, typed for `noUncheckedIndexedAccess`. */
const bump = (arr: Float64Array | Uint16Array, i: number, v: number): void => {
  arr[i] = (arr[i] ?? 0) + v;
};

const toSegments = (pts: readonly Vec2[]): Segment2[] => {
  const out: Segment2[] = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push({ a: pts[i] as Vec2, b: pts[i + 1] as Vec2 });
  return out;
};

/** Bounds of a projected leader, inflated by half a pixel so touching boxes still meet. */
const polylineBounds = (segs: readonly Segment2[]): Rect2 => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const seg of segs) {
    minX = Math.min(minX, seg.a.x, seg.b.x);
    minY = Math.min(minY, seg.a.y, seg.b.y);
    maxX = Math.max(maxX, seg.a.x, seg.b.x);
    maxY = Math.max(maxY, seg.a.y, seg.b.y);
  }
  return { minX: minX - 0.5, minY: minY - 0.5, maxX: maxX + 0.5, maxY: maxY + 0.5 };
};

const polylinesCross = (a: readonly Segment2[], b: readonly Segment2[]): boolean => {
  for (const s of a) for (const t of b) if (segmentsCross(s, t)) return true;
  return false;
};

const validateLabel = (label: SpatialLabel): void => {
  if (typeof label.id !== "string" || label.id.length === 0) throw new TypeError("label.id must be a non-empty string");
  if (typeof label.anchorId !== "string" || label.anchorId.length === 0) throw new TypeError(`label "${label.id}": anchorId must be a non-empty string`);
  const { width, height } = label.dimensions;
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
    throw new RangeError(`label "${label.id}": dimensions must be positive and finite`);
  }
  if (!Number.isFinite(label.priority)) throw new RangeError(`label "${label.id}": priority must be finite`);
};
