// The graph view has no title bar: no "Graph" title and no note/link counts at
// the top, just three floating controls in the top-right corner. Its WebGL
// diagnostic line is gated behind dev builds or an explicit debug flag.
//
// GraphView needs a canvas, WebGL and the store, so this pins the markup at
// the source level rather than rendering it.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const view = readFileSync(resolve(srcRoot, "components/GraphView.tsx"), "utf8");
const css = readFileSync(resolve(srcRoot, "components/graph.css"), "utf8");

describe("graph view floating controls", () => {
  it("renders no header bar, title or counts", () => {
    expect(view).not.toContain("graph-header");
    expect(view).not.toContain("graph-title");
    expect(view).not.toContain("graph-counts");
    expect(view).not.toMatch(/>\s*Graph\s*</);
    expect(css).not.toContain(".graph-header");
  });

  it("keeps the three controls with their labels and tooltips", () => {
    for (const label of ["Graph settings", "Refresh graph", "Close graph"]) {
      expect(view).toContain(`aria-label="${label}"`);
      expect(view).toContain(`title="${label}"`);
    }
    expect(view).toContain('className="graph-floating-controls"');
  });

  it("keeps the top edge draggable", () => {
    expect(view).toMatch(/className="graph-drag-strip"\s+data-tauri-drag-region/);
  });

  it("clears the Windows caption row and the macOS traffic lights", () => {
    expect(css).toMatch(/\.graph-floating-controls\s*{[^}]*var\(--titlebar-inset\)/);
    expect(css).toMatch(
      /html\[data-platform="windows"\] \.graph-floating-controls\s*{[^}]*var\(--chrome-row-h\)/,
    );
  });

  it("gives every control a visible keyboard focus ring", () => {
    expect(css).toMatch(/\.graph-icon-btn:focus-visible\s*{[^}]*var\(--focus-ring\)/);
  });

  it("shows the WebGL diagnostic only behind the debug gate", () => {
    expect(view).toContain("graphDebugEnabled()");
    expect(view).toMatch(/\{showDiag && WEBGL_ENABLED/);
  });
});
