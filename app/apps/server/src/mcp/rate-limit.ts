import type { McpAuth } from "./tokens.js";

/**
 * Per-connection rate limit for MCP tool calls: one token bucket per
 * authenticated connection, never per IP (Claude's connector traffic shares
 * egress addresses).
 *
 * In-process and PER INSTANCE: with N server instances a connection gets N
 * buckets. One instance runs today; a shared store is the fix if that changes.
 *
 * Numbers (env-overridable, defaults chosen from production traffic):
 *  - `MCP_RATE_LIMIT_PER_MIN` (120): sustained units per minute. The busiest
 *    legitimate tokens average ~2 calls/min; 120 is 60x that, so only a loop
 *    ever reaches it.
 *  - `MCP_RATE_LIMIT_BURST` (60): bucket size. An agent doing a few dozen
 *    reads and edits in a row never waits, and a full 50-message batch of
 *    ordinary calls always fits.
 *
 * Calls are weighted by what they cost the server (see {@link toolCallCost}):
 * a whole-vault `list_notes` is 20 units, so a loop of them settles at 6/min
 * (the observed loop ran ~100/min for 20 minutes), while the paged form costs
 * 1 like any other call. The paged path is the cheap one on purpose.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface RateLimitConfig {
  /** Sustained units per minute. */
  perMinute: number;
  /** Bucket capacity: the most units spendable at once. */
  burst: number;
}

export const MCP_RATE_LIMIT: RateLimitConfig = {
  perMinute: envInt("MCP_RATE_LIMIT_PER_MIN", 120),
  burst: envInt("MCP_RATE_LIMIT_BURST", 60),
};

/** Units for `list_notes` with no page and no narrowing: the whole vault. */
export const COST_WHOLE_VAULT_LIST = 20;
/** Units for `list_notes` narrowed to a folder or prefix but not paged. */
export const COST_NARROWED_LIST = 5;
/** Units for `search_notes`: ranks over the vault's whole index. */
export const COST_SEARCH = 5;

/**
 * What one `tools/call` costs. Ordinary calls cost 1; listings and search that
 * walk the whole vault cost more, so a loop of them is slowed long before a
 * loop of reads or edits is.
 */
export function toolCallCost(name: unknown, args: unknown): number {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const given = (k: string) => a[k] !== undefined && a[k] !== null;
  if (name === "list_notes") {
    if (given("limit") || given("cursor")) return 1;
    if (given("folderId") || given("pathPrefix")) return COST_NARROWED_LIST;
    return COST_WHOLE_VAULT_LIST;
  }
  if (name === "search_notes") return COST_SEARCH;
  return 1;
}

/** The bucket key for a connection: the token row, or the OAuth binding. */
export function rateLimitKey(auth: McpAuth): string {
  if (auth.tokenId) return `t:${auth.tokenId}`;
  return `o:${auth.oauthClientId ?? ""}:${auth.userId}:${auth.organizationId}`;
}

export type TakeResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Most buckets held at once; past it, full (idle) buckets go first. */
const MAX_BUCKETS = 10_000;

export class TokenBuckets {
  private readonly buckets = new Map<string, { units: number; at: number }>();

  constructor(private cfg: RateLimitConfig = MCP_RATE_LIMIT) {}

  /** Replace the limits and forget every bucket (tests). */
  configure(cfg: RateLimitConfig): void {
    this.cfg = cfg;
    this.buckets.clear();
  }

  get perMinute(): number {
    return this.cfg.perMinute;
  }

  private get perMs(): number {
    return this.cfg.perMinute / 60_000;
  }

  private level(b: { units: number; at: number }, now: number): number {
    return Math.min(this.cfg.burst, b.units + Math.max(0, now - b.at) * this.perMs);
  }

  get burst(): number {
    return this.cfg.burst;
  }

  /**
   * Take `cost` units for `key`, all or nothing. A refusal says how long until
   * that many units are there. A cost above the bucket size can never be
   * paid; callers cap a single call at {@link burst} and refuse a batch that
   * large outright.
   */
  take(key: string, cost: number, now = Date.now()): TakeResult {
    const existing = this.buckets.get(key);
    const units = existing ? this.level(existing, now) : this.cfg.burst;
    const need = cost;
    if (units < need) {
      if (existing) {
        existing.units = units;
        existing.at = now;
      }
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((need - units) / this.perMs / 1000)) };
    }
    if (!existing) this.evictIfFull(now);
    const left = units - need;
    if (existing) {
      existing.units = left;
      existing.at = now;
    } else {
      this.buckets.set(key, { units: left, at: now });
    }
    return { ok: true };
  }

  /** Keep the map bounded: a refilled bucket is the same as no bucket, so
   *  dropping those loses nothing; if every bucket is busy, drop the oldest. */
  private evictIfFull(now: number): void {
    if (this.buckets.size < MAX_BUCKETS) return;
    for (const [k, b] of this.buckets) {
      if (this.level(b, now) >= this.cfg.burst) this.buckets.delete(k);
    }
    while (this.buckets.size >= MAX_BUCKETS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
  }
}

/** The process-wide buckets the MCP route spends from. */
export const mcpBuckets = new TokenBuckets();

/** Test seam: forget every bucket and restore the configured limits. */
export function resetMcpRateLimit(): void {
  mcpBuckets.configure(MCP_RATE_LIMIT);
}
