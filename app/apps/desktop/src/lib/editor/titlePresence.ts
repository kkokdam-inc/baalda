// "This person is in the title" presence.
//
// The inline title is the note's FILENAME in a React `<input>`, not document
// text, so yCollab's `cursor` field (a Y.Text relative position) cannot point
// into it. Instead a focused title publishes a small extra awareness field,
// `title: { caret, anchor? }` (plain character offsets into the input's value),
// beside `cursor`, and clears it to null on blur. Older clients never send it,
// and simply show no title caret.
//
// yCollab leaves `cursor` at the last body position when the editor blurs (it
// only clears it while the view itself has focus), so a peer with `title` set
// would also show a stale body caret; `remoteCursors` skips those peers.

import { Facet } from "@codemirror/state";
import type { Awareness } from "y-protocols/awareness";

/** Awareness field name. */
export const TITLE_FIELD = "title";

/** Offsets into the title input's value; `anchor` only when a range is selected. */
export interface TitlePresence {
  caret: number;
  anchor?: number;
}

/** A remote peer whose focus is in the title. */
export interface TitlePeer {
  clientId: number;
  caret: number;
  color: string;
  name: string;
}

/**
 * The note's awareness, so the title widget (React, outside Editor.tsx) can
 * reach it from the view it is handed. Provided by `remoteCursors`.
 */
export const noteAwareness = Facet.define<Awareness, Awareness | null>({
  combine: (values) => values[0] ?? null,
});

/** Is this awareness state focused in the title? Validates the wire shape. */
export function titlePresenceOf(state: Record<string, unknown>): TitlePresence | null {
  const t = state[TITLE_FIELD] as { caret?: unknown; anchor?: unknown } | null | undefined;
  if (!t || typeof t.caret !== "number" || !Number.isFinite(t.caret)) return null;
  return typeof t.anchor === "number" ? { caret: t.caret, anchor: t.anchor } : { caret: t.caret };
}

/** Every remote peer in the title, in stable clientID order. */
export function readTitlePeers(awareness: Awareness): TitlePeer[] {
  const peers: TitlePeer[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const t = titlePresenceOf(state);
    if (!t) return;
    const user = (state.user ?? {}) as { color?: unknown; name?: unknown };
    peers.push({
      clientId,
      caret: t.caret,
      color: typeof user.color === "string" ? user.color : "#30bced",
      name: typeof user.name === "string" && user.name ? user.name : "Someone",
    });
  });
  return peers.sort((a, b) => a.clientId - b.clientId);
}

/** Publish the local title selection (a no-op when unchanged). */
export function publishTitlePresence(
  awareness: Awareness,
  start: number,
  end: number,
  backward: boolean,
): void {
  const caret = backward ? start : end;
  const anchor = backward ? end : start;
  const prev = titlePresenceOf(awareness.getLocalState() ?? {});
  if (prev && prev.caret === caret && (prev.anchor ?? caret) === anchor) return;
  awareness.setLocalStateField(
    TITLE_FIELD,
    anchor === caret ? { caret } : { caret, anchor },
  );
}

/** Clear the local title presence (blur, unmount). */
export function clearTitlePresence(awareness: Awareness): void {
  const local = awareness.getLocalState();
  if (local && local[TITLE_FIELD] != null) awareness.setLocalStateField(TITLE_FIELD, null);
}

/** A teammate mid-rename may see a different, shorter name: clamp into ours. */
export function clampTitleCaret(caret: number, length: number): number {
  return Math.max(0, Math.min(Math.floor(caret), length));
}

let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * Pixel x of `caret` inside `input`, relative to the input's border box,
 * accounting for padding and the input's own horizontal scroll. Canvas
 * `measureText` with the input's computed font mirrors what the input draws.
 */
export function titleCaretX(input: HTMLInputElement, caret: number): number {
  const style = getComputedStyle(input);
  const value = input.value || "";
  const text = value.slice(0, clampTitleCaret(caret, value.length));
  measureCtx ??= document.createElement("canvas").getContext("2d");
  let width = 0;
  if (measureCtx && text) {
    measureCtx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    width = measureCtx.measureText(text).width;
  }
  const lead = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0);
  // Never past the input's visible edge, even if the text overflows.
  return Math.max(lead, Math.min(lead + width - input.scrollLeft, input.clientWidth + lead));
}
