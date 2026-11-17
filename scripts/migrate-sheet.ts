// Brings the database up to date with the downloaded bureau sheet (data/sheet/*.csv) without losing what
// has happened on the site since. Unlike sheet:import it never empties anything: it adds the loans the
// site does not have, takes the sheet's value where only the sheet changed, keeps the site's value where
// only the site changed, and reports the fields both changed. The rules are in scripts/lib/reconcile.ts.
//
//   npm run sheet:migrate                         look only: what would change in the local database
//   npm run sheet:migrate -- --apply              change the local database
//   npm run sheet:migrate -- --remote             look only: what would change in production
//   npm run sheet:migrate -- --remote --apply     change production
//   ... --prefer-sheet                            where both sides changed a field, take the sheet's value
//
// Safe to run again: a second run right after an applied one finds nothing left to do.
import fs from 'node:fs';
import path from 'node:path';
import { EditError, updateLoan, type Editor } from '../src/db/edits';
import { formatMinor, STATUS_LABELS, type Status } from '../src/lib/normalize';
import { parseCsv } from './lib/csv';
import { openLocalDb, openRemoteDb, runBatched } from './lib/db';
import { parseLedger, parseStatusHistory } from './lib/ledger';
import { planReconcile, type Field, type SiteHistory, type SiteLoan, type SiteRevision } from './lib/reconcile';
import { DATA_DIR, tabPath, type TabKey } from './lib/sheet-config';

const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (!['--apply', '--remote', '--prefer-sheet'].includes(flag)) throw new Error(`Unknown option ${flag}. Options: --apply, --remote, --prefer-sheet`);
}
const apply = flags.has('--apply');
const remote = flags.has('--remote');
const preferSheet = flags.has('--prefer-sheet');
const where = remote ? 'PRODUCTION' : 'local';

const SYSTEM: Editor = { id: 'sheet-migration', name: 'sheet-migration', kind: 'system' };

const readTab = (tab: TabKey): string[][] => {
  const file = tabPath(tab);
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Run "npm run sheet:fetch" first.`);
  return parseCsv(fs.readFileSync(file, 'utf8'));
};
const ledger = parseLedger(readTab('ledger'));
const history = parseStatusHistory(readTab('status-history'));

const json = (text: string | null): Record<string, unknown> | null => {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const startedAt = new Date().toISOString();
console.log(`Reconciling the sheet (${ledger.loans.length} loans) with the ${where} database${apply ? '' : ', looking only'}...`);
const { db, dispose } = remote ? await openRemoteDb() : await openLocalDb();

try {
  const [loanRows, revisionRows, historyRows] = await Promise.all([
    db
      .prepare(
        `SELECT l.id, le.username AS lender, b.username AS borrower, l.borrower_company_code AS companyCode, l.borrower_corp_code AS corpCode,
                l.principal_minor AS principalMinor, l.currency, l.issued_on AS issuedOn, l.duration_weeks AS durationWeeks, l.status,
                l.contract_id AS contractId, l.auto_track AS autoTrack, l.notes, l.deleted_at AS deletedAt, l.source, l.source_ref AS sourceRef
         FROM loans l JOIN lenders le ON le.id = l.lender_id JOIN borrowers b ON b.id = l.borrower_id ORDER BY l.id`,
      )
      .all<Omit<SiteLoan, 'autoTrack' | 'deleted'> & { autoTrack: number; deletedAt: string | null }>(),
    db
      .prepare("SELECT entity_id AS loanId, action, actor, before_json AS beforeJson, after_json AS afterJson FROM revisions WHERE entity_type = 'loan' AND action IN ('create', 'update') ORDER BY id")
      .all<{ loanId: number; action: string; actor: string; beforeJson: string | null; afterJson: string | null }>(),
    db.prepare('SELECT loan_id AS loanId, old_status AS oldStatus, new_status AS newStatus, changed_at AS changedAt FROM loan_status_history').all<SiteHistory>(),
  ]);
  const siteLoans: SiteLoan[] = loanRows.results.map(({ deletedAt, autoTrack, ...l }) => ({ ...l, autoTrack: autoTrack === 1, deleted: deletedAt !== null }));
  const revisions: SiteRevision[] = revisionRows.results.map((r) => ({ loanId: r.loanId, action: r.action, actor: r.actor, before: json(r.beforeJson), after: json(r.afterJson) }));

  const plan = planReconcile({ loans: ledger.loans, history: history.entries }, { loans: siteLoans, revisions, history: historyRows.results }, { preferSheet });

  // ---- Apply ----
  const failures: string[] = [];
  let inserted = 0;
  let updated = 0;
  let historyAdded = 0;
  if (apply) {
    // New loans, the way the first import wrote them. Each loan and what hangs off it share a batch.
    const runId = startedAt.replace(/\D/g, '').slice(0, 14);
    for (let i = 0; i < plan.inserts.length; i += 25) {
      const chunk = plan.inserts.slice(i, i + 25);
      const statements = chunk.flatMap(({ row, values: v, history: entries }) => {
        const ref = `sheet:Ledger!${row.row}#${runId}`;
        const loanId = '(SELECT id FROM loans WHERE source_ref = ?)';
        return [
          db.prepare('INSERT INTO lenders (username) VALUES (?) ON CONFLICT (username) DO NOTHING').bind(v.lender),
          db
            .prepare(
              `INSERT INTO borrowers (username, company_code, corp_code) VALUES (?, ?, ?)
               ON CONFLICT (username) DO UPDATE SET
                 company_code = COALESCE(borrowers.company_code, excluded.company_code),
                 corp_code = COALESCE(borrowers.corp_code, excluded.corp_code)`,
            )
            .bind(v.borrower, v.companyCode, v.corpCode),
          db
            .prepare(
              `INSERT INTO loans (contract_id, lender_id, borrower_id, borrower_company_code, borrower_corp_code,
                 principal_minor, currency, issued_on, duration_weeks, status, notes, trust, source, auto_track,
                 last_synced_at, source_ref, created_at, updated_at)
               VALUES (?, (SELECT id FROM lenders WHERE username = ?), (SELECT id FROM borrowers WHERE username = ?), ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, 'sheet_import', ?, ?, ?, ?, ?)`,
            )
            .bind(
              v.contractId, v.lender, v.borrower, v.companyCode, v.corpCode, v.principalMinor, v.currency, v.issuedOn, v.durationWeeks, v.status, v.notes,
              v.autoTrack ? 'fio_verified' : 'community_edited', v.autoTrack ? 1 : 0, row.lastSyncedAt, ref, startedAt, startedAt,
            ),
          db
            .prepare(
              `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, after_json, created_at)
               VALUES ('loan', ${loanId}, 'import', 'system', ?, ?, ?, ?)`,
            )
            .bind(ref, SYSTEM.name, SYSTEM.id, JSON.stringify(row.raw), startedAt),
          ...entries.map((h) =>
            db
              .prepare(`INSERT INTO loan_status_history (loan_id, old_status, new_status, changed_at, source) VALUES (${loanId}, ?, ?, ?, 'sheet_import')`)
              .bind(ref, h.oldStatus, h.newStatus, h.changedAt),
          ),
        ];
      });
      try {
        await db.batch(statements);
        inserted += chunk.length;
      } catch (err) {
        failures.push(`Sheet rows ${chunk[0]!.row} to ${chunk[chunk.length - 1]!.row} were not added: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Changed loans go through the same checked edit the site uses, so each lands in the loan's history and
    // is refused if someone changed the loan in the meantime.
    for (const u of plan.updates) {
      try {
        const changed = await updateLoan(db, u.loanId, u.set, SYSTEM, { expected: u.expected, reason: 'Changed in the Google Sheet' });
        if (changed.length > 0) updated++;
      } catch (err) {
        if (!(err instanceof EditError)) throw err;
        failures.push(`Loan #${u.loanId} (sheet row ${u.row}) was not updated: ${err.message}`);
      }
    }

    await runBatched(
      db,
      plan.history.map(({ loanId, entry }) =>
        db
          .prepare("INSERT INTO loan_status_history (loan_id, old_status, new_status, changed_at, source) VALUES (?, ?, ?, ?, 'sheet_import')")
          .bind(loanId, entry.oldStatus, entry.newStatus, entry.changedAt),
      ),
      50,
    );
    historyAdded = plan.history.length;
  }

  // ---- Report ----
  const show = (field: Field, value: unknown): string => {
    if (value === null || value === undefined || value === '') return 'blank';
    if (field === 'principalMinor') return formatMinor(value as number);
    if (field === 'status') return STATUS_LABELS[value as Status] ?? String(value);
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    return JSON.stringify(value);
  };
  const LABELS: Record<Field, string> = {
    lender: 'Lender', borrower: 'Borrower', companyCode: 'CO', corpCode: 'CORP', principalMinor: 'Amount', currency: 'Currency',
    issuedOn: 'Issued date', durationWeeks: 'Duration', status: 'Status', contractId: 'Contract ID', autoTrack: 'Auto track', notes: 'Notes',
  };
  const byId = new Map(siteLoans.map((l) => [l.id, l]));
  const section = (title: string, lines: string[]): string[] => (lines.length === 0 ? [] : [`## ${title} (${lines.length})`, '', ...lines, '']);
  const verb = apply ? '' : 'would be ';

  const lines = [
    '# Sheet migration report',
    '',
    `${apply ? 'Applied to' : 'Looked at'} the ${where} database, ${startedAt}.${preferSheet ? ' Conflicts were settled in the sheet\'s favour.' : ''}`,
    '',
    `- Sheet loans: ${ledger.loans.length}; site loans: ${siteLoans.length}`,
    `- Found in both: ${plan.matched}, of which identical: ${plan.unchanged}`,
    `- New loans ${verb}added: ${apply ? inserted : plan.inserts.length}`,
    `- Loans ${verb}updated from the sheet: ${apply ? updated : plan.updates.length}`,
    `- Status history entries ${verb}added: ${apply ? historyAdded : plan.history.length}`,
    `- Conflicts (changed on both sides): ${plan.conflicts.length}`,
    `- Site edits kept: ${plan.keptSiteEdits.length}`,
    `- Loans left to FIO: ${plan.leftToFio.length}`,
    `- Deleted on the site, left deleted: ${plan.deletedOnSite.length}`,
    `- Imported earlier but no longer in the sheet: ${plan.missingFromSheet.length}`,
    `- Loans that exist only on the site: ${plan.siteOnly}`,
    ...(failures.length > 0 ? [`- **Failed: ${failures.length}**`] : []),
    '',
    ...section('Failed', failures.map((f) => `- ${f}`)),
    ...section(
      `Conflicts, ${preferSheet ? 'sheet taken' : 'site kept'}`,
      plan.conflicts.map((c) => `- Loan #${c.loanId} (row ${c.row}) ${LABELS[c.field]}: site ${show(c.field, c.site)}, sheet ${show(c.field, c.sheet)}${c.sheetBefore === undefined ? '' : `, sheet had ${show(c.field, c.sheetBefore)}`}`),
    ),
    ...section(
      `New loans ${verb}added`,
      plan.inserts.map(({ row, values: v }) => `- Row ${row.row}: ${v.lender} to ${v.borrower}, ${formatMinor(v.principalMinor)} ${v.currency ?? ''}, ${v.issuedOn}, ${STATUS_LABELS[v.status]}${v.contractId ? `, ${v.contractId}` : ''}`),
    ),
    ...section(
      `Loans ${verb}updated from the sheet`,
      plan.updates.map((u) => `- Loan #${u.loanId} (row ${u.row}): ${(Object.keys(u.set) as Field[]).map((f) => `${LABELS[f]} ${show(f, u.expected[f])} -> ${show(f, u.set[f])}`).join('; ')}`),
    ),
    ...section('Site edits kept', plan.keptSiteEdits.map((c) => `- Loan #${c.loanId} (row ${c.row}) ${LABELS[c.field]}: site ${show(c.field, c.site)}, sheet still ${show(c.field, c.sheet)}`)),
    ...section(
      'Left to FIO (the site keeps these loans up to date from the game)',
      plan.leftToFio.map((l) => {
        const loan = byId.get(l.loanId)!;
        return `- Loan #${l.loanId} (row ${l.row}, ${loan.contractId ?? 'no contract'}): differs in ${l.fields.map((f) => LABELS[f]).join(', ')}`;
      }),
    ),
    ...section('Deleted on the site, left deleted', plan.deletedOnSite.map((d) => `- Loan #${d.loanId} (row ${d.row})`)),
    ...section(
      'Imported earlier but no longer in the sheet (left as they are)',
      plan.missingFromSheet.map((l) => `- Loan #${l.id}: ${l.lender} to ${l.borrower}, ${formatMinor(l.principalMinor)} ${l.currency ?? ''}, ${l.issuedOn}${l.contractId ? `, ${l.contractId}` : ''}`),
    ),
    ...section('Status history entries', plan.history.map(({ loanId, entry }) => `- Loan #${loanId}: ${entry.oldStatus ? STATUS_LABELS[entry.oldStatus] : 'new'} -> ${STATUS_LABELS[entry.newStatus]} at ${entry.changedAt}`)),
  ];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const reportPath = path.join(DATA_DIR, `migration-report-${remote ? 'production' : 'local'}.md`);
  fs.writeFileSync(reportPath, lines.join('\n'));

  console.log(lines.slice(4, lines.indexOf('', 4)).join('\n'));
  console.log(`\nFull list: ${reportPath}`);
  if (!apply) console.log(`Nothing was changed. Add --apply to make these changes${remote ? ' in production' : ''}.`);
  else if (remote) console.log(`To undo everything this run did: npx wrangler d1 time-travel restore bureau --timestamp=${startedAt}`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await dispose().catch(() => {});
}
