import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryEntry, LedgerLoan } from '../scripts/lib/ledger';
import { planReconcile, type SiteLoan, type SiteRevision } from '../scripts/lib/reconcile';

const row = (over: Partial<LedgerLoan> = {}): LedgerLoan => ({
  row: 10, lender: 'Lena', borrower: 'Bob', companyCode: 'BOB', corpCode: null, principalMinor: 100_000_00, currency: 'NCC', issuedOn: '2026-01-01',
  durationWeeks: 4, status: 'in_progress', contractId: 'ABC1234', autoTrack: false, lastSyncedAt: null, notes: null, raw: {}, ...over,
});
const loan = (over: Partial<SiteLoan> = {}): SiteLoan => ({
  id: 1, lender: 'Lena', borrower: 'Bob', companyCode: 'BOB', corpCode: null, principalMinor: 100_000_00, currency: 'NCC', issuedOn: '2026-01-01',
  durationWeeks: 4, status: 'in_progress', contractId: 'ABC1234', autoTrack: false, notes: null, deleted: false, source: 'sheet_import', sourceRef: 'sheet:Ledger!10', ...over,
});
const edit = (actor: string, before: Record<string, unknown>, after: Record<string, unknown>): SiteRevision => ({ loanId: 1, action: 'update', actor, before, after });
const plan = (rows: LedgerLoan[], loans: SiteLoan[], revisions: SiteRevision[] = [], history: HistoryEntry[] = [], preferSheet = false) =>
  planReconcile({ loans: rows, history }, { loans, revisions, history: [] }, { preferSheet });

test('identical loans need nothing', () => {
  const p = plan([row()], [loan({ lender: 'LENA' })]);
  assert.equal(p.unchanged, 1);
  assert.deepEqual([p.inserts.length, p.updates.length, p.conflicts.length], [0, 0, 0]);
});

test('a sheet row the site lacks is added', () => {
  const p = plan([row(), row({ row: 11, contractId: 'NEW0001', borrower: 'Cara' })], [loan()]);
  assert.equal(p.inserts.length, 1);
  assert.equal(p.inserts[0]!.values.borrower, 'Cara');
});

test('a field only the sheet changed is taken from the sheet', () => {
  const p = plan([row({ status: 'complete', notes: 'Repaid early' })], [loan()]);
  assert.deepEqual(p.updates, [{ loanId: 1, row: 10, set: { status: 'complete', notes: 'Repaid early' }, expected: { status: 'in_progress', notes: null } }]);
});

test('a field only the site changed is kept', () => {
  const p = plan([row()], [loan({ status: 'breached' })], [edit('someone', { status: 'in_progress' }, { status: 'breached' })]);
  assert.equal(p.updates.length, 0);
  assert.equal(p.keptSiteEdits.length, 1);
  assert.equal(p.conflicts.length, 0);
});

test('a field both changed is a conflict: site kept, or sheet taken when asked', () => {
  const revisions = [edit('someone', { principal: '100000.00' }, { principal: '120000.00' })];
  const site = [loan({ principalMinor: 120_000_00 })];
  const sheet = [row({ principalMinor: 150_000_00 })];
  const kept = plan(sheet, site, revisions);
  assert.equal(kept.conflicts.length, 1);
  assert.equal(kept.conflicts[0]!.sheetBefore, 100_000_00);
  assert.equal(kept.updates.length, 0);
  const taken = plan(sheet, site, revisions, [], true);
  assert.deepEqual(taken.updates[0]!.set, { principalMinor: 150_000_00 });
});

test('after the sheet wins a field, a later sheet change is taken again', () => {
  const revisions = [edit('someone', { status: 'in_progress' }, { status: 'overdue' }), edit('sheet-migration', { status: 'overdue' }, { status: 'breached' })];
  const p = plan([row({ status: 'complete' })], [loan({ status: 'breached' })], revisions);
  assert.deepEqual(p.updates[0]!.set, { status: 'complete' });
});

test('a loan the site tracks through FIO only takes notes', () => {
  const p = plan([row({ status: 'overdue', notes: 'Asked for more time' })], [loan({ autoTrack: true, status: 'in_progress' })]);
  assert.deepEqual(p.updates[0]!.set, { notes: 'Asked for more time' });
  assert.deepEqual(p.leftToFio[0]!.fields, ['status', 'autoTrack']);
});

test('a stale sheet loan counts as complete unless it was ever breached', () => {
  assert.equal(plan([row({ status: 'stale' })], [loan({ status: 'complete' })]).unchanged, 1);
  const breached: HistoryEntry[] = [{ row: 2, contractId: 'ABC1234', oldStatus: 'in_progress', newStatus: 'breached', changedAt: '2026-03-01T00:00:00.000Z' }];
  const p = plan([row({ status: 'stale' })], [loan({ status: 'complete' })], [], breached);
  assert.deepEqual(p.updates[0]!.set, { status: 'stale' });
  assert.equal(p.history.length, 1);
});

test('loans without a contract ID are matched by their details, then by sheet row', () => {
  const noId = { contractId: null };
  const exact = plan([row({ ...noId, row: 99 })], [loan(noId)]);
  assert.equal(exact.unchanged, 1);
  const corrected = plan([row({ ...noId, principalMinor: 90_000_00 })], [loan(noId)]);
  assert.deepEqual(corrected.updates[0]!.set, { principalMinor: 90_000_00 });
  assert.equal(corrected.inserts.length, 0);
});

test('deleted, missing and site-only loans are reported, never touched', () => {
  const p = plan(
    [row({ status: 'complete' })],
    [loan({ deleted: true }), loan({ id: 2, contractId: 'GONE001', borrower: 'Dan', sourceRef: 'sheet:Ledger!20' }), loan({ id: 3, contractId: 'SITE001', source: 'manual', sourceRef: 'manual:x' })],
  );
  assert.deepEqual(p.deletedOnSite, [{ loanId: 1, row: 10 }]);
  assert.deepEqual(p.missingFromSheet.map((l) => l.id), [2]);
  assert.equal(p.siteOnly, 1);
  assert.equal(p.updates.length + p.inserts.length, 0);
});
