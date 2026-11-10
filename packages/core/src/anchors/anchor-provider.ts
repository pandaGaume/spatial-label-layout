import { transformPoint, type ReadonlyMat4 } from "../geometry/mat4.js";
import { clone, isFiniteVec3 } from "../geometry/vec3.js";
import type { LabelAnchor, Vec3 } from "../types.js";

/**
 * Converts anchors (mesh-local or barycentric) into world positions.
 * Brief section 3: the solver never touches meshes, only this port.
 * Return `null` when the anchor cannot be resolved (mesh disposed, not loaded...).
 */
export interface AnchorProvider {
  resolve(anchor: LabelAnchor): Vec3 | null;
  /** Optional: called once per frame before any `resolve` (refresh caches, world matrices...). */
  beginFrame?(): void;
  /** Optional: true when the anchor's mesh moved/deformed since the previous frame. */
  hasChanged?(anchor: LabelAnchor): boolean;
}

/**
 * Minimal mesh access a rendering adapter must provide. Implementing these two
 * methods for Babylon.js, three.js, PlayCanvas... is the whole anchor port.
 */
export interface MeshResolver {
  /** World matrix of the mesh (column-major, translation at 12..14), or null if unknown. */
  getWorldMatrix(meshId: string): ReadonlyMat4 | null;
  /**
   * Optional, for deformable meshes: current local-space vertex positions of a
   * triangle (after skinning/morphing if the adapter supports it).
   */
  getTriangle?(meshId: string, triangleId: number): readonly [Vec3, Vec3, Vec3] | null;
  /** Optional change detection, e.g. comparing a world-matrix update counter. */
  hasChanged?(meshId: string): boolean;
}

/**
 * Generic transform-based anchor provider: local position x world matrix, or
 * barycentric interpolation on a (possibly deformed) triangle x world matrix.
 */
export class TransformAnchorProvider implements AnchorProvider {
  constructor(private readonly meshes: MeshResolver) {}

  resolve(anchor: LabelAnchor): Vec3 | null {
    if (anchor.meshId === undefined) return isFiniteVec3(anchor.localPosition) ? clone(anchor.localPosition) : null;
    const world = this.meshes.getWorldMatrix(anchor.meshId);
    if (!world) return null;
    let local = anchor.localPosition;
    if (anchor.triangleId !== undefined && anchor.barycentric && this.meshes.getTriangle) {
      const tri = this.meshes.getTriangle(anchor.meshId, anchor.triangleId);
      if (tri) local = barycentricPoint(tri, anchor.barycentric);
    }
    const p = transformPoint(world, local);
    return isFiniteVec3(p) ? p : null;
  }

  hasChanged(anchor: LabelAnchor): boolean {
    return anchor.meshId !== undefined && (this.meshes.hasChanged?.(anchor.meshId) ?? true);
  }
}

/** Anchors already expressed in world space (or driven by `setAnchorPosition`). */
export class StaticAnchorProvider implements AnchorProvider {
  private readonly positions = new Map<string, Vec3>();

  set(id: string, p: Vec3): void {
    this.positions.set(id, clone(p));
  }

  delete(id: string): void {
    this.positions.delete(id);
  }

  resolve(anchor: LabelAnchor): Vec3 | null {
    return this.positions.get(anchor.id) ?? (anchor.meshId === undefined ? clone(anchor.localPosition) : null);
  }
}

export const barycentricPoint = (tri: readonly [Vec3, Vec3, Vec3], w: readonly [number, number, number]): Vec3 => ({
  x: tri[0].x * w[0] + tri[1].x * w[1] + tri[2].x * w[2],
  y: tri[0].y * w[0] + tri[1].y * w[1] + tri[2].y * w[2],
  z: tri[0].z * w[0] + tri[1].z * w[1] + tri[2].z * w[2],
});
