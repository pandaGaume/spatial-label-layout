import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { worldUnitsPerPixel, type LabelLeader, type LeaderRenderer, type ResolvedView, type Vec3 } from "@spacexr/spatial-label-layout-core";

export interface BabylonLeaderRendererOptions {
  /** Width of a leader (default 1.5), in the unit of `widthUnit`. */
  width?: number;
  /**
   * - "screen" (default when `view` is given): pixels, whatever the distance.
   * - "world": world units.
   */
  widthUnit?: "screen" | "world";
  /** Reference view of the frame, needed for widths in pixels: pass `() => controller.view`. */
  view?: () => ResolvedView | null;
  /** Material of a leader. Default: one unlit white material shared by all leaders. */
  material?(leader: Readonly<LabelLeader>): Material;
  /** Applied once to every segment mesh: rendering group, pickability, metadata... */
  configure?(mesh: Mesh, leader: Readonly<LabelLeader>): void;
}

interface LeaderEntry {
  leader: Readonly<LabelLeader>;
  material: Material;
  segments: Mesh[];
}

const DIRECTION = new Vector3();

/**
 * Leader port for Babylon.js (brief: BabylonLeaderRenderer).
 *
 * A leader is a polyline in the world, pin first. Each of its segments is a
 * thin cylinder stretched between two points: unlike GL lines it has a width,
 * which can be held in pixels, and it needs no vertex buffer update per frame.
 */
export class BabylonLeaderRenderer implements LeaderRenderer {
  private readonly leaders = new Map<string, LeaderEntry>();
  private shared: Material | null = null;
  private readonly width: number;
  private readonly screen: boolean;

  constructor(
    private readonly scene: Scene,
    private readonly options: BabylonLeaderRendererOptions = {},
  ) {
    this.width = options.width ?? 1.5;
    this.screen = (options.widthUnit ?? (options.view ? "screen" : "world")) === "screen";
    if (this.screen && !options.view) throw new Error("BabylonLeaderRenderer: a width in pixels needs the `view` option");
  }

  /** The segment meshes of a leader, pin side first. */
  get(id: string): readonly Mesh[] | undefined {
    return this.leaders.get(id)?.segments;
  }

  createLeader(leader: Readonly<LabelLeader>): void {
    this.removeLeader(leader.id);
    this.leaders.set(leader.id, { leader, material: this.options.material?.(leader) ?? this.sharedMaterial(), segments: [] });
  }

  updateLeader(id: string, points: readonly Vec3[], visible: boolean): void {
    const entry = this.leaders.get(id);
    if (!entry) return;
    const count = visible ? Math.max(0, points.length - 1) : 0;
    while (entry.segments.length < count) entry.segments.push(this.segment(entry));
    const view = this.screen ? this.options.view?.() : null;
    entry.segments.forEach((mesh, i) => {
      const from = points[i];
      const to = points[i + 1];
      const length = i < count && from && to ? Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) : 0;
      let width = this.width;
      if (this.screen && from && to) width *= view ? worldUnitsPerPixel(view, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 }) : 0;
      const shown = length > 0 && width > 0;
      mesh.setEnabled(shown);
      if (!shown || !from || !to) return;
      mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
      DIRECTION.set((to.x - from.x) / length, (to.y - from.y) / length, (to.z - from.z) / length);
      Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, DIRECTION, mesh.rotationQuaternion as Quaternion);
      mesh.scaling.set(width, length, width);
    });
  }

  removeLeader(id: string): void {
    const entry = this.leaders.get(id);
    if (!entry) return;
    this.leaders.delete(id);
    for (const mesh of entry.segments) mesh.dispose();
  }

  dispose(): void {
    for (const id of [...this.leaders.keys()]) this.removeLeader(id);
    this.shared?.dispose();
    this.shared = null;
  }

  /** A cylinder of one unit along its y axis, one unit across. */
  private segment(entry: LeaderEntry): Mesh {
    const mesh = CreateCylinder("label-leader", { height: 1, diameter: 1, tessellation: 6 }, this.scene);
    mesh.rotationQuaternion = new Quaternion();
    mesh.material = entry.material;
    mesh.isPickable = false;
    mesh.setEnabled(false);
    this.options.configure?.(mesh, entry.leader);
    return mesh;
  }

  private sharedMaterial(): Material {
    if (!this.shared) {
      const material = new StandardMaterial("label-leader", this.scene);
      material.disableLighting = true;
      material.emissiveColor = Color3.White();
      this.shared = material;
    }
    return this.shared;
  }
}
