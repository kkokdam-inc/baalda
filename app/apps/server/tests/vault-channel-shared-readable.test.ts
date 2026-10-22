import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import type { DocDiff } from "../src/yjs/persistence.js";

// One ACL/registry message, one readable-set computation per (vault, user) on
// this instance — however many sockets that user has open. A NEW message always
// recomputes, so a change committed before it is never answered from an older
// set. Fakes only — no socket, no DB.

type Sent = { kind: "text"; value: Record<string, unknown> } | { kind: "binary" };

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Sent[] = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (opts?.binary) this.sent.push({ kind: "binary" });
    else this.sent.push({ kind: "text", value: JSON.parse(data as string) });
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  hello(token: string): void {
    this.emit("message", Buffer.from(JSON.stringify({ t: "hello", token, manifest: {} })), false);
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s) => s.kind === "text")
      .map((s) => (s as { value: Record<string, unknown> }).value);
  }
}

const pubsubs: InMemoryPubSub[] = [];

async function waitFor(fn: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setup(readable: Map<string, Set<string>>) {
  const pubsub = new InMemoryPubSub();
  pubsubs.push(pubsub);
  const calls: Array<{ userId: string; shared: unknown }> = [];
  const channel = new VaultChannel({
    pubsub,
    // token "u1" / "u2" ⇒ that user, same vault.
    verifyToken: async (token: string) => ({ userId: token, vaultId: "v1" }),
    listReadableDocs: async (userId: string, _vaultId: string, _db?: unknown, shared?: unknown) => {
      calls.push({ userId, shared });
      return new Set(readable.get(userId) ?? []);
    },
    loadDiff: async (docId: string): Promise<DocDiff> => ({
      update: new Uint8Array([docId.charCodeAt(0)]),
      serverStateVector: new Uint8Array(),
      upToDate: false,
      clientAhead: false,
    }),
    listEmpty: async () => ({ empty: [] as string[], truncated: false }),
    backfillConcurrency: 4,
    registryCoalesceMs: 0,
  });
  return { channel, calls };
}

async function connect(channel: VaultChannel, user: string): Promise<FakeWs> {
  const ws = new FakeWs();
  channel.handleConnection(ws as never);
  ws.hello(user);
  await waitFor(() => ws.controls().some((c) => c.t === "ready"));
  return ws;
}

afterEach(async () => {
  await Promise.all(pubsubs.splice(0).map((p) => p.close()));
});

describe("VaultChannel — readable set shared per message", () => {
  it("computes once per (user, message) across that user's sockets", async () => {
    const readable = new Map([
      ["u1", new Set(["A"])],
      ["u2", new Set(["A", "B"])],
    ]);
    const { channel, calls } = setup(readable);
    await connect(channel, "u1");
    await connect(channel, "u1");
    await connect(channel, "u2");
    calls.length = 0; // connects compute alone, as before

    await channel.publishAclChanged("v1");
    await new Promise((r) => setTimeout(r, 30));
    // Two u1 sockets share one computation; u2 gets its own.
    expect(calls.filter((c) => c.userId === "u1")).toHaveLength(1);
    expect(calls.filter((c) => c.userId === "u2")).toHaveLength(1);
    // Both share ONE memo for the user-independent reads of this message.
    expect(calls[0].shared).toBeInstanceOf(Map);
    expect(calls[0].shared).toBe(calls[1].shared);
  });

  it("recomputes on the next message, so an ACL change is never served stale", async () => {
    const readable = new Map([["u1", new Set(["A", "B"])]]);
    const { channel, calls } = setup(readable);
    const a = await connect(channel, "u1");
    const b = await connect(channel, "u1");
    calls.length = 0;

    await channel.publishAclChanged("v1");
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);

    // B revoked; the next announcement must recompute and drop it on BOTH sockets.
    readable.set("u1", new Set(["A"]));
    await channel.publishAclChanged("v1");
    await waitFor(() =>
      [a, b].every((ws) =>
        ws.controls().some((c) => (c.t === "revoked" || c.t === "drop") && JSON.stringify(c).includes("B")),
      ),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].shared).not.toBe(calls[1].shared);
  });
});
