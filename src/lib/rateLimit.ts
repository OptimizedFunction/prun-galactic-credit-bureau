// Token-bucket rate limiting.
//
// A bucket holds up to `capacity` tokens and refills at `refillPerSecond`. Each request takes one token;
// with none left the request is refused until enough time has passed. So short bursts are fine and a
// sustained flood is held to the refill rate.
//
// Two stores:
//   * MemoryBuckets: in this Worker instance's memory. Free and instant, but each instance counts on its
//     own, so the limit is approximate. Used for every API request, keyed by client address.
//   * takeFromDb: one atomic statement in D1, shared by all instances, so the limit is exact. It costs a
//     database write, so it is used for writes only, keyed by who is writing.

export interface BucketSpec {
  capacity: number;
  refillPerSecond: number;
}

export interface Take {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Seconds until one token is available again (0 when allowed). */
  retryAfterSeconds: number;
}

/** Every API request, per client address: bursts of 120, then 2 a second. */
export const READ_LIMIT: BucketSpec = { capacity: 120, refillPerSecond: 2 };
/** Edits and reports, per signed-in user or lender key: bursts of 60, then 1 a second. */
export const WRITE_LIMIT: BucketSpec = { capacity: 60, refillPerSecond: 1 };
/** Connecting a FIO key calls out to FIO, per user: 5 attempts, then 1 a minute. */
export const CONNECT_LIMIT: BucketSpec = { capacity: 5, refillPerSecond: 1 / 60 };

/** One step of the algorithm: refill for the time passed, then try to take a token. */
export function takeToken(tokens: number, lastMs: number, nowMs: number, spec: BucketSpec): { tokens: number; take: Take } {
  const elapsed = Math.max(0, nowMs - lastMs) / 1000;
  const filled = Math.min(spec.capacity, tokens + elapsed * spec.refillPerSecond);
  if (filled >= 1) return { tokens: filled - 1, take: { allowed: true, remaining: Math.floor(filled - 1), retryAfterSeconds: 0 } };
  return { tokens: filled, take: { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((1 - filled) / spec.refillPerSecond) } };
}

export class MemoryBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  /** Beyond this many keys, full (idle) buckets are dropped; they would start full again anyway. */
  constructor(private readonly maxKeys = 10_000) {}

  take(key: string, spec: BucketSpec, now = Date.now()): Take {
    const bucket = this.buckets.get(key) ?? { tokens: spec.capacity, at: now };
    const { tokens, take } = takeToken(bucket.tokens, bucket.at, now, spec);
    this.buckets.set(key, { tokens, at: now });
    if (this.buckets.size > this.maxKeys) this.prune(spec, now);
    return take;
  }

  private prune(spec: BucketSpec, now: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((now - b.at) / 1000) * spec.refillPerSecond >= spec.capacity) this.buckets.delete(key);
    }
  }
}

/**
 * Takes a token from a bucket stored in D1. The refill, the check and the take are one statement, so two
 * requests arriving together cannot both spend the last token.
 */
export async function takeFromDb(db: D1Database, key: string, spec: BucketSpec, now = Date.now()): Promise<Take> {
  const refilled = 'MIN(?2, tokens + MAX(0, ?4 - updated_ms) * ?3 / 1000.0)';
  const row = await db
    .prepare(
      `INSERT INTO rate_buckets (key, tokens, updated_ms) VALUES (?1, ?2 - 1, ?4)
       ON CONFLICT (key) DO UPDATE SET tokens = ${refilled} - 1, updated_ms = ?4 WHERE ${refilled} >= 1
       RETURNING tokens`,
    )
    .bind(key, spec.capacity, spec.refillPerSecond, now)
    .first<{ tokens: number }>();
  if (row) return { allowed: true, remaining: Math.floor(row.tokens), retryAfterSeconds: 0 };

  const state = await db.prepare('SELECT tokens, updated_ms FROM rate_buckets WHERE key = ?').bind(key).first<{ tokens: number; updated_ms: number }>();
  const have = state ? Math.min(spec.capacity, state.tokens + (Math.max(0, now - state.updated_ms) * spec.refillPerSecond) / 1000) : 0;
  return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((1 - have) / spec.refillPerSecond)) };
}

/** Removes buckets nobody has touched for a day; they would be full again by now. */
export async function pruneBuckets(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare('DELETE FROM rate_buckets WHERE updated_ms < ?').bind(now - 86_400_000).run();
}
