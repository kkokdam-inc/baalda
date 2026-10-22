import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  clampTitleCaret,
  clearTitlePresence,
  publishTitlePresence,
  readTitlePeers,
  titlePresenceOf,
} from "./titlePresence";

function pair() {
  const local = new Awareness(new Y.Doc());
  const remote = new Awareness(new Y.Doc());
  // Mirror the remote client's state into `local`, as the provider would.
  const sync = () => {
    local.states.set(remote.clientID, remote.getLocalState()!);
    local.emit("change", [{ added: [], updated: [remote.clientID], removed: [] }, "remote"]);
  };
  return { local, remote, sync };
}

describe("title presence", () => {
  it("publishes a caret and an anchor only for a range, then clears", () => {
    const { local } = pair();
    publishTitlePresence(local, 3, 3, false);
    expect(local.getLocalState()!.title).toEqual({ caret: 3 });
    publishTitlePresence(local, 1, 4, true);
    expect(local.getLocalState()!.title).toEqual({ caret: 1, anchor: 4 });
    clearTitlePresence(local);
    expect(local.getLocalState()!.title).toBeNull();
  });

  it("reads remote peers with their user name and colour, never ourselves", () => {
    const { local, remote, sync } = pair();
    publishTitlePresence(local, 2, 2, false);
    remote.setLocalStateField("user", { name: "Sara", color: "#ff0000" });
    publishTitlePresence(remote, 5, 5, false);
    sync();
    expect(readTitlePeers(local)).toEqual([
      { clientId: remote.clientID, caret: 5, color: "#ff0000", name: "Sara" },
    ]);
    clearTitlePresence(remote);
    sync();
    expect(readTitlePeers(local)).toEqual([]);
  });

  it("ignores older clients and malformed fields", () => {
    expect(titlePresenceOf({ cursor: { head: 1 } })).toBeNull();
    expect(titlePresenceOf({ title: null })).toBeNull();
    expect(titlePresenceOf({ title: { caret: "3" } })).toBeNull();
  });

  it("clamps a caret past a shorter local name", () => {
    expect(clampTitleCaret(12, 5)).toBe(5);
    expect(clampTitleCaret(-1, 5)).toBe(0);
  });
});
