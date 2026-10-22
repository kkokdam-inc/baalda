// @vitest-environment jsdom
//
// The inline title, through a real EditorView and a real React root.
//
// The load-bearing assertion is the node-identity one: `TitleWidget.eq()`
// compares only {path, readOnly, hasFrontmatter, mode}, never document content,
// so typing in the body must reuse the SAME DOM node. If that ever regresses,
// every keystroke — yours or a teammate's — destroys the input under the caret.
import { Compartment, EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createEditorState } from "./index";
import { clampSelectionToBody } from "./noteHeader";
import type { NoteHeaderOptions } from "./noteHeader";
import { setFocused } from "./reveal";

function mount(doc: string, header?: Partial<NoteHeaderOptions>, readOnly = false) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
      header: {
        path: "Notes/My Note.md",
        renameTo: async () => null,
        noteExists: async () => false,
        ...header,
      },
      extraExtensions: readOnly
        ? // Exactly what Editor.tsx's `editable` Compartment supplies.
          [EditorState.readOnly.of(true), EditorView.editable.of(false)]
        : [],
    } as never),
    parent,
  });
  return view;
}

const titleInput = (view: EditorView) =>
  view.dom.querySelector<HTMLInputElement>(".inline-title-input");

describe("the inline title widget", () => {
  it("renders the note's filename stem as an input", () => {
    const view = mount("Body text.");
    expect(titleInput(view)?.value).toBe("My Note");
    view.destroy();
  });

  it("sits above the body, inset to the prose column", () => {
    const view = mount("Body text.");
    const host = view.contentDOM.querySelector(".cm-note-title");
    expect(host).not.toBeNull();
    expect(host!.parentElement).toBe(view.contentDOM);
    // The shared inset class — otherwise the title's left edge is not the
    // body's left edge, which is the most visible way to get this wrong.
    expect(host!.classList.contains("cm-block-inset")).toBe(true);
    expect(host!.compareDocumentPosition(view.contentDOM.querySelector(".cm-line")!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    view.destroy();
  });

  it("keeps the SAME DOM node when the body is edited", () => {
    const view = mount("Body text.");
    const before = titleInput(view);
    expect(before).not.toBeNull();
    view.dispatch({ changes: { from: view.state.doc.length, insert: " More." } });
    expect(titleInput(view)).toBe(before);
    // …and again after a selection move, which rebuilds the field's set too.
    view.dispatch({ selection: { anchor: 2 } });
    expect(titleInput(view)).toBe(before);
    view.destroy();
  });

  it("renders read-only when the state is", () => {
    const view = mount("Body text.", {}, true);
    expect(titleInput(view)?.readOnly).toBe(true);
    view.destroy();
  });

  it("collapses an exact legacy first H1 without changing the Markdown", () => {
    const doc = "# My Note\n\nBody text.";
    const view = mount(doc);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.contentDOM.textContent).not.toContain("# My Note");
    expect(view.contentDOM.textContent).toContain("Body text.");

    // Entering the source line reveals the real heading and its marker so it
    // remains fully editable. The title input itself still renames the file.
    view.dispatch({ effects: setFocused.of(true), selection: { anchor: 3 } });
    expect(view.contentDOM.textContent).toContain("# My Note");
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it("keeps the duplicate collapsed after a live read-only transition", () => {
    const editable = new Compartment();
    const view = mount("# My Note\n\nBody text.", {
      path: "Notes/My Note.md",
    });
    // Install the same compartment shape Editor.tsx uses, then put the caret
    // on the revealed source before the server's permission verdict arrives.
    view.dispatch({
      effects: StateEffect.appendConfig.of(editable.of([])),
    });
    view.dispatch({ effects: setFocused.of(true), selection: { anchor: 3 } });
    expect(view.contentDOM.textContent).toContain("# My Note");
    view.dispatch({
      effects: editable.reconfigure([
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ]),
    });
    expect(titleInput(view)?.readOnly).toBe(true);
    expect(view.contentDOM.textContent).not.toContain("# My Note");
    expect(view.state.doc.toString()).toBe("# My Note\n\nBody text.");
    view.destroy();
  });

  it("does not collapse a distinct or later H1", () => {
    const distinct = mount("# A different heading\n\nBody text.");
    expect(distinct.contentDOM.textContent).toContain("A different heading");
    distinct.destroy();

    const later = mount("Intro.\n\n# My Note\n\nBody text.");
    expect(later.contentDOM.textContent).toContain("My Note");
    later.destroy();
  });

  it("finds an exact duplicate after frontmatter", () => {
    const doc = "---\ntags: [legacy]\n---\n\n# My Note\n\nBody text.";
    const view = mount(doc);
    expect(view.contentDOM.textContent).not.toContain("# My Note");
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it("keeps the authored H1 visible without an inline title", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const withoutTitle = new EditorView({
      state: createEditorState({
        doc: "# My Note\n\nBody text.",
        getTitles: () => [],
        onNavigate: () => {},
      } as never),
      parent,
    });
    expect(withoutTitle.contentDOM.textContent).toContain("My Note");
    withoutTitle.destroy();
  });

  it("renders on an empty note too — the title is always there", () => {
    // The naming affordance for a note created blank: ⌘N opens this, focused
    // and selected, and typing replaces "Untitled".
    const view = mount("");
    expect(titleInput(view)?.value).toBe("My Note");
    expect(view.contentDOM.querySelector(".cm-note-title")).not.toBeNull();
    view.destroy();
  });

  it("shows the properties affordance only when there is no frontmatter", () => {
    const plain = mount("Body text.");
    expect(plain.dom.querySelector(".inline-title-add")).not.toBeNull();
    plain.destroy();
    const withFm = mount("---\ntags: [a]\n---\nBody.");
    expect(withFm.dom.querySelector(".inline-title-add")).toBeNull();
    withFm.destroy();
  });
});

// A drag from the body upward used to paint the title as selected the moment
// the head reached position 0, and with frontmatter it silently selected (and
// copied) the YAML hidden behind the Properties panel.
describe("a body selection never reaches into the header", () => {
  const FM = "---\ntitle: x\n---\n";
  const DOC = `${FM}First line.\nSecond line.`;
  const pointer = (view: EditorView, anchor: number, head: number) =>
    view.dispatch({ selection: { anchor, head }, userEvent: "select.pointer" });

  it("clamps a drag up over the title/panel to the first body position", () => {
    const view = mount(DOC);
    pointer(view, view.state.doc.length, 0);
    const { anchor, head, from, to } = view.state.selection.main;
    expect(anchor).toBe(view.state.doc.length);
    expect(head).toBe(FM.length);
    // What a copy carries: the body only — no hidden YAML, no file name.
    expect(view.state.sliceDoc(from, to)).toBe("First line.\nSecond line.");
    view.destroy();
  });

  it("stops at position 0 without frontmatter, and never paints the title", () => {
    const view = mount("First line.\nSecond line.");
    pointer(view, view.state.doc.length, 0);
    expect(view.state.selection.main.head).toBe(0);
    const host = view.contentDOM.querySelector(".cm-note-title")!;
    expect(host.classList.contains("is-selected")).toBe(false);
    view.destroy();
  });

  it("leaves non-pointer selections (select-all, keyboard) alone", () => {
    const view = mount(DOC);
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length }, userEvent: "select" });
    expect(view.state.selection.main.from).toBe(0);
    view.destroy();
  });
});

describe("clampSelectionToBody", () => {
  it("raises anchor and head to the body start; identity when already inside", () => {
    const sel = EditorSelection.create([EditorSelection.range(30, 2)]);
    const out = clampSelectionToBody(sel, 10);
    expect(out.main.anchor).toBe(30);
    expect(out.main.head).toBe(10);
    const inside = EditorSelection.create([EditorSelection.range(30, 12)]);
    expect(clampSelectionToBody(inside, 10)).toBe(inside);
    expect(clampSelectionToBody(sel, 0)).toBe(sel);
  });
});
