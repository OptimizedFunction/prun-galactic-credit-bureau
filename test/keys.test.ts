import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EditError } from '../src/db/edits';
import { connectLender, disconnectLender, listConnectedBy } from '../src/db/lenderKeys';
import { seal, unseal } from '../src/lib/secretbox';
import type { LoanFetchResult } from '../src/sync/fio';
import { runSync, trackedLenders } from '../src/sync/run';
import { tempDatabase } from './helpers';

const ANN = { id: '111', name: 'ann' };
const BEN = { id: '222', name: 'ben' };
const SECRET = 'test-secret';

let db: D1Database;
let dispose: () => Promise<void>;

before(async () => {
  ({ db, dispose } = await tempDatabase());
  await db.prepare("INSERT INTO lenders (username, tracking_mode) VALUES ('Granted', 'fio'), ('HandEntered', 'manual')").run();
});

after(() => dispose());

test('sealed values round-trip and cannot be read with another secret or after tampering', async () => {
  const sealed = await seal('my-fio-key', SECRET);
  assert.ok(!sealed.includes('my-fio-key'));
  assert.notEqual(sealed, await seal('my-fio-key', SECRET), 'a fresh nonce each time');
  assert.equal(await unseal(sealed, SECRET), 'my-fio-key');
  assert.equal(await unseal(sealed, 'other-secret'), null);
  assert.equal(await unseal(sealed.slice(0, -2) + 'AA', SECRET), null);
  assert.equal(await unseal('garbage', SECRET), null);
});

test('connecting a key switches a lender to automatic tracking and stores only ciphertext', async () => {
  await connectLender(db, 'NewLender', await seal('key-new', SECRET), ANN);
  await connectLender(db, 'handentered', await seal('key-hand', SECRET), ANN);

  const rows = (await db.prepare('SELECT username, tracking_mode, fio_key_enc, fio_key_added_by FROM lenders ORDER BY username').all<Record<string, string | null>>()).results;
  assert.deepEqual(
    rows.map((r) => [r['username'], r['tracking_mode'], r['fio_key_added_by']]),
    [['Granted', 'fio', null], ['HandEntered', 'fio', 'ann'], ['NewLender', 'fio', 'ann']],
  );
  for (const r of rows) assert.ok(!String(r['fio_key_enc']).includes('key-'), 'the key is never stored in the clear');
  assert.deepEqual((await listConnectedBy(db, ANN.id)).map((l) => l.username), ['HandEntered', 'NewLender']);

  // The audit trail records that a key was connected, not the key.
  const audit = (await db.prepare("SELECT actor, after_json FROM revisions WHERE entity_type = 'lender'").all<{ actor: string; after_json: string }>()).results;
  assert.equal(audit.length, 2);
  assert.ok(audit.every((a) => a.actor === 'ann' && !a.after_json.includes('key-')));
});

test('only lenders who connected a key are fetched, each with their own', async () => {
  const pick = async (keys: Parameters<typeof trackedLenders>[1]) => (await trackedLenders(db, keys)).map((l) => [l.username, l.key]);
  // "Granted" is marked as tracked but never connected a key, so it is not fetched: there is no shared key.
  assert.deepEqual(await pick({ keySecret: SECRET }), [['HandEntered', 'key-hand'], ['NewLender', 'key-new']]);
  // Wrong secret (it was rotated): stored keys are unreadable and each lender is told to connect again.
  assert.deepEqual(await pick({ keySecret: 'rotated' }), [['HandEntered', null], ['NewLender', null]]);
  const unreadable = (await trackedLenders(db, { keySecret: 'rotated' })).find((l) => l.username === 'NewLender')!;
  assert.match(unreadable.problem!, /connecting again/);
});

test('the sync uses those keys and reports a rejected key per lender', async () => {
  const used: [string, string][] = [];
  const summary = await runSync(
    db,
    { keySecret: SECRET },
    {
      fetchLoans: async (key: string, lender: string): Promise<LoanFetchResult> => {
        used.push([lender, key]);
        return lender === 'NewLender' ? { lender, httpStatus: 401, contracts: null, error: 'FIO rejected the API key' } : { lender, httpStatus: 200, contracts: [], error: null };
      },
      fetchCompany: async () => null,
    },
  );
  assert.deepEqual(used.sort(), [['HandEntered', 'key-hand'], ['NewLender', 'key-new']]);
  assert.equal(summary.lendersFailed, 1);
  const runs = (await db.prepare('SELECT le.username, s.http_status, s.error FROM sync_runs s JOIN lenders le ON le.id = s.lender_id ORDER BY le.username').all<Record<string, unknown>>()).results;
  assert.deepEqual(runs, [
    { username: 'HandEntered', http_status: 200, error: null },
    { username: 'NewLender', http_status: 401, error: 'FIO rejected the API key this lender connected' },
  ]);
});

test('only the person who connected a lender can disconnect it; the key is then gone', async () => {
  await assert.rejects(() => disconnectLender(db, 'NewLender', BEN), (err: unknown) => err instanceof EditError && err.kind === 'conflict');
  await assert.rejects(() => disconnectLender(db, 'Granted', ANN), (err: unknown) => err instanceof EditError && err.kind === 'not_found');

  await disconnectLender(db, 'newlender', ANN);
  const row = await db.prepare("SELECT tracking_mode, fio_key_enc, fio_key_added_by_id FROM lenders WHERE username = 'NewLender'").first<Record<string, unknown>>();
  assert.deepEqual(row, { tracking_mode: 'manual', fio_key_enc: null, fio_key_added_by_id: null });
  assert.deepEqual((await listConnectedBy(db, ANN.id)).map((l) => l.username), ['HandEntered']);
});

// ---- Reporting with a lender API key ----

test('a lender API key is issued only to whoever connected the lender, and only its hash is stored', async () => {
  const { createApiKey, lenderForApiKey, revokeApiKey } = await import('../src/db/lenderKeys');
  await assert.rejects(() => createApiKey(db, 'Granted', ANN), (err: unknown) => err instanceof EditError && /Connect this lender through FIO/.test(err.message));
  await assert.rejects(() => createApiKey(db, 'HandEntered', BEN), (err: unknown) => err instanceof EditError && /Only the person who connected/.test(err.message));

  const made = await createApiKey(db, 'handentered', ANN);
  assert.match(made.apiKey, /^pgcb_[A-Za-z0-9_-]{40,}$/);
  assert.equal(made.username, 'HandEntered');
  const stored = await db.prepare("SELECT api_key_hash, api_key_prefix FROM lenders WHERE username = 'HandEntered'").first<Record<string, string>>();
  assert.ok(!JSON.stringify(stored).includes(made.apiKey), 'the key itself is not stored');
  assert.equal(stored!['api_key_prefix'], made.apiKey.slice(0, 11));

  assert.equal((await lenderForApiKey(db, made.apiKey))!.username, 'HandEntered');
  assert.equal(await lenderForApiKey(db, made.apiKey + 'x'), null);
  assert.equal(await lenderForApiKey(db, 'not-a-key'), null);

  // Replacing the key retires the old one; revoking leaves none.
  const second = await createApiKey(db, 'HandEntered', ANN);
  assert.equal(await lenderForApiKey(db, made.apiKey), null);
  assert.equal((await lenderForApiKey(db, second.apiKey))!.username, 'HandEntered');
  await revokeApiKey(db, 'HandEntered', ANN);
  assert.equal(await lenderForApiKey(db, second.apiKey), null);
});

test('reporting a loan is idempotent by contract ID and labelled lender-reported', async () => {
  const { parseLoanFields, reportLoan } = await import('../src/db/edits');
  const q = await import('../src/db/queries');
  const lender = (await db.prepare("SELECT id, username FROM lenders WHERE username = 'HandEntered'").first<{ id: number; username: string }>())!;
  const report = { borrower: 'Ivy', principal: '3,000,000', currency: 'CIS', issuedOn: '2026-07-01', durationWeeks: 8, status: 'In Progress' };

  const first = await reportLoan(db, lender, 'ADV0001', parseLoanFields(report));
  assert.equal(first.created, true);
  const loan = (await q.getLoan(db, first.loanId))!;
  assert.deepEqual(
    { lender: loan.lender, contract: loan.contractId, trust: loan.trust, source: loan.source, autoTrack: loan.autoTrack, status: loan.status },
    { lender: 'HandEntered', contract: 'ADV0001', trust: 'lender_reported', source: 'api', autoTrack: false, status: 'in_progress' },
  );

  // The same report again changes nothing and records nothing.
  const again = await reportLoan(db, lender, 'ADV0001', parseLoanFields(report));
  assert.deepEqual({ created: again.created, changed: again.changed, id: again.loanId }, { created: false, changed: [], id: first.loanId });
  assert.equal((await q.getRevisions(db, 'loan', first.loanId)).length, 1);

  // A later report updates it, under the lender's name.
  const later = await reportLoan(db, lender, 'adv0001', parseLoanFields({ ...report, status: 'Complete' }));
  assert.deepEqual(later.changed, ['status']);
  const [revision] = await q.getRevisions(db, 'loan', first.loanId);
  assert.deepEqual({ actorType: revision!.actorType, actor: revision!.actor, actorId: revision!.actorId }, { actorType: 'lender', actor: 'HandEntered', actorId: `lender:${lender.id}` });
  assert.deepEqual((await q.getLoanHistory(db, first.loanId)).map((h) => [h.newStatus, h.source]), [['in_progress', 'api'], ['complete', 'api']]);

  // The body cannot move the loan to another lender or switch tracking on.
  await reportLoan(db, lender, 'ADV0001', parseLoanFields({ ...report, status: 'Complete', lender: 'Someone', autoTrack: true }));
  const still = (await q.getLoan(db, first.loanId))!;
  assert.deepEqual({ lender: still.lender, autoTrack: still.autoTrack }, { lender: 'HandEntered', autoTrack: false });
});

test('a lender cannot report over another lender, a FIO-tracked loan or a deleted one', async () => {
  const { createLoan, deleteLoan, parseLoanFields, reportLoan } = await import('../src/db/edits');
  const lender = (await db.prepare("SELECT id, username FROM lenders WHERE username = 'HandEntered'").first<{ id: number; username: string }>())!;
  const report = parseLoanFields({ borrower: 'Ivy', principal: '1', currency: 'AIC', issuedOn: '2026-07-01', status: 'Complete' });
  const refused = (contract: string, pattern: RegExp) =>
    assert.rejects(() => reportLoan(db, lender, contract, report), (err: unknown) => err instanceof EditError && err.kind === 'conflict' && pattern.test(err.message));

  await createLoan(db, parseLoanFields({ lender: 'Granted', borrower: 'Ivy', principal: '1', currency: 'AIC', issuedOn: '2026-07-01', status: 'In Progress', contractId: 'OTHERS1' }), ANN);
  await refused('OTHERS1', /another lender \(Granted\)/);

  const trackedId = await createLoan(db, parseLoanFields({ lender: 'HandEntered', borrower: 'Ivy', principal: '5', currency: 'AIC', issuedOn: '2026-07-01', status: 'In Progress', contractId: 'TRACKD1', autoTrack: true }), ANN);
  await refused('TRACKD1', /kept up to date from FIO/);
  assert.ok(trackedId > 0);

  const goneId = await createLoan(db, parseLoanFields({ lender: 'HandEntered', borrower: 'Ivy', principal: '1', currency: 'AIC', issuedOn: '2026-07-01', status: 'In Progress', contractId: 'GONE001' }), ANN);
  await deleteLoan(db, goneId, ANN);
  await refused('GONE001', /was deleted/);

  // A first report must be complete.
  await assert.rejects(() => reportLoan(db, lender, 'NEW0001', parseLoanFields({ borrower: 'Ivy' })), (err: unknown) => err instanceof EditError && err.kind === 'invalid');
});
