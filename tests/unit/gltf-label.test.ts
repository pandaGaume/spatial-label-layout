import { describe, expect, it } from "vitest";
import { cloneJson, isLabelId, parseSpaceXrLabel } from "@spacexr/spatial-label-layout-core";

const ID = "3f6c1e2a-8b4d-4c7e-9a1f-2d5b6c7e8f90";

describe("SPACEXR_label: identity and data of the application", () => {
  it("reads an id, a type and data of the application", () => {
    const userData = { capturedAt: "2026-06-12", heading: 214, tags: ["north", { level: 2 }], note: null };
    const label = parseSpaceXrLabel({ id: ID, type: "photo360", userData });
    expect(label).toEqual({ id: ID, type: "photo360", userData });
    // The data is a copy: the glTF it came from may change.
    expect(label.userData).not.toBe(userData);
    expect(label.userData!.tags).not.toBe(userData.tags);
  });

  it("keeps the id in lower case", () => {
    expect(parseSpaceXrLabel({ id: ID.toUpperCase() }).id).toBe(ID);
  });

  it("rejects an id that is no UUID, an empty type, and data that is no object", () => {
    for (const id of ["", "photo-12", "3f6c1e2a8b4d4c7e9a1f2d5b6c7e8f90", `{${ID}}`, 12]) expect(() => parseSpaceXrLabel({ id })).toThrow(/id/);
    for (const type of ["", 3, null]) expect(() => parseSpaceXrLabel({ type })).toThrow(/type/);
    for (const userData of ["text", 4, [1, 2], null]) expect(() => parseSpaceXrLabel({ userData })).toThrow(/userData/);
  });

  it("tells a UUID, in any case", () => {
    expect(isLabelId(ID)).toBe(true);
    expect(isLabelId(ID.toUpperCase())).toBe(true);
    expect(isLabelId(ID.slice(1))).toBe(false);
  });

  it("copies JSON, and only JSON", () => {
    const value = { a: [1, { b: "c" }], d: true, e: undefined as unknown as null };
    expect(cloneJson(value)).toEqual({ a: [1, { b: "c" }], d: true });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => cloneJson(cycle as never)).toThrow(/itself/);
    expect(() => cloneJson({ n: Number.NaN })).toThrow(/finite/);
    expect(() => cloneJson({ when: new Date() } as never)).toThrow(/plain/);
    expect(() => cloneJson({ f: () => 1 } as never)).toThrow(/JSON/);
  });
});
