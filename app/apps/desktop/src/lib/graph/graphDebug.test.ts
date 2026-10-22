import { describe, expect, it } from "vitest";
import { GRAPH_DEBUG_STORAGE_KEY, graphDebugEnabled } from "./graphDebug";

function storage(values: Record<string, string>) {
  return { getItem: (k: string) => values[k] ?? null };
}

describe("graphDebugEnabled", () => {
  it("is off in a release build without the flag", () => {
    expect(graphDebugEnabled(false, storage({}))).toBe(false);
    expect(graphDebugEnabled(false, null)).toBe(false);
  });

  it("is on in a dev build", () => {
    expect(graphDebugEnabled(true, storage({}))).toBe(true);
  });

  it("is on in a release build only when the flag is exactly 1", () => {
    expect(graphDebugEnabled(false, storage({ [GRAPH_DEBUG_STORAGE_KEY]: "1" }))).toBe(true);
    expect(graphDebugEnabled(false, storage({ [GRAPH_DEBUG_STORAGE_KEY]: "0" }))).toBe(false);
    expect(graphDebugEnabled(false, storage({ [GRAPH_DEBUG_STORAGE_KEY]: "true" }))).toBe(false);
  });

  it("treats a throwing storage as off", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(graphDebugEnabled(false, broken)).toBe(false);
  });
});
