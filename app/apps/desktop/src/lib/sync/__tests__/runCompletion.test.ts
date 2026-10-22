// A run ends `done` or `error` (`completeRun`). It used to count the RAW
// failure lists — every failure the last uploader ever saw, and every bulk one
// — so a note whose push timed out once and then went through (or is still in
// its automatic retry window, or was re-queued) kept the vault in `error`:
// the header pill read "Sync incomplete" while Activity listed nothing and
// every note was synced. The verdict now uses the same list Activity shows.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeRegistry = vi.hoisted(() => ({
  pull: vi.fn(async (): Promise<boolean> => true),
  setProgressSink: vi.fn(),
  setMapListener: vi.fn(),
  setNoteMetaListener: vi.fn(),
  setColorListener: vi.fn(),
  setFailureListener: vi.fn(),
  setInboundHost: vi.fn(),
  mappedNotes: vi.fn((): Array<{ docId: string; relPath: string }> => []),
  failures: vi.fn((): unknown[] => []),
  hasFailures: vi.fn(() => false),
  heldRefusals: vi.fn((): unknown[] => []),
  retryHeldRefusals: vi.fn(() => false),
  limitCode: vi.fn((): string | null => null),
}));

vi.mock("../registry", () => ({
  VaultRegistry: class {
    constructor() {
      return fakeRegistry;
    }
  },
}));

vi.mock("../../ipc", () => ({
  isVaultMismatch: () => false,
  noteExists: vi.fn(async () => true),
  clearYjsDoc: vi.fn(async () => {}),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
}));

vi.mock("../../auth/authManager", () => ({
  api: {
    listVaultBlobs: vi.fn(async () => []),
    downloadBlob: vi.fn(async () => new Uint8Array()),
  },
}));

import { SyncManager } from "../docSession";
import type { UploadFailure } from "../contentUpload";
import type { SyncProgress, VaultScope } from "../vaultScope";

interface Internals {
  completeRun(scope: VaultScope): void;
  progress: unknown;
  uploader: { failedDocs(): UploadFailure[] } | null;
  bulkFailures: Map<string, UploadFailure>;
  permanentFailures: Map<string, UploadFailure>;
  localChanges: Map<string, string>;
  failureGrace: {
    record(f: UploadFailure, now: number): void;
    settle(docId: string): void;
  };
}

const scope = { isCurrent: () => true, vaultEpoch: 1 } as unknown as VaultScope;

function manager() {
  const sm = new SyncManager();
  const inner = sm as unknown as Internals;
  let phase: SyncProgress["phase"] = "uploading";
  const progress = {
    snapshot: () => ({ phase, done: 1, total: 1, failed: 0 }) as SyncProgress,
    phase: vi.fn((p: SyncProgress["phase"]) => {
      phase = p;
    }),
    flush: vi.fn(),
  };
  inner.progress = progress;
  return { sm, inner, progress };
}

const timeout: UploadFailure = { docId: "d1", relPath: "a.md", reason: "push timed out" };

beforeEach(() => {
  fakeRegistry.hasFailures.mockReturnValue(false);
  fakeRegistry.limitCode.mockReturnValue(null);
});

describe("completeRun", () => {
  it("ends done when a failed push was later confirmed", () => {
    const { sm, inner, progress } = manager();
    inner.uploader = { failedDocs: () => [timeout] };
    inner.failureGrace.record(timeout, Date.now());
    inner.failureGrace.settle("d1");
    inner.completeRun(scope);
    expect(progress.phase).toHaveBeenLastCalledWith("done");
    expect(sm.syncFailures().content).toEqual([]);
  });

  it("ends done while a transient failure is still inside its retry grace", () => {
    const { inner, progress } = manager();
    inner.uploader = { failedDocs: () => [timeout] };
    inner.bulkFailures.set("d2", { docId: "d2", relPath: "b.md", reason: "fetch failed" });
    inner.failureGrace.record(timeout, Date.now());
    inner.failureGrace.record(inner.bulkFailures.get("d2")!, Date.now());
    inner.completeRun(scope);
    expect(progress.phase).toHaveBeenLastCalledWith("done");
  });

  it("ends done when the failed doc is already queued to push again", () => {
    const { inner, progress } = manager();
    const refused: UploadFailure = { docId: "d1", relPath: "a.md", reason: "server refused the push" };
    inner.uploader = { failedDocs: () => [refused] };
    inner.localChanges.set("d1", "a.md");
    inner.completeRun(scope);
    expect(progress.phase).toHaveBeenLastCalledWith("done");
  });

  it("still ends error for a failure Activity lists", () => {
    const { sm, inner, progress } = manager();
    const refused: UploadFailure = { docId: "d1", relPath: "a.md", reason: "server refused the push" };
    inner.uploader = { failedDocs: () => [refused] };
    inner.completeRun(scope);
    expect(progress.phase).toHaveBeenLastCalledWith("error");
    expect(sm.syncFailures().content).toHaveLength(1);
  });

  it("still ends error for a note too large to sync", () => {
    const { inner, progress } = manager();
    inner.uploader = null;
    inner.permanentFailures.set("d3", {
      docId: "d3",
      relPath: "big.md",
      reason: "too large",
      permanent: true,
    });
    inner.completeRun(scope);
    expect(progress.phase).toHaveBeenLastCalledWith("error");
  });
});
