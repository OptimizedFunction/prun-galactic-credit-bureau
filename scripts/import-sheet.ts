// Loads the downloaded bureau sheet (data/sheet/*.csv) into the LOCAL D1 database.
//
// This is a reset-and-reload seed: it empties every bureau table first. It only ever talks to the
// local database (.wrangler/state), never to a deployed one.
//
//   npm run db:migrate && npm run sheet:fetch && npm run sheet:import
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from './lib/csv';
import { openLocalDb, runBatched } from './lib/db';
import {
  collectParties,
  parseLedger,
  parseLenderSync,
  parseStatusHistory,
  type Issue,
} from './lib/ledger';
import { DATA_DIR, tabPath, type TabKey } from './lib/sheet-config';
import { STATUS_LABELS } from '../src/lib/normalize';

const readTab = (tab: TabKey): string[][] => {
  const file = tabPath(tab);
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Run "npm run sheet:fetch" first.`);
  return parseCsv(fs.readFileSync(file, 'utf8'));
};

const ledger = parseLedger(readTab('ledger'));
const parties = collectParties(ledger.loans);
const history = parseStatusHistory(readTab('status-history'));
const lenderSync = parseLenderSync(readTab('lender-sync'));
const issues: Issue[] = [...ledger.issues, ...parties.issues, ...history.issues];

const importedAt = new Date().toISOString();
const { db, dispose } = await openLocalDb();

try {
  // Children before parents.
  await db.batch(
    ['fio_raw', 'sync_runs', 'revisions', 'loan_status_history', 'loans', 'borrower_aliases', 'borrowers', 'lenders'].map(
      (table) => db.prepare(`DELETE FROM ${table}`),
    ),
  );

  // Lenders: those on the Lender Sync tab are tracked through FIO, the rest are manual.
  const fioTracked = new Set(lenderSync.map((s) => s.lender.toLowerCase()));
  const lenderNames = new Map(parties.lenders.map((l) => [l.username.toLowerCase(), l.username]));
  for (const s of lenderSync) {
    if (!lenderNames.has(s.lender.toLowerCase())) lenderNames.set(s.lender.toLowerCase(), s.lender);
  }
  await runBatched(
    db,
    [...lenderNames.entries()].map(([key, username]) =>
      db
        .prepare('INSERT INTO lenders (username, tracking_mode, created_at) VALUES (?, ?, ?)')
        .bind(username, fioTracked.has(key) ? 'fio' : 'manual', importedAt),
    ),
  );

  await runBatched(
    db,
    parties.borrowers.map((b) =>
      db
        .prepare('INSERT INTO borrowers (username, company_code, corp_code, first_seen_at) VALUES (?, ?, ?, ?)')
        .bind(b.username, b.companyCode, b.corpCode, importedAt),
    ),
  );

  // Loans, in sheet order so loan IDs follow the ledger.
  await runBatched(
    db,
    ledger.loans.map((l) =>
      db
        .prepare(
          `INSERT INTO loans (contract_id, lender_id, borrower_id, borrower_company_code, borrower_corp_code,
             principal_minor, currency, issued_on, duration_weeks, status, notes, trust, source, auto_track,
             last_synced_at, source_ref, created_at, updated_at)
           VALUES (?, (SELECT id FROM lenders WHERE username = ?), (SELECT id FROM borrowers WHERE username = ?), ?, ?,
             ?, ?, ?, ?, ?, ?, ?, 'sheet_import', ?, ?, ?, ?, ?)`,
        )
        .bind(
          l.contractId,
          l.lender,
          l.borrower,
          l.companyCode,
          l.corpCode,
          l.principalMinor,
          l.currency,
          l.issuedOn,
          l.durationWeeks,
          l.status,
          l.notes,
          // Auto-tracked rows were checked against FIO by the sheet's script; the rest were typed in by anyone.
          l.autoTrack ? 'fio_verified' : 'community_edited',
          l.autoTrack ? 1 : 0,
          l.lastSyncedAt,
          `sheet:Ledger!${l.row}`,
          importedAt,
          importedAt,
        ),
    ),
  );

  // One revision per loan holding the untouched sheet row.
  await runBatched(
    db,
    ledger.loans.map((l) =>
      db
        .prepare(
          `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, after_json, created_at)
           VALUES ('loan', (SELECT id FROM loans WHERE source_ref = ?), 'import', 'system', 'sheet-import', ?, ?)`,
        )
        .bind(`sheet:Ledger!${l.row}`, JSON.stringify(l.raw), importedAt),
    ),
  );

  // Status history, matched to loans by contract ID.
  const knownIds = new Set(ledger.loans.map((l) => l.contractId).filter((id): id is string => id !== null));
  const matched = history.entries.filter((h) => {
    if (knownIds.has(h.contractId)) return true;
    issues.push({ tab: 'Status History', row: h.row, kind: 'history_unmatched', detail: `no ledger loan with contract ${h.contractId}` });
    return false;
  });
  await runBatched(
    db,
    matched.map((h) =>
      db
        .prepare(
          `INSERT INTO loan_status_history (loan_id, old_status, new_status, changed_at, source)
           VALUES ((SELECT id FROM loans WHERE contract_id = ?), ?, ?, ?, 'sheet_import')`,
        )
        .bind(h.contractId, h.oldStatus, h.newStatus, h.changedAt),
    ),
  );

  // The sheet's last sync, as one run.
  await runBatched(
    db,
    lenderSync.map((s) =>
      db
        .prepare(
          `INSERT INTO sync_runs (run_id, lender_id, checked_at, http_status, contracts_returned, loans_kept, error)
           VALUES ('sheet-import', (SELECT id FROM lenders WHERE username = ?), ?, ?, ?, ?, ?)`,
        )
        .bind(
          s.lender,
          s.checkedAt,
          s.httpStatus,
          s.contractsReturned,
          s.loansKept,
          s.httpStatus !== null && s.httpStatus !== 200 ? `HTTP ${s.httpStatus}` : null,
        ),
    ),
  );

  // Report.
  const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
  const counts = {
    lenders: await count('SELECT COUNT(*) AS n FROM lenders'),
    borrowers: await count('SELECT COUNT(*) AS n FROM borrowers'),
    loans: await count('SELECT COUNT(*) AS n FROM loans'),
    history: await count('SELECT COUNT(*) AS n FROM loan_status_history'),
    syncRuns: await count('SELECT COUNT(*) AS n FROM sync_runs'),
  };
  const byStatus = await db.prepare('SELECT status, COUNT(*) AS n FROM loans GROUP BY status ORDER BY n DESC').all<{ status: keyof typeof STATUS_LABELS; n: number }>();

  const byKind = new Map<string, Issue[]>();
  for (const i of issues) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i]);

  const lines = [
    '# Sheet import report',
    '',
    `Imported ${importedAt}.`,
    '',
    `- Ledger rows read: ${ledger.loans.length + ledger.issues.filter((i) => i.kind === 'skipped').length}`,
    `- Loans imported: ${counts.loans}`,
    `- Lenders: ${counts.lenders} (${fioTracked.size} tracked through FIO)`,
    `- Borrowers: ${counts.borrowers}`,
    `- Status history entries: ${counts.history} of ${history.entries.length}`,
    `- Lender sync results: ${counts.syncRuns}`,
    '',
    '## Loans by status',
    '',
    ...byStatus.results.map((r) => `- ${STATUS_LABELS[r.status]}: ${r.n}`),
    '',
    '## Data-quality issues',
    '',
    ...(issues.length === 0 ? ['None.'] : []),
    ...[...byKind.entries()].flatMap(([kind, list]) => [
      `### ${kind} (${list.length})`,
      '',
      ...list.map((i) => `- ${i.tab}${i.row > 0 ? ` row ${i.row}` : ''}: ${i.detail}`),
      '',
    ]),
  ];
  const reportPath = path.join(DATA_DIR, 'import-report.md');
  fs.writeFileSync(reportPath, lines.join('\n'));

  console.log(`Imported ${counts.loans} loans, ${counts.lenders} lenders, ${counts.borrowers} borrowers, ${counts.history} history entries.`);
  console.log(`Data-quality issues: ${issues.length} (${[...byKind.entries()].map(([k, l]) => `${k} ${l.length}`).join(', ')})`);
  console.log(`Report: ${reportPath}`);
  if (counts.loans !== ledger.loans.length) {
    throw new Error(`Expected ${ledger.loans.length} loans in the database, found ${counts.loans}`);
  }
} finally {
  await dispose();
}
