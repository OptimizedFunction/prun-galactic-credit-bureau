// Public API, mounted at /api/v1. Reading needs no key; editing needs a Discord sign-in; reporting needs a
// lender API key. The contract is openapi.yaml.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { currentUser, type SessionUser } from './auth';
import * as admin from './db/admin';
import * as edits from './db/edits';
import * as lenderKeys from './db/lenderKeys';
import * as q from './db/queries';
import { isCurrency, isStatus, normalizeContractId } from './lib/normalize';
import { CONNECT_LIMIT, MemoryBuckets, READ_LIMIT, takeFromDb, WRITE_LIMIT, type BucketSpec, type Take } from './lib/rateLimit';
import { seal } from './lib/secretbox';
import { fetchKeyOwner, fetchLoanContracts, fetchUser } from './sync/fio';
import { extractLoan } from './sync/plan';
import { runSync } from './sync/run';
import type { Env } from './env';

export const api = new Hono<{ Bindings: Env }>();

class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 415 | 429 | 502 | 503,
    readonly code: string,
    message: string,
    /** Extra response headers, e.g. Retry-After. */
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const tooMany = (take: Take, spec: BucketSpec, what: string): ApiError =>
  new ApiError(429, 'rate_limited', `Too many ${what}. Try again in ${take.retryAfterSeconds} second${take.retryAfterSeconds === 1 ? '' : 's'}.`, {
    'Retry-After': String(take.retryAfterSeconds),
    'RateLimit-Limit': String(spec.capacity),
    'RateLimit-Remaining': '0',
  });

/** Integer "minor" fields are internal; the API exposes decimal strings only. */
const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data, (key, value) => (key.endsWith('Minor') ? undefined : value)), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

api.use('*', cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'OPTIONS'] }));

// Every request draws on a token bucket for its client address (see lib/rateLimit.ts). Writes draw on a
// second, exact bucket per user or lender key, in editor() and lenderFromKey().
const addressBuckets = new MemoryBuckets();

api.use('*', async (c, next) => {
  const address = c.req.header('CF-Connecting-IP') ?? 'local';
  const take = addressBuckets.take(address, READ_LIMIT);
  if (!take.allowed) throw tooMany(take, READ_LIMIT, 'requests');
  await next();
  c.header('RateLimit-Limit', String(READ_LIMIT.capacity));
  c.header('RateLimit-Remaining', String(take.remaining));
});

api.use('*', async (c, next) => {
  await next();
  if (c.req.method === 'GET' && c.res.status === 200 && !c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'public, max-age=60');
});

api.onError((err, c) => {
  if (err instanceof ApiError) return json({ error: { code: err.code, message: err.message } }, err.status, err.headers);
  if (err instanceof edits.EditError) {
    const status = err.kind === 'invalid' ? 400 : err.kind === 'not_found' ? 404 : 409;
    return json({ error: { code: err.kind === 'invalid' ? 'bad_request' : err.kind, message: err.message } }, status);
  }
  console.error(err);
  return json({ error: { code: 'internal_error', message: 'Something went wrong.' } }, 500);
});

api.notFound(() => json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404));

function paging(query: Record<string, string>): { limit: number; offset: number } {
  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = query[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new ApiError(400, 'bad_request', `"${name}" must be a whole number from ${min} to ${max}.`);
    }
    return n;
  };
  return { limit: int('limit', 100, 1, 500), offset: int('offset', 0, 0, 1_000_000) };
}

function loanFilter(query: Record<string, string>): q.LoanFilter {
  const { status, currency } = query;
  if (status !== undefined && !isStatus(status)) throw new ApiError(400, 'bad_request', `Unknown status "${status}".`);
  if (currency !== undefined && !isCurrency(currency)) throw new ApiError(400, 'bad_request', `Unknown currency "${currency}".`);
  return {
    lender: query['lender'],
    borrower: query['borrower'],
    contractId: normalizeContractId(query['contractId']) ?? undefined,
    status,
    currency,
    ...paging(query),
  };
}

api.get('/stats', async (c) => {
  const totals = await q.getTotals(c.env.DB);
  return json({ ...totals, combined: q.combine(totals.exposure) });
});

api.get('/search', async (c) => {
  const term = (c.req.query('q') ?? '').trim();
  if (term.length < 2) throw new ApiError(400, 'bad_request', '"q" must be at least 2 characters.');
  return json(await q.search(c.env.DB, term));
});

api.get('/borrowers/:username', async (c) => {
  const borrower = await q.getBorrower(c.env.DB, c.req.param('username'));
  if (!borrower) throw new ApiError(404, 'not_found', 'No loans are recorded for this borrower.');
  const [exposure, { loans }] = await Promise.all([
    q.getBorrowerExposure(c.env.DB, borrower.id),
    q.listLoans(c.env.DB, { borrower: borrower.username, limit: 500, offset: 0 }),
  ]);
  return json({ borrower, exposure, combined: q.combine(exposure), loans });
});

/**
 * Everything on record about one company, as borrower and as lender, found by in-game username or company code.
 * Without `by`, the identifier is tried as a username first and then as a company code.
 */
api.get('/companies/:id', async (c) => {
  const id = c.req.param('id').trim();
  const by = c.req.query('by');
  if (by !== undefined && by !== 'username' && by !== 'code') throw new ApiError(400, 'bad_request', '"by" must be "username" or "code".');

  let matchedBy: 'username' | 'code' = by ?? 'username';
  let matches = await q.findCompanies(c.env.DB, id, matchedBy);
  if (matches.length === 0 && by === undefined) {
    matchedBy = 'code';
    matches = await q.findCompanies(c.env.DB, id, 'code');
  }
  if (matches.length === 0) throw new ApiError(404, 'not_found', 'Nothing is recorded under this username or company code.');
  if (matches.length > 1) {
    return json({ error: { code: 'ambiguous', message: `Company code ${id.toUpperCase()} has been recorded against more than one player. Ask for one of them by username.` }, matches }, 300);
  }

  const match = matches[0]!;
  const [borrower, lender] = await Promise.all([q.getBorrower(c.env.DB, match.username), q.getLender(c.env.DB, match.username)]);
  const [asBorrower, asLender] = await Promise.all([
    borrower
      ? Promise.all([q.getBorrowerExposure(c.env.DB, borrower.id), q.listLoans(c.env.DB, { borrower: borrower.username, limit: 500, offset: 0 })]).then(
          ([exposure, { loans, total }]) => ({ exposure, combined: q.combine(exposure), loans, totalLoans: total }),
        )
      : null,
    lender
      ? Promise.all([q.getLenderExposure(c.env.DB, lender.id), q.listLoans(c.env.DB, { lender: lender.username, limit: 500, offset: 0 })]).then(
          ([exposure, { loans, total }]) => ({ trackingMode: lender.trackingMode, exposure, combined: q.combine(exposure), loans, totalLoans: total }),
        )
      : null,
  ]);
  return json({
    company: { username: match.username, companyCode: match.companyCode ?? lender?.companyCode ?? null, corpCode: match.corpCode, aliases: borrower?.aliases ?? [] },
    matchedBy,
    asBorrower,
    asLender,
  });
});

api.get('/lenders', async (c) => {
  const lenders = await q.listLenders(c.env.DB);
  return json({ lenders: lenders.map((l) => ({ ...l, combined: q.combine(l.exposure) })) });
});

api.get('/lenders/:username', async (c) => {
  const lender = await q.getLender(c.env.DB, c.req.param('username'));
  if (!lender) throw new ApiError(404, 'not_found', 'No such lender.');
  const exposure = await q.getLenderExposure(c.env.DB, lender.id);
  return json({ lender, exposure, combined: q.combine(exposure) });
});

api.get('/lenders/:username/loans', async (c) => {
  const lender = await q.getLender(c.env.DB, c.req.param('username'));
  if (!lender) throw new ApiError(404, 'not_found', 'No such lender.');
  const filter = { ...loanFilter(c.req.query()), lender: lender.username };
  return json({ ...(await q.listLoans(c.env.DB, filter)), limit: filter.limit, offset: filter.offset });
});

api.get('/loans', async (c) => {
  const filter = loanFilter(c.req.query());
  return json({ ...(await q.listLoans(c.env.DB, filter)), limit: filter.limit, offset: filter.offset });
});

api.get('/loans/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) throw new ApiError(400, 'bad_request', 'Loan ID must be a positive whole number.');
  const loan = await q.getLoan(c.env.DB, id);
  if (!loan) throw new ApiError(404, 'not_found', 'No such loan.');
  const [statusHistory, revisions] = await Promise.all([q.getLoanHistory(c.env.DB, id), q.getRevisions(c.env.DB, 'loan', id)]);
  return json({ loan, statusHistory, revisions });
});

api.get('/leaderboards', async (c) => json(await q.getLeaderboards(c.env.DB)));

api.get('/sync', async (c) => json({ lenders: await q.getSyncHealth(c.env.DB) }));

// ---- Editing (signed-in users) ----

type Ctx = Parameters<typeof currentUser>[0];

/** Requires a signed-in user and a same-origin JSON request (the session is a cookie, so cross-site writes are refused). */
async function editor(c: Ctx): Promise<SessionUser> {
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin) throw new ApiError(403, 'forbidden', 'Edits must come from this site.');
  const user = await currentUser(c);
  if (!user) throw new ApiError(401, 'unauthorized', 'Sign in with Discord first.');
  // Reading your own connected lenders is not a write.
  if (c.req.method !== 'GET') {
    if (await admin.isBlocked(c.env.DB, user.id)) throw new ApiError(403, 'blocked', 'This account has been blocked from making changes. Contact a maintainer if you think that is a mistake.');
    const take = await takeFromDb(c.env.DB, `user:${user.id}`, WRITE_LIMIT);
    if (!take.allowed) throw tooMany(take, WRITE_LIMIT, 'changes');
  }
  return user;
}

async function jsonBody(c: Ctx): Promise<Record<string, unknown>> {
  if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'bad_request', 'Send JSON (Content-Type: application/json).');
  }
  const body: unknown = await c.req.json().catch(() => null);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'bad_request', 'The request body must be a JSON object.');
  return body as Record<string, unknown>;
}

function loanId(c: Ctx): number {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) throw new ApiError(400, 'bad_request', 'Loan ID must be a positive whole number.');
  return id;
}

api.post('/loans', async (c) => {
  const user = await editor(c);
  const id = await edits.createLoan(c.env.DB, edits.parseLoanFields(await jsonBody(c)), user);
  return json({ loan: await q.getLoan(c.env.DB, id) }, 201);
});

api.patch('/loans/:id', async (c) => {
  const user = await editor(c);
  const id = loanId(c);
  const { expected, ...sent } = await jsonBody(c);
  if (expected !== undefined && (expected === null || typeof expected !== 'object' || Array.isArray(expected))) {
    throw new ApiError(400, 'bad_request', '"expected" must be an object of the values you were looking at.');
  }
  // The bureau sets a loan's trust label and records reasons itself. An undo echoes back what a revision
  // held, which can include both, so they are dropped here instead of being refused.
  const editable = (values: Record<string, unknown>) => {
    const { trust: _trust, reason: _reason, ...rest } = values;
    return rest;
  };
  const fields = editable(sent);
  try {
    const changed = await edits.updateLoan(c.env.DB, id, edits.parseLoanFields(fields), user, {
      expected: expected ? edits.parseLoanFields(editable(expected as Record<string, unknown>)) : undefined,
    });
    return json({ loan: await q.getLoan(c.env.DB, id), changed });
  } catch (err) {
    // On a conflict, send the loan as it is now so the editor can show the current values.
    if (err instanceof edits.EditError && err.kind === 'conflict') {
      return json({ error: { code: 'conflict', message: err.message }, loan: await q.getLoan(c.env.DB, id) }, 409);
    }
    throw err;
  }
});

api.delete('/loans/:id', async (c) => {
  const user = await editor(c);
  const id = loanId(c);
  await edits.deleteLoan(c.env.DB, id, user);
  return json({ loan: await q.getLoan(c.env.DB, id) });
});

api.post('/loans/:id/restore', async (c) => {
  const user = await editor(c);
  const id = loanId(c);
  await edits.restoreLoan(c.env.DB, id, user);
  return json({ loan: await q.getLoan(c.env.DB, id) });
});

api.get('/changes', async (c) => {
  const { limit, offset } = paging(c.req.query());
  const changes = await q.listChanges(c.env.DB, { includeSystem: c.req.query('system') === '1', limit, offset });
  return json({ changes, limit, offset });
});

/** Loans changed since a moment in time, including deleted ones. The ledger polls this to pick up other people's edits. */
api.get('/updates', async (c) => {
  const since = c.req.query('since') ?? '';
  const sinceMs = Date.parse(since);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(since) || Number.isNaN(sinceMs)) throw new ApiError(400, 'bad_request', '"since" must be an ISO 8601 time.');
  const cursor = new Date().toISOString();
  // Look a few seconds further back than asked, so a write stamped just before the last poll is never missed.
  const loans = await q.listLoansUpdatedSince(c.env.DB, new Date(sinceMs - 5000).toISOString());
  return new Response(JSON.stringify({ loans, cursor }, (key, value) => (key.endsWith('Minor') ? undefined : value)), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
});

// ---- Lenders connecting their own FIO API key ----

api.get('/fio-keys', async (c) => {
  const user = await editor(c);
  return new Response(JSON.stringify({ lenders: await lenderKeys.listConnectedBy(c.env.DB, user.id) }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
});

api.post('/fio-keys', async (c) => {
  const user = await editor(c);
  const secret = c.env.FIO_KEY_SECRET;
  if (!secret) throw new ApiError(503, 'unavailable', 'Connecting a FIO key is not set up on this server.');
  // Each attempt calls out to FIO, so it has its own, tighter bucket.
  const attempt = await takeFromDb(c.env.DB, `connect:${user.id}`, CONNECT_LIMIT);
  if (!attempt.allowed) throw tooMany(attempt, CONNECT_LIMIT, 'attempts to connect a key');
  const body = await jsonBody(c);
  const apiKey = typeof body['apiKey'] === 'string' ? body['apiKey'].trim() : '';
  if (apiKey.length < 8 || apiKey.length > 200 || /\s/.test(apiKey)) throw new ApiError(400, 'bad_request', 'That does not look like a FIO API key.');

  // FIO says whose key this is, so the lender never types (or mistypes) a username.
  let owner: string | null;
  try {
    owner = await fetchKeyOwner(apiKey);
  } catch {
    throw new ApiError(502, 'fio_unreachable', 'Could not reach FIO to check the key. Try again in a minute.');
  }
  if (owner === null) throw new ApiError(400, 'bad_request', 'FIO does not recognise that API key. Check you copied all of it.');

  // FIO names the key's owner in upper case; their profile has the real capitalisation and company code.
  // An existing lender keeps the spelling already on record.
  const [existing, profile] = await Promise.all([q.getLender(c.env.DB, owner), fetchUser(apiKey, owner)]);
  const name = existing?.username ?? profile?.username ?? owner;
  const fetched = await fetchLoanContracts(apiKey, name);
  if (fetched.contracts === null) throw new ApiError(502, 'fio_unreachable', `FIO would not return this account's loan contracts (${fetched.error}).`);
  const loansFound = fetched.contracts.filter((contract) => typeof extractLoan(contract) !== 'string').length;

  await lenderKeys.connectLender(c.env.DB, name, await seal(apiKey, secret), user, { companyCode: profile?.companyCode });
  // Bring their loans in straight away instead of waiting for the hourly run.
  c.executionCtx.waitUntil(runSync(c.env.DB, { bureauKey: c.env.FIO_API_KEY, keySecret: secret }).catch((err) => console.error('Sync after connecting a key failed', err)));

  return json({ lender: { username: name, trackingMode: 'fio' }, contractsFound: fetched.contracts.length, loansFound }, 201);
});

api.delete('/fio-keys/:username', async (c) => {
  const user = await editor(c);
  await lenderKeys.disconnectLender(c.env.DB, c.req.param('username'), user);
  return json({ ok: true });
});

// ---- Lenders reporting loans with an API key ----

/** The lender whose API key came with the request ("Authorization: Bearer <key>"). */
async function lenderFromKey(c: Ctx): Promise<{ id: number; username: string }> {
  const header = c.req.header('Authorization') ?? '';
  const key = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
  const lender = key ? await lenderKeys.lenderForApiKey(c.env.DB, key) : null;
  if (!lender) throw new ApiError(401, 'unauthorized', 'Send your lender API key as "Authorization: Bearer <key>".');
  if (await admin.isBlocked(c.env.DB, `lender:${lender.id}`)) throw new ApiError(403, 'blocked', 'This lender key has been blocked from reporting. Contact a maintainer if you think that is a mistake.');
  const take = await takeFromDb(c.env.DB, `lender:${lender.id}`, WRITE_LIMIT);
  if (!take.allowed) throw tooMany(take, WRITE_LIMIT, 'reports');
  return lender;
}

/** Report a loan. Idempotent by contract ID: create on first sight, update after, nothing if unchanged. */
api.put('/lenders/:username/loans/:contractId', async (c) => {
  const lender = await lenderFromKey(c);
  if (lender.username.toLowerCase() !== c.req.param('username').toLowerCase()) {
    throw new ApiError(403, 'forbidden', `This key belongs to ${lender.username}. A lender can only report their own loans.`);
  }
  const contractId = normalizeContractId(c.req.param('contractId'));
  if (contractId === null || !/^[A-Z0-9]{1,16}$/.test(contractId)) throw new ApiError(400, 'bad_request', 'The contract ID must be 1 to 16 letters and digits.');

  const result = await edits.reportLoan(c.env.DB, lender, contractId, edits.parseLoanFields(await jsonBody(c)));
  return json({ loan: await q.getLoan(c.env.DB, result.loanId), created: result.created, changed: result.changed }, result.created ? 201 : 200);
});

/** Create (or replace) the reporting API key of a lender the signed-in user connected. The key is shown this once. */
api.post('/lender-keys', async (c) => {
  const user = await editor(c);
  const body = await jsonBody(c);
  const username = typeof body['username'] === 'string' ? body['username'].trim() : '';
  if (username === '') throw new ApiError(400, 'bad_request', 'Say which lender the key is for ("username").');
  return json(await lenderKeys.createApiKey(c.env.DB, username, user), 201, { 'Cache-Control': 'no-store' });
});

api.delete('/lender-keys/:username', async (c) => {
  const user = await editor(c);
  await lenderKeys.revokeApiKey(c.env.DB, c.req.param('username'), user);
  return json({ ok: true });
});

// ---- Maintainers: block an account, roll back its changes ----

async function maintainer(c: Ctx): Promise<SessionUser> {
  const user = await editor(c);
  if (!admin.isAdmin(c.env.ADMIN_DISCORD_IDS, user.id)) throw new ApiError(403, 'forbidden', 'Only maintainers can do this.');
  return user;
}

const noStore = { 'Cache-Control': 'no-store' };

api.get('/admin/blocks', async (c) => {
  await maintainer(c);
  return json({ blocks: await admin.listBlocks(c.env.DB) }, 200, noStore);
});

api.post('/admin/blocks', async (c) => {
  const user = await maintainer(c);
  const body = await jsonBody(c);
  const actorId = typeof body['actorId'] === 'string' ? body['actorId'].trim() : '';
  if (actorId === '' || actorId.length > 80) throw new ApiError(400, 'bad_request', '"actorId" is required: a Discord user ID, or "lender:<id>".');
  if (actorId === user.id) throw new ApiError(400, 'bad_request', 'You cannot block yourself.');
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 300) : null);
  await admin.block(c.env.DB, actorId, text(body['name']), text(body['reason']), user);
  return json({ blocks: await admin.listBlocks(c.env.DB) }, 201, noStore);
});

api.delete('/admin/blocks/:actorId', async (c) => {
  await maintainer(c);
  await admin.unblock(c.env.DB, c.req.param('actorId'));
  return json({ blocks: await admin.listBlocks(c.env.DB) }, 200, noStore);
});

/** Undo everything one account changed since a moment in time. Fields someone else changed afterwards are left alone. */
api.post('/admin/rollback', async (c) => {
  const user = await maintainer(c);
  const body = await jsonBody(c);
  const actorId = typeof body['actorId'] === 'string' ? body['actorId'].trim() : '';
  const since = typeof body['since'] === 'string' ? body['since'].trim() : '';
  if (actorId === '') throw new ApiError(400, 'bad_request', '"actorId" is required: a Discord user ID, or "lender:<id>".');
  if (actorId === 'system') throw new ApiError(400, 'bad_request', 'The system\'s own changes cannot be rolled back this way.');
  if (Number.isNaN(Date.parse(since))) throw new ApiError(400, 'bad_request', '"since" must be an ISO 8601 time.');
  const reason = typeof body['reason'] === 'string' && body['reason'].trim() !== '' ? body['reason'].trim().slice(0, 300) : undefined;
  const result = await admin.rollbackActor(c.env.DB, actorId, new Date(since).toISOString(), user, reason);
  return json(result, 200, noStore);
});
