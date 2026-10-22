// Whether the graph view shows its WebGL diagnostic line (node count, buffer
// size, camera, bounds, GL error) in the bottom-left corner.
//
// It is a debugging aid, never product UI: dev builds show it, and a release
// build shows it only when someone opts in by setting the localStorage key
// below to "1" (DevTools: `localStorage.setItem("context.graph.debug", "1")`,
// then reopen the graph).

export const GRAPH_DEBUG_STORAGE_KEY = "context.graph.debug";

type StorageLike = Pick<Storage, "getItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function graphDebugEnabled(
  dev: boolean = import.meta.env.DEV,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (dev) return true;
  try {
    return storage?.getItem(GRAPH_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
