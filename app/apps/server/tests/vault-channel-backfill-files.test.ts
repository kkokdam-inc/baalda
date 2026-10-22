import { EventEmitter } from "node:events";
import * as Y from "yjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFile, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { appendUpdate, loadDocDiff } from "../src/yjs/persistence.js";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { mintVaultToken } from "../src/tokens/vault-token.js";

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly binary: Buffer[] = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (opts?.binary) this.binary.push(Buffer.from(data as Uint8Array));
    else this.sent.push(JSON.parse(data as string));
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

afterAll(async () => {
  await pool.end();
});

describe("vault channel backfill skips binary files", () => {
  let owner: TestUser;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@bf.test");
    const org = (await createOrg(owner, "BF Co", "bf-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });

  it("backfills the note as before and never loads state for a files id", async () => {
    const note = await seedNote(vault, null, "a.md", owner.userId);
    const file = await seedFile(vault, null, "pic.png");
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "hello");
    await appendUpdate(note, Y.encodeStateAsUpdate(doc));

    const loaded: string[] = [];
    const channel = new VaultChannel({
      pubsub: new InMemoryPubSub(),
      loadDiff: (id: string, sv: Uint8Array | null, db?: never) => {
        loaded.push(id);
        return loadDocDiff(id, sv, db);
      },
    });
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    const token = await mintVaultToken({ userId: owner.userId, vaultId: vault });
    ws.emit("message", Buffer.from(JSON.stringify({ t: "hello", token, manifest: {} })), false);
    const start = Date.now();
    while (!ws.sent.some((c) => c.t === "ready")) {
      if (Date.now() - start > 4000) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(loaded).toEqual([note]);
    expect(loaded).not.toContain(file);
    expect(ws.binary.length).toBe(1);
  });
});
