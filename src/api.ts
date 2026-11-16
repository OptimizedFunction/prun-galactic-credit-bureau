// Public API, mounted at /api/v1. Reading needs no key; editing needs a Discord sign-in. The contract is openapi.yaml.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { currentUser, type SessionUser } from './auth';
import * as edits from './db/edits';
import * as lenderKeys from './db/lenderKeys';
import * as q from './db/queries';
import { isCurrency, isStatus, normalizeContractId } from './lib/normalize';
import { seal } from './lib/secretbox';
import { fetchKeyOwner, fetchLoanContracts, fetchUser } from './sync/fio';
import { extractLoan } from './sync/plan';
import { runSync } from './sync/run';
import type { Env } from './env';

export const api = new Hono<{ Bindings: Env }>();

class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 415 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Integer "minor" fields are internal; the API exposes decimal strings only. */
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, (key, value) => (key.endsWith('Minor') ? undefined : value)), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

api.use('*', cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'OPTIONS'] }));

api.use('*', async (c, next) => {
  await next();
  if (c.req.method === 'GET' && c.res.status === 200 && !c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'public, max-age=60');
});

api.onError((err, c) => {
  if (err instanceof ApiError) return json({ error: { code: err.code, message: err.message } }, err.status);
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

api.get('/stats', async (c) => json(await q.getTotals(c.env.DB)));

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
  return json({ borrower, exposure, loans });
});

api.get('/lenders', async (c) => json({ lenders: await q.listLenders(c.env.DB) }));

api.get('/lenders/:username', async (c) => {
  const lender = await q.getLender(c.env.DB, c.req.param('username'));
  if (!lender) throw new ApiError(404, 'not_found', 'No such lender.');
  return json({ lender, exposure: await q.getLenderExposure(c.env.DB, lender.id) });
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
  const { expected, ...fields } = await jsonBody(c);
  if (expected !== undefined && (expected === null || typeof expected !== 'object' || Array.isArray(expected))) {
    throw new ApiError(400, 'bad_request', '"expected" must be an object of the values you were looking at.');
  }
  try {
    const changed = await edits.updateLoan(c.env.DB, id, edits.parseLoanFields(fields), user, {
      expected: expected ? edits.parseLoanFields(expected as Record<string, unknown>) : undefined,
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
