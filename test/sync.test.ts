import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FioContract, LoanFetchResult } from '../src/sync/fio';
import { extractLoan, pastGrace, planSync, type ExistingLoan, type FioLoan } from '../src/sync/plan';
import { seal } from '../src/lib/secretbox';
import { runSync } from '../src/sync/run';
import { tempDatabase } from './helpers';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const ISSUED = Date.parse('2026-01-01T00:00:00Z');

/** A loan contract as FIO returns it to the lender: 10,000 AIC over `weeks` weekly installments. */
function contract(id: string, status: string, over: Partial<FioContract> = {}, weeks = 4): FioContract {
  return {
    ContractLocalId: id,
    Status: status,
    Party: 'PROVIDER',
    PartnerName: 'Acme Mining',
    DateEpochMs: ISSUED,
    Conditions: [
      { Type: 'LOAN_PAYOUT', Party: 'PROVIDER', Amount: 10000, Currency: 'AIC', ConditionIndex: 0 },
      ...Array.from({ length: weeks }, (_, i) => ({
        Type: 'LOAN_INSTALLMENT',
        Party: 'CUSTOMER',
        Amount: 2600,
        Currency: 'AIC',
        DeadlineDurationMs: WEEK,
        // FIO gives a deadline date only for the installment currently due.
        DeadlineEpochMs: i === 0 ? ISSUED + WEEK : null,
        ConditionIndex: i + 1,
      })),
    ],
    ...over,
  };
}

const loan = (id: string, status: string, over: Partial<FioContract> = {}, weeks = 4) => extractLoan(contract(id, status, over, weeks)) as FioLoan;

const existing = (over: Partial<ExistingLoan>): ExistingLoan => ({
  id: 1,
  contractId: 'AAAAAAA',
  lender: 'Lena',
  status: 'in_progress',
  autoTrack: true,
  trust: 'fio_verified',
  principalMinor: 1_000_000,
  currency: 'AIC',
  issuedOn: '2026-01-01',
  durationWeeks: 4,
  ...over,
});

// A 4-week loan issued 2026-01-01 matures 2026-01-29; a grace of 91 days ends 2026-04-30.
const DURING = new Date('2026-01-20T00:00:00Z');
const BEFORE_GRACE_END = new Date('2026-04-29T00:00:00Z');
const AFTER_GRACE_END = new Date('2026-05-02T00:00:00Z');

test('extractLoan reads a lender-side loan', () => {
  const l = loan(' aaaaaaa', 'PARTIALLY_FULFILLED');
  assert.equal(l.contractId, 'AAAAAAA');
  assert.equal(l.principalMinor, 1_000_000);
  assert.equal(l.currency, 'AIC');
  assert.equal(l.issuedOn, '2026-01-01');
  assert.equal(l.durationWeeks, 4);
  assert.equal(l.status, 'in_progress');
  assert.equal(l.partnerName, 'Acme Mining');
});

test('duration is the sum of installment intervals, with a fallback for contracts that lack them', () => {
  const noIntervals = contract('C', 'PARTIALLY_FULFILLED', {}, 10);
  noIntervals.Conditions.forEach((c) => delete c.DeadlineDurationMs);
  assert.equal((extractLoan(noIntervals) as FioLoan).durationWeeks, 10);
  assert.equal(loan('C', 'PARTIALLY_FULFILLED', {}, 23).durationWeeks, 23);
  const noInstallments = contract('C', 'PARTIALLY_FULFILLED', {}, 0);
  assert.equal((extractLoan(noInstallments) as FioLoan).durationWeeks, null);
});

test('extractLoan skips loans received, non-loans and offers that never went live', () => {
  assert.equal(extractLoan(contract('B', 'FULFILLED', { Party: 'CUSTOMER' })), 'not_the_lender');
  assert.equal(extractLoan(contract('B', 'FULFILLED', { Conditions: [{ Type: 'PAYMENT', Party: 'PROVIDER', Amount: 1, Currency: 'AIC' }] })), 'not_a_loan');
  for (const s of ['OPEN', 'CLOSED', 'REJECTED', 'CANCELLED']) assert.equal(extractLoan(contract('B', s)), 'not_live');
  assert.equal(extractLoan(contract('B', 'FULFILLED', { PartnerName: '' })), 'unusable');
});

test('grace is measured from maturity, not issue date', () => {
  // 20-week loan: 91 days after issue it is still mid-term, so it must not be stale.
  assert.equal(pastGrace('2026-01-01', 20, new Date('2026-04-15T00:00:00Z'), 91), false);
  assert.equal(pastGrace('2026-01-01', 4, BEFORE_GRACE_END, 91), false);
  assert.equal(pastGrace('2026-01-01', 4, AFTER_GRACE_END, 91), true);
  assert.equal(pastGrace('2026-01-01', null, AFTER_GRACE_END, 91), false);
});

test('plan: new contract is inserted, unchanged one is left alone', () => {
  const actions = planSync([existing({})], [{ lender: 'Lena', loans: [loan('AAAAAAA', 'PARTIALLY_FULFILLED'), loan('BBBBBBB', 'PARTIALLY_FULFILLED')] }], DURING);
  assert.deepEqual(actions.map((a) => [a.kind, a.kind === 'insert' ? a.loan.contractId : '']), [['insert', 'BBBBBBB']]);
});

test('plan: tracked loan follows FIO status', () => {
  const [a] = planSync([existing({})], [{ lender: 'Lena', loans: [loan('AAAAAAA', 'BREACHED')] }], DURING);
  assert.deepEqual([a!.kind, a!.kind === 'status' && a!.from, a!.kind === 'status' && a!.to], ['status', 'in_progress', 'breached']);
});

test('plan: loan FIO no longer returns goes stale only after maturity + grace', () => {
  const none = [{ lender: 'Lena', loans: [] }];
  assert.equal(planSync([existing({})], none, BEFORE_GRACE_END).length, 0);
  const [a] = planSync([existing({})], none, AFTER_GRACE_END);
  assert.deepEqual([a!.kind, a!.kind === 'status' && a!.to], ['status', 'stale']);
});

test('plan: loan FIO still shows active long after maturity goes stale', () => {
  const [a] = planSync([existing({})], [{ lender: 'Lena', loans: [loan('AAAAAAA', 'DEADLINE_EXCEEDED')] }], AFTER_GRACE_END);
  assert.deepEqual([a!.kind, a!.kind === 'status' && a!.to], ['status', 'stale']);
});

test('plan: stale never replaces a resolved status, but a real FIO status replaces stale', () => {
  for (const status of ['complete', 'breached', 'terminated'] as const) {
    assert.equal(planSync([existing({ status })], [{ lender: 'Lena', loans: [] }], AFTER_GRACE_END).length, 0, `${status} not returned`);
    assert.equal(planSync([existing({ status })], [{ lender: 'Lena', loans: [loan('AAAAAAA', 'PARTIALLY_FULFILLED')] }], AFTER_GRACE_END).length, 0, `${status} vs stale copy`);
  }
  const [a] = planSync([existing({ status: 'stale' })], [{ lender: 'Lena', loans: [loan('AAAAAAA', 'FULFILLED')] }], AFTER_GRACE_END);
  assert.deepEqual([a!.kind, a!.kind === 'status' && a!.to], ['status', 'complete']);
});

test('plan: duration is refreshed from FIO on tracked loans only', () => {
  const fio = [{ lender: 'Lena', loans: [loan('AAAAAAA', 'PARTIALLY_FULFILLED', {}, 10)] }];
  const [a] = planSync([existing({ durationWeeks: 0 })], fio, DURING);
  assert.deepEqual(a, { kind: 'duration', loanId: 1, contractId: 'AAAAAAA', from: 0, to: 10 });
  assert.equal(planSync([existing({ durationWeeks: 10 })], fio, DURING).length, 0, 'same duration');
  const manual = planSync([existing({ durationWeeks: 0, autoTrack: false })], fio, DURING);
  assert.equal(manual.filter((x) => x.kind === 'duration').length, 0, 'manual rows keep their duration');
});

test('plan: a lender whose fetch failed is left alone', () => {
  assert.equal(planSync([existing({})], [{ lender: 'Lena', loans: null }], AFTER_GRACE_END).length, 0);
});

test('plan: manual rows are never changed, only verified when FIO agrees', () => {
  const manual = existing({ autoTrack: false, trust: 'community_edited', status: 'complete' });
  const [a] = planSync([manual], [{ lender: 'Lena', loans: [loan('AAAAAAA', 'BREACHED')] }], DURING);
  assert.equal(a!.kind, 'verify');
  // Different amount: FIO does not confirm the row, so nothing happens.
  assert.equal(planSync([{ ...manual, principalMinor: 5 }], [{ lender: 'Lena', loans: [loan('AAAAAAA', 'BREACHED')] }], DURING).length, 0);
});

test('plan: a tracked loan handed back after a lender report is verified again once FIO agrees', () => {
  const handedBack = existing({ trust: 'lender_reported' });
  const fio = [{ lender: 'Lena', loans: [loan('AAAAAAA', 'PARTIALLY_FULFILLED')] }];
  assert.deepEqual(planSync([handedBack], fio, DURING).map((a) => a.kind), ['verify']);
  // The lender reported a different amount: FIO does not confirm it, so the label stays.
  assert.equal(planSync([{ ...handedBack, principalMinor: 5 }], fio, DURING).filter((a) => a.kind === 'verify').length, 0);
});

// ---- runSync against a real (temporary) D1 database ----

const SECRET = 'test-secret';
let db: D1Database;
let dispose: () => Promise<void>;

before(async () => {
  ({ db, dispose } = await tempDatabase());
  await db.batch([
    // Lena and Denied connected a FIO key; Manual did not, so the sync never fetches them.
    db.prepare("INSERT INTO lenders (username, tracking_mode, fio_key_enc) VALUES ('Lena', 'fio', ?1), ('Denied', 'fio', ?1), ('Manual', 'manual', NULL)").bind(await seal('key', SECRET)),
    db.prepare("INSERT INTO borrowers (username, company_code) VALUES ('oldtimer', 'OLD')"),
    // A tracked loan that will be breached, and a manual row the sync must not alter.
    db.prepare(
      `INSERT INTO loans (contract_id, lender_id, borrower_id, principal_minor, currency, issued_on, duration_weeks, status, trust, source, auto_track)
       VALUES ('AAAAAAA', 1, 1, 1000000, 'AIC', '2026-01-01', 0, 'in_progress', 'fio_verified', 'sheet_import', 1),
              ('MMMMMMM', 1, 1, 1000000, 'AIC', '2026-01-01', 0, 'complete', 'community_edited', 'sheet_import', 0)`,
    ),
  ]);
});

after(() => dispose());

test('runSync writes loans, history, borrowers and sync results, and is idempotent', async () => {
  const companyLookups: string[] = [];
  const deps = {
    now: DURING,
    fetchLoans: async (_key: string, lender: string): Promise<LoanFetchResult> =>
      lender === 'Denied'
        ? { lender, httpStatus: 401, contracts: null, error: 'FIO rejected the API key' }
        : {
            lender,
            httpStatus: 200,
            error: null,
            contracts: [
              contract('AAAAAAA', 'BREACHED'),
              contract('MMMMMMM', 'BREACHED'),
              contract('NEWLOAN', 'PARTIALLY_FULFILLED'),
              contract('GONECO1', 'FULFILLED', { PartnerName: 'Liquidated Co' }),
              contract('RECEIVD', 'PARTIALLY_FULFILLED', { Party: 'CUSTOMER' }),
              contract('OFFERED', 'OPEN'),
            ],
          },
    fetchCompany: async (_key: string, name: string) => {
      companyLookups.push(name);
      return name === 'Acme Mining' ? { username: 'acme_owner', companyCode: 'ACME', corpCode: 'CORP' } : null;
    },
  };

  const first = await runSync(db, { keySecret: SECRET }, deps);
  assert.deepEqual(
    { inserted: first.inserted, statusChanges: first.statusChanges, verified: first.verified, lendersFailed: first.lendersFailed, lenders: first.lenders },
    { inserted: 2, statusChanges: 1, verified: 1, lendersFailed: 1, lenders: 2 },
  );
  assert.deepEqual(companyLookups.sort(), ['Acme Mining', 'Liquidated Co'], 'one lookup per unknown company');
  assert.equal(first.durationsRefreshed, 1);
  const durations = (await db.prepare("SELECT contract_id, duration_weeks FROM loans WHERE contract_id IN ('AAAAAAA', 'MMMMMMM') ORDER BY contract_id").all<Record<string, unknown>>()).results;
  assert.deepEqual(durations, [
    { contract_id: 'AAAAAAA', duration_weeks: 4 },
    // Manual row: verified, but its duration is left as entered.
    { contract_id: 'MMMMMMM', duration_weeks: 0 },
  ]);

  const loans = (await db.prepare('SELECT contract_id, status, trust, auto_track, source FROM loans ORDER BY contract_id').all<Record<string, unknown>>()).results;
  assert.deepEqual(loans, [
    { contract_id: 'AAAAAAA', status: 'breached', trust: 'fio_verified', auto_track: 1, source: 'sheet_import' },
    { contract_id: 'GONECO1', status: 'complete', trust: 'fio_verified', auto_track: 1, source: 'fio' },
    { contract_id: 'MMMMMMM', status: 'complete', trust: 'fio_verified', auto_track: 0, source: 'sheet_import' },
    { contract_id: 'NEWLOAN', status: 'in_progress', trust: 'fio_verified', auto_track: 1, source: 'fio' },
  ]);

  const borrowers = (await db.prepare('SELECT username, company_code, company_name FROM borrowers ORDER BY id').all<Record<string, unknown>>()).results;
  assert.deepEqual(borrowers, [
    { username: 'oldtimer', company_code: 'OLD', company_name: null },
    { username: 'acme_owner', company_code: 'ACME', company_name: 'Acme Mining' },
    // Lookup failed: the company name stands in for the username.
    { username: 'Liquidated Co', company_code: null, company_name: 'Liquidated Co' },
  ]);

  const history = (
    await db
      .prepare('SELECT l.contract_id, h.old_status, h.new_status FROM loan_status_history h JOIN loans l ON l.id = h.loan_id ORDER BY l.contract_id')
      .all<Record<string, unknown>>()
  ).results;
  assert.deepEqual(history, [
    { contract_id: 'AAAAAAA', old_status: 'in_progress', new_status: 'breached' },
    { contract_id: 'GONECO1', old_status: null, new_status: 'complete' },
    { contract_id: 'NEWLOAN', old_status: null, new_status: 'in_progress' },
  ]);

  const runs = (
    await db
      .prepare('SELECT le.username, s.http_status, s.contracts_returned, s.loans_kept FROM sync_runs s JOIN lenders le ON le.id = s.lender_id ORDER BY le.username')
      .all<Record<string, unknown>>()
  ).results;
  assert.deepEqual(runs, [
    { username: 'Denied', http_status: 401, contracts_returned: null, loans_kept: null },
    { username: 'Lena', http_status: 200, contracts_returned: 6, loans_kept: 4 },
  ]);

  // Second run with the same data: nothing new, no duplicate loans or history, no repeat company lookups.
  companyLookups.length = 0;
  const second = await runSync(db, { keySecret: SECRET }, { ...deps, now: new Date(DURING.getTime() + 3_600_000) });
  assert.deepEqual({ inserted: second.inserted, statusChanges: second.statusChanges, verified: second.verified, durationsRefreshed: second.durationsRefreshed },
    { inserted: 0, statusChanges: 0, verified: 0, durationsRefreshed: 0 },
  );
  assert.equal(companyLookups.length, 0);
  const counts = await db
    .prepare('SELECT (SELECT COUNT(*) FROM loans) AS loans, (SELECT COUNT(*) FROM loan_status_history) AS history, (SELECT COUNT(*) FROM fio_raw) AS raw')
    .first<Record<string, number>>();
  assert.deepEqual(counts, { loans: 4, history: 3, raw: 3 });
});

test('runSync writes nothing per loan while FIO keeps returning it, and notes when it stops', async () => {
  const checked = (contractId: string) =>
    db
      .prepare(
        `SELECT l.fio_seen, CASE WHEN l.fio_seen = 1 THEN COALESCE(le.fio_checked_at, l.last_synced_at) ELSE l.last_synced_at END AS checked, l.version
         FROM loans l JOIN lenders le ON le.id = l.lender_id WHERE l.contract_id = ?`,
      )
      .bind(contractId)
      .first<{ fio_seen: number; checked: string; version: number }>();
  const run = (at: Date, ids: string[]) =>
    runSync(db, { keySecret: SECRET }, {
      now: at,
      fetchLoans: async (_key, lender) =>
        lender === 'Denied'
          ? { lender, httpStatus: 401, contracts: null, error: 'FIO rejected the API key' }
          : { lender, httpStatus: 200, error: null, contracts: ids.map((id) => contract(id, id === 'AAAAAAA' ? 'BREACHED' : 'PARTIALLY_FULFILLED')) },
      fetchCompany: async () => null,
    });

  const t1 = new Date(DURING.getTime() + 2 * 3_600_000);
  const t2 = new Date(DURING.getTime() + 3 * 3_600_000);
  await run(t1, ['AAAAAAA', 'NEWLOAN']);
  const before = await checked('NEWLOAN');
  const raw = await db.prepare("SELECT fetched_at FROM fio_raw WHERE contract_id = 'NEWLOAN'").first<{ fetched_at: string }>();
  assert.equal(before!.fio_seen, 1);
  assert.equal(before!.checked, t1.toISOString(), 'last checked is the lender check');

  // FIO stops returning NEWLOAN: it is marked as last seen at the previous check. AAAAAAA is untouched.
  const aBefore = await checked('AAAAAAA');
  await run(t2, ['AAAAAAA']);
  assert.deepEqual(await checked('NEWLOAN'), { fio_seen: 0, checked: t1.toISOString(), version: before!.version });
  const aAfter = await checked('AAAAAAA');
  assert.equal(aAfter!.checked, t2.toISOString());
  assert.equal(aAfter!.version, aBefore!.version, 'a loan FIO keeps returning is not rewritten');
  // Unchanged FIO data is not rewritten either.
  const rawAfter = await db.prepare("SELECT fetched_at FROM fio_raw WHERE contract_id = 'NEWLOAN'").first<{ fetched_at: string }>();
  assert.equal(rawAfter!.fetched_at, raw!.fetched_at);
});
