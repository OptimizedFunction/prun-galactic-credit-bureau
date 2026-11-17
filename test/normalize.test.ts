import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatMinor,
  maturityDate,
  minorToDecimal,
  normalizeContractId,
  parseAmountToMinor,
  statusFromFio,
  statusFromLabel,
} from '../src/lib/normalize';
import { parseCsv } from '../scripts/lib/csv';
import { collectParties, parseLedger, parseSheetTimestamp, parseStatusHistory } from '../scripts/lib/ledger';

test('contract IDs are trimmed and upper-cased', () => {
  assert.equal(normalizeContractId(' F3Z1FBH'), 'F3Z1FBH');
  assert.equal(normalizeContractId('abc1234\r'), 'ABC1234');
  assert.equal(normalizeContractId('   '), null);
  assert.equal(normalizeContractId(undefined), null);
});

test('amounts parse to hundredths without floats', () => {
  assert.equal(parseAmountToMinor('$25,000,000'), 2_500_000_000);
  assert.equal(parseAmountToMinor('1,234.5'), 123_450);
  assert.equal(parseAmountToMinor('$100'), 10_000);
  assert.equal(parseAmountToMinor('0.07'), 7);
  assert.equal(parseAmountToMinor('abc'), null);
  assert.equal(parseAmountToMinor(''), null);
  assert.equal(parseAmountToMinor('-5'), null);
});

test('amounts format for the API and for pages', () => {
  assert.equal(minorToDecimal(2_500_000_050), '25000000.50');
  assert.equal(minorToDecimal(7), '0.07');
  assert.equal(formatMinor(2_500_000_000), '25,000,000');
  assert.equal(formatMinor(123_450), '1,234.50');
  assert.equal(formatMinor(0), '0');
});

test('statuses map from sheet labels and from FIO', () => {
  assert.equal(statusFromLabel('In Progress'), 'in_progress');
  assert.equal(statusFromLabel(' complete '), 'complete');
  assert.equal(statusFromLabel('Written-Off'), null);
  assert.equal(statusFromFio('PARTIALLY_FULFILLED'), 'in_progress');
  assert.equal(statusFromFio('DEADLINE_EXCEEDED'), 'overdue');
  assert.equal(statusFromFio('FULFILLED'), 'complete');
  for (const ignored of ['OPEN', 'CLOSED', 'REJECTED', 'CANCELLED']) assert.equal(statusFromFio(ignored), null);
});

test('maturity handles fractional weeks', () => {
  assert.equal(maturityDate('2025-03-12', 12.85714286), '2025-06-10'); // 90 days
  assert.equal(maturityDate('2024-05-01', 18), '2024-09-04');
  assert.equal(maturityDate('2024-05-01', null), null);
});

test('CSV parser handles quotes, commas and newlines in cells', () => {
  assert.deepEqual(parseCsv('a,"b,1","c ""q""\nline"\r\nd,,\n'), [
    ['a', 'b,1', 'c "q"\nline'],
    ['d', '', ''],
  ]);
});

test('sheet timestamps parse as UTC', () => {
  assert.equal(parseSheetTimestamp('November 13, 2026 01:17:01 +0000'), '2026-11-13T01:17:01.000Z');
  assert.equal(parseSheetTimestamp(''), null);
});

const HEADER = ['', 'Lender', 'Name', 'CO', 'CORP', 'Amount', 'Currency', 'Issued Date', 'Duration (weeks)', 'Status', 'ContractId', 'Auto track?', 'Last Auto Updated', 'Notes'];
const row = (...cells: string[]) => ['', ...cells];

test('ledger parsing cleans dirty rows and reports them', () => {
  const { loans, issues } = parseLedger([
    ['', 'Title'],
    HEADER,
    row('Alice', 'Bob', 'BOB', 'CORP', '$1,000,000', 'AIC', '2025-01-01', '8', 'Complete', ' abc1234', 'TRUE', 'November 13, 2026 01:17:01 +0000', 'note'),
    row('Alice', 'bob', 'BOB', '---', '$2,000,000', 'N/A', '2025-02-01', 'Credit', 'In Progress', 'ABC1234', '', '', ''),
    row('Alice', 'Carol', '', '', 'lots', 'AIC', '2025-02-01', '4', 'Complete', '', '', '', ''),
    row('', '', '', '', '', '', '', '', '', '', '', '', ''),
  ]);

  assert.equal(loans.length, 2);
  assert.deepEqual(
    { id: loans[0]!.contractId, auto: loans[0]!.autoTrack, minor: loans[0]!.principalMinor, row: loans[0]!.row },
    { id: 'ABC1234', auto: true, minor: 100_000_000, row: 3 },
  );
  // Duplicate ID is dropped from the second row; the odd duration and the ID are kept in the notes.
  assert.equal(loans[1]!.contractId, null);
  assert.equal(loans[1]!.currency, null);
  assert.equal(loans[1]!.durationWeeks, null);
  assert.equal(loans[1]!.corpCode, null);
  assert.match(loans[1]!.notes!, /Sheet duration: Credit/);
  assert.match(loans[1]!.notes!, /ABC1234/);

  const kinds = issues.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['bad_duration', 'contract_id_normalised', 'duplicate_contract_id', 'non_cash_currency', 'skipped']);

  const parties = collectParties(loans);
  assert.equal(parties.borrowers.length, 1, 'Bob and bob are one borrower');
  assert.equal(parties.borrowers[0]!.username, 'Bob');
  assert.equal(parties.borrowers[0]!.corpCode, 'CORP', 'first-seen corp is kept');
  assert.equal(parties.issues.filter((i) => i.kind === 'name_case_variant').length, 1);
});

test('status history rows parse, blank old status means first seen', () => {
  const { entries, issues } = parseStatusHistory([
    ['Time (UTC)', 'ContractId', 'Lender', 'Borrower', 'Old Status', 'New Status'],
    ['November 13, 2026 01:17:01 +0000', '06k8593', 'L', 'B', '', 'Complete'],
    ['November 14, 2026 01:17:01 +0000', '06K8593', 'L', 'B', 'Complete', 'Stale'],
    ['garbage', '06K8593', 'L', 'B', 'Complete', 'Stale'],
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.contractId, '06K8593');
  assert.equal(entries[0]!.oldStatus, null);
  assert.equal(entries[1]!.newStatus, 'stale');
  assert.equal(issues.length, 1);
});

test('revisions are described in words', async () => {
  const { describeRevision, showValue } = await import('../src/lib/changeText');
  assert.equal(showValue('principal', '25000000.00'), '25,000,000');
  assert.equal(showValue('status', 'in_progress'), 'In Progress');
  assert.equal(showValue('trust', 'fio_verified'), 'FIO-verified');
  assert.equal(showValue('notes', null), 'blank');
  assert.equal(showValue('autoTrack', false), 'off');

  assert.deepEqual(describeRevision({ action: 'update', before: { status: 'stale' }, after: { status: 'complete', reason: 'assumed repaid' } }), {
    summary: 'Changed',
    lines: [{ label: 'Status', from: 'Stale', to: 'Complete' }],
    note: 'assumed repaid',
  });
  assert.deepEqual(describeRevision({ action: 'update', before: { durationWeeks: 0 }, after: { durationWeeks: 14 } }).lines, [{ label: 'Duration (weeks)', from: '0', to: '14' }]);
  assert.equal(describeRevision({ action: 'update', before: { deleted: true }, after: { deleted: false } }).summary, 'Restored');
  assert.equal(describeRevision({ action: 'delete', before: { lender: 'A' }, after: null }).summary, 'Deleted');
  assert.equal(describeRevision({ action: 'import', before: null, after: { Lender: 'A' } }).summary, 'Imported from the Google Sheet');
  const added = describeRevision({ action: 'create', before: null, after: { lender: 'A', borrower: 'B', principal: '1000.00', currency: null, status: 'complete' } });
  assert.deepEqual(added.lines.map((l) => `${l.label}=${l.to}`), ['Lender=A', 'Borrower=B', 'Amount=1,000', 'Status=Complete']);
});
