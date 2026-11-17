import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MemoryBuckets, pruneBuckets, takeFromDb, takeToken, type BucketSpec } from '../src/lib/rateLimit';
import { tempDatabase } from './helpers';

const SPEC: BucketSpec = { capacity: 3, refillPerSecond: 0.5 };
const T0 = 1_800_000_000_000;

let db: D1Database;
let dispose: () => Promise<void>;
before(async () => {
  ({ db, dispose } = await tempDatabase());
});
after(() => dispose());

test('a bucket allows a burst up to its capacity, then refills at its rate', () => {
  let tokens = SPEC.capacity;
  const taken: boolean[] = [];
  for (let i = 0; i < 4; i++) {
    const step = takeToken(tokens, T0, T0, SPEC);
    tokens = step.tokens;
    taken.push(step.take.allowed);
  }
  assert.deepEqual(taken, [true, true, true, false]);

  // Empty: at 0.5 tokens a second the next token is 2 seconds away.
  assert.deepEqual(takeToken(0, T0, T0, SPEC).take, { allowed: false, remaining: 0, retryAfterSeconds: 2 });
  assert.equal(takeToken(0, T0, T0 + 1000, SPEC).take.allowed, false, 'half a token is not enough');
  assert.equal(takeToken(0, T0, T0 + 2000, SPEC).take.allowed, true);
  // Refill never exceeds capacity, and a clock that runs backwards adds nothing.
  assert.equal(takeToken(0, T0, T0 + 3_600_000, SPEC).take.remaining, SPEC.capacity - 1);
  assert.equal(takeToken(0, T0, T0 - 5000, SPEC).take.allowed, false);
});

test('in-memory buckets are separate per key', () => {
  const buckets = new MemoryBuckets();
  const hits = (key: string, n: number, at: number) => Array.from({ length: n }, () => buckets.take(key, SPEC, at).allowed);
  assert.deepEqual(hits('a', 4, T0), [true, true, true, false]);
  assert.deepEqual(hits('b', 1, T0), [true], 'another address is unaffected');
  assert.equal(buckets.take('a', SPEC, T0 + 1000).allowed, false);
  assert.equal(buckets.take('a', SPEC, T0 + 2000).allowed, true);
  assert.equal(buckets.take('a', SPEC, T0 + 2000).retryAfterSeconds, 2);
});

test('database buckets behave the same and survive between requests', async () => {
  const take = (key: string, at: number) => takeFromDb(db, key, SPEC, at);
  assert.deepEqual([(await take('user:1', T0)).allowed, (await take('user:1', T0)).allowed, (await take('user:1', T0)).allowed], [true, true, true]);
  const refused = await take('user:1', T0);
  assert.deepEqual(refused, { allowed: false, remaining: 0, retryAfterSeconds: 2 });
  assert.equal((await take('user:2', T0)).allowed, true, 'another user is unaffected');

  assert.equal((await take('user:1', T0 + 1000)).allowed, false);
  assert.equal((await take('user:1', T0 + 2000)).allowed, true);
  // A long rest fills the bucket, but only to capacity.
  assert.equal((await take('user:1', T0 + 3_600_000)).remaining, SPEC.capacity - 1);
});

test('requests arriving together cannot overspend a database bucket', async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => takeFromDb(db, 'user:burst', SPEC, T0)));
  assert.equal(results.filter((r) => r.allowed).length, SPEC.capacity);
});

test('idle database buckets are pruned after a day', async () => {
  await takeFromDb(db, 'user:old', SPEC, T0);
  await takeFromDb(db, 'user:new', SPEC, T0 + 86_400_000);
  await pruneBuckets(db, T0 + 86_400_000 + 1000);
  const keys = (await db.prepare("SELECT key FROM rate_buckets WHERE key IN ('user:old', 'user:new')").all<{ key: string }>()).results.map((r) => r.key);
  assert.deepEqual(keys, ['user:new']);
});
