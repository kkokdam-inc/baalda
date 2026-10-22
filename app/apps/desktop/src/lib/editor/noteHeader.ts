/**
 * Everything above the body: the inline title, and the Properties panel.
 *
 * Both are CodeMirror block decorations living INSIDE `.cm-content`, hosting
 * React through `createRoot`. Neither is a React sibling of `.editor-host`, and
 * the scroll container is untouched — moving the scroller out to the column
 * would have cost CM6's scroll anchoring, the two absolute overlays' sizing, and
 * a scrollbar's worth of left-edge alignment between the title and the body.
 *
 * Why a widget is safe here, when "contenteditable inside CM content" is not:
 * we use real `<input>`s. Typing into one produces no MutationRecord, so CM6's
 * DOMObserver never force-flushes the widget's DOM out from under the caret —
 * that is the entire fragility of a nested contenteditable, and it does not
 * apply. CM6 stamps `contentEditable="false"` on every widget and skips the
 * subtree when reading the document; a zero-length widget contributes no text;
 * and `ignoreEvent()` defaults to true, so `eventBelongsToEditor` stops at our
 * host and NO editor keymap, mousedown, paste or input handler fires while the
 * focus is inside. The editor keymap is inert while typing a title by
 * construction, not by guessing.
 *
 * Ordering is guaranteed by CM6's sort, not by luck: a block widget with
 * `side: -1` sorts above a block replace starting at the same position. Title,
 * then panel, then body.
 *
 * The React-in-a-widget lifecycle itself (`flushSync` first paint, `updateDOM`
 * returning true, deferred unmount) is `./reactWidget.ts`, shared with the
 * editable table widget.
 *
 * The `eq()` contract is load-bearing. The title widget compares only
 * `{path, readOnly, hasFrontmatter, mode}` — never document content — so typing
 * in the body reuses the exact same DOM node and the input keeps its focus and
 * caret with no special handling. The panel's `eq()` does depend on the source
 * (it has to), and pays for it in `updateDOM` returning TRUE: CM6 keeps the host
 * node and React reconciles into it, which is what makes a teammate editing a
 * different property survivable.
 */

import {
  type Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  type Range,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  WidgetType,
} from "@codemirror/view";
import { createElement, type ReactNode } from "react";
import { InlineTitle } from "../../components/InlineTitle";
import {
  addPropertyToNote,
  PROPERTIES_USER_EVENT,
  PropertiesPanel,
} from "../../components/properties/PropertiesPanel";
import { bodyStart, getHeaderFocus } from "./headerFocus";
import { ReactWidget } from "./reactWidget";
import {
  findFrontmatter,
  frontmatterField,
  frontmatterView,
  propertiesMode,
  type PropertiesMode,
} from "./frontmatter";

export type { PropertiesMode };
export { bodyStart, getHeaderFocus, registerHeaderFocus } from "./headerFocus";

/** Class shared with the block-replace widgets so the header's left edge is the
 *  body's left edge (see BLOCK_INSET_CLASS / `--editor-pad-x`). */
const INSET = "cm-block-inset";

export interface NoteHeaderOptions {
  /** Vault-relative path of the open note. The title is its stem. */
  path: string;
  /**
   * Commit a typed name. Resolves to `null` on success, or a message to show
   * under the title (a collision, a failed rename). The store action behind it
   * does NOT dedup — a name a person typed is refused, not silently suffixed.
   */
  renameTo: (nextPath: string) => Promise<string | null>;
  /** Does a note already exist at this path? Case-insensitive (macOS). */
  noteExists: (path: string) => Promise<boolean>;
  /** Frontmatter keys seen elsewhere in the vault, for name suggestions. */
  getPropertyKeys?: () => string[];
  /** Values seen for one key, for value suggestions. */
  getPropertyValues?: (key: string) => string[];
  /** Initial display mode; the Compartment reconfigures it later. */
  mode?: PropertiesMode;
  /** Owned by the caller (Editor.tsx) so a settings change can reconfigure. */
  modeCompartment?: Compartment;
}

class TitleWidget extends ReactWidget {
  constructor(
    private readonly opts: NoteHeaderOptions,
    private readonly path: string,
    private readonly readOnly: boolean,
    private readonly hasFrontmatter: boolean,
    private readonly mode: PropertiesMode,
  ) {
    super();
  }

  /** Document content is deliberately absent from this comparison. */
  eq(other: TitleWidget): boolean {
    return (
      other.path === this.path &&
      other.readOnly === this.readOnly &&
      other.hasFrontmatter === this.hasFrontmatter &&
      other.mode === this.mode
    );
  }

  protected hostClass(): string {
    return `cm-note-title ${INSET}`;
  }

  protected render(view: EditorView): ReactNode {
    return createElement(InlineTitle, {
      view,
      path: this.path,
      readOnly: this.readOnly,
      hasFrontmatter: this.hasFrontmatter,
      renameTo: this.opts.renameTo,
      noteExists: this.opts.noteExists,
    });
  }

  get estimatedHeight(): number {
    return 56;
  }
}

class PropertiesWidget extends ReactWidget {
  constructor(
    private readonly opts: NoteHeaderOptions,
    private readonly source: string,
    private readonly readOnly: boolean,
    private readonly rows: number,
  ) {
    super();
  }

  eq(other: PropertiesWidget): boolean {
    return other.source === this.source && other.readOnly === this.readOnly;
  }

  protected hostClass(): string {
    return `cm-note-properties ${INSET}`;
  }

  protected render(view: EditorView): ReactNode {
    return createElement(PropertiesPanel, {
      view,
      readOnly: this.readOnly,
      getPropertyKeys: this.opts.getPropertyKeys,
      getPropertyValues: this.opts.getPropertyValues,
    });
  }

  get estimatedHeight(): number {
    return 24 + this.rows * 30;
  }
}

/** The "Invalid properties" banner over YAML we refuse to rewrite. */
class InvalidWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const host = document.createElement("div");
    host.className = `cm-fm-banner ${INSET}`;
    // No innerHTML anywhere in this file (or any widget in this app).
    const strong = document.createElement("strong");
    strong.textContent = "Properties can't be shown";
    const rest = document.createElement("span");
    rest.textContent =
      " — this note's YAML is outside what Baalda edits, so it is shown as text and never rewritten.";
    host.append(strong, rest);
    return host;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ---- The field --------------------------------------------------------------

function build(state: EditorState, opts: NoteHeaderOptions): DecorationSet {
  const fm = state.field(frontmatterField, false) ?? findFrontmatter(state.doc);
  const mode = state.facet(propertiesMode);
  const presentation = frontmatterView(state);
  const decos: Range<Decoration>[] = [];

  decos.push(
    Decoration.widget({
      widget: new TitleWidget(opts, opts.path, state.readOnly, fm !== null, mode),
      block: true,
      side: -1,
    }).range(0),
  );

  if (fm) {
    if (presentation === "panel") {
      const source = state.doc.sliceString(fm.from, fm.to);
      decos.push(
        Decoration.replace({
          widget: new PropertiesWidget(
            opts,
            source,
            state.readOnly,
            Math.max(1, fm.closeLine - fm.openLine - 1),
          ),
          block: true,
        }).range(fm.from, fm.to),
      );
    } else if (presentation === "collapsed") {
      // No widget: the lines collapse out of the layout entirely.
      decos.push(Decoration.replace({ block: true }).range(fm.from, fm.to));
    } else if (presentation === "invalid") {
      // Showing source though the reader asked for the panel, because the YAML
      // is outside the subset we can round-trip. Say so, and never write: no
      // replace decoration here, so the text stays editable exactly as it is.
      decos.push(
        Decoration.widget({ widget: new InvalidWidget(), block: true, side: -1 }).range(
          fm.from,
        ),
      );
      for (let n = fm.openLine; n <= fm.closeLine; n++) {
        decos.push(
          Decoration.line({ class: "cm-fm-invalid" }).range(state.doc.line(n).from),
        );
      }
    }
  }
  return Decoration.set(decos, true);
}

/**
 * The note header extension: the title widget, the Properties decoration, the
 * display-mode Compartment and the keyboard handoffs. Added only when the caller
 * has a note path — the version-preview view and the geometry tests build an
 * editor without one and keep Stage 1's dimmed frontmatter block.
 */
/**
 * Keep a pointer selection in the body. The title is the FILE NAME, not
 * document text, and the Properties panel stands in for frontmatter the reader
 * chose not to see as text — so a drag from the body up over either one (or
 * over the top padding, where `posAtCoords` answers 0) must stop at the first
 * body position, the way a plain text editor stops at its first line. Without
 * this, the head landed on 0: with frontmatter that silently selected (and
 * copied) the hidden YAML, and the panel was painted as selected.
 *
 * Pointer selections only (`select.pointer`): ⌘A, ⇧↑ and programmatic
 * selections keep the whole document, which is what a copy of "everything"
 * should carry. Source and invalid presentations show the YAML as editable
 * text, so it is selectable there like any other line.
 */
export function clampSelectionToBody(
  selection: EditorSelection,
  start: number,
): EditorSelection {
  if (start <= 0) return selection;
  if (selection.ranges.every((r) => r.anchor >= start && r.head >= start)) {
    return selection;
  }
  return EditorSelection.create(
    selection.ranges.map((r) =>
      EditorSelection.range(Math.max(r.anchor, start), Math.max(r.head, start)),
    ),
    selection.mainIndex,
  );
}

const pointerSelectionInBody = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged || !tr.isUserEvent("select.pointer")) return tr;
  const view = frontmatterView(tr.startState);
  if (view !== "panel" && view !== "collapsed") return tr;
  const fm = tr.startState.field(frontmatterField, false) ?? null;
  const start = bodyStart(fm, tr.startState.doc.length);
  const clamped = clampSelectionToBody(tr.selection, start);
  return clamped === tr.selection ? tr : [tr, { selection: clamped, sequential: true }];
});

/**
 * Defence in depth for view-only notes. The panel already renders static text
 * and its dispatch helper refuses while `state.readOnly`, but a programmatic
 * `view.dispatch` is never stopped by that facet on its own — so drop any
 * Properties-tagged transaction that starts from a read-only state before
 * `yCollab` can turn it into a Y.Text op the server would only reject.
 */
export const readOnlyPropertiesGuard = EditorState.transactionFilter.of((tr) =>
  tr.startState.readOnly && tr.isUserEvent(PROPERTIES_USER_EVENT) ? [] : tr,
);

export function noteHeader(opts: NoteHeaderOptions): Extension {
  const modeExt = propertiesMode.of(opts.mode ?? "visible");
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, opts),
    update: (value, tr) =>
      tr.docChanged ||
      tr.selection ||
      tr.startState.readOnly !== tr.state.readOnly ||
      tr.startState.facet(propertiesMode) !== tr.state.facet(propertiesMode)
        ? build(tr.state, opts)
        : value,
    provide: (f) => EditorView.decorations.from(f),
  });

  return [
    frontmatterField,
    opts.modeCompartment ? opts.modeCompartment.of(modeExt) : modeExt,
    field,
    readOnlyPropertiesGuard,
    pointerSelectionInBody,
    // `Prec.high` so these beat defaultKeymap's own arrow handling.
    Prec.high(
      keymap.of([
        {
          key: "ArrowUp",
          run: (view) => {
            const { state } = view;
            if (!state.selection.main.empty) return false;
            const fm = state.field(frontmatterField, false) ?? null;
            const start = bodyStart(fm, state.doc.length);
            const head = state.selection.main.head;
            // Only from the FIRST body line, or this steals every ArrowUp.
            if (state.doc.lineAt(head).number !== state.doc.lineAt(start).number) {
              return false;
            }
            const focus = getHeaderFocus(view);
            return focus.focusLastProperty?.() || focus.focusTitle?.(true) || false;
          },
        },
        { key: "Mod-;", run: (view) => addPropertyToNote(view) },
      ]),
    ),
  ];
}
