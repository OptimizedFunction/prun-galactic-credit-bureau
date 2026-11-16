// The sync job: fetch every FIO-tracked lender, decide (plan.ts), then write everything in one transaction.
//
// Safe to overlap with itself: loans are upserted by their unique contract ID and every status write is
// conditional on the status actually differing, so a second run finds nothing left to do.
import type { Currency, Status } from '../lib/normalize';
import { fetchCompanyByName, fetchLoanContracts, type FioCompany, type LoanFetchResult } from './fio';
import { extractLoan, planSync, type ExistingLoan, type FioLoan, type LenderLoans } from './plan';

export interface SyncSummary {
  runId: string;
  lenders: number;
  lendersFailed: number;
  inserted: number;
  statusChanges: number;
  verified: number;
}

export interface SyncDeps {
  fetchLoans?: (apiKey: string, lender: string) => Promise<LoanFetchResult>;
  fetchCompany?: (apiKey: string, companyName: string) => Promise<FioCompany | null>;
  now?: Date;
  graceDays?: number;
}

interface BorrowerRef {
  username: string;
  companyCode: string | null;
  corpCode: string | null;
  companyName: string;
  isNew: boolean;
}

export async function runSync(db: D1Database, apiKey: string, deps: SyncDeps = {}): Promise<SyncSummary> {
  const fetchLoans = deps.fetchLoans ?? fetchLoanContracts;
  const fetchCompany = deps.fetchCompany ?? fetchCompanyByName;
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const runId = `sync-${nowIso}`;

  const lenders = (await db.prepare("SELECT id, username FROM lenders WHERE tracking_mode = 'fio' ORDER BY username").all<{ id: number; username: string }>()).results;
  const lenderIds = new Map(lenders.map((l) => [l.username.toLowerCase(), l.id]));

  // Fetch every lender in parallel; one failing never blocks the others.
  const results = await Promise.all(lenders.map((l) => fetchLoans(apiKey, l.username)));

  const kept = new Map<string, FioLoan[]>();
  const fetched: LenderLoans[] = results.map((r) => {
    if (r.contracts === null) return { lender: r.lender, loans: null };
    const loans = r.contracts.map(extractLoan).filter((x): x is FioLoan => typeof x !== 'string');
    kept.set(r.lender.toLowerCase(), loans);
    return { lender: r.lender, loans };
  });

  const existing = (
    await db
      .prepare(
        `SELECT l.id, l.contract_id, le.username AS lender, l.status, l.auto_track, l.trust, l.principal_minor,
                l.currency, l.issued_on, l.duration_weeks
         FROM loans l JOIN lenders le ON le.id = l.lender_id WHERE l.contract_id IS NOT NULL`,
      )
      .all<{
        id: number;
        contract_id: string;
        lender: string;
        status: Status;
        auto_track: number;
        trust: ExistingLoan['trust'];
        principal_minor: number;
        currency: Currency | null;
        issued_on: string;
        duration_weeks: number | null;
      }>()
  ).results.map(
    (r): ExistingLoan => ({
      id: r.id,
      contractId: r.contract_id,
      lender: r.lender,
      status: r.status,
      autoTrack: r.auto_track === 1,
      trust: r.trust,
      principalMinor: r.principal_minor,
      currency: r.currency,
      issuedOn: r.issued_on,
      durationWeeks: r.duration_weeks,
    }),
  );

  const actions = planSync(existing, fetched, now, deps.graceDays);
  const inserts = actions.filter((a) => a.kind === 'insert');

  // Identify borrowers of new loans. Known company names come from the database; only unknown ones go to FIO.
  const borrowerByCompany = new Map<string, BorrowerRef>();
  if (inserts.length > 0) {
    const known = (await db.prepare('SELECT username, company_code, corp_code, company_name FROM borrowers').all<{ username: string; company_code: string | null; corp_code: string | null; company_name: string | null }>()).results;
    const knownByCompanyName = new Map(known.filter((b) => b.company_name).map((b) => [b.company_name!.toLowerCase(), b]));
    const knownUsernames = new Set(known.map((b) => b.username.toLowerCase()));

    const unknown = new Set<string>();
    for (const a of inserts) {
      const name = a.loan.partnerName;
      const hit = knownByCompanyName.get(name.toLowerCase());
      if (hit) {
        borrowerByCompany.set(name.toLowerCase(), { username: hit.username, companyCode: hit.company_code, corpCode: hit.corp_code, companyName: name, isNew: false });
      } else {
        unknown.add(name);
      }
    }
    const looked = await Promise.all([...unknown].map(async (name) => [name, await fetchCompany(apiKey, name)] as const));
    for (const [name, company] of looked) {
      // A failed lookup (liquidated company, FIO down) keeps the company name as the identity instead of losing the loan.
      const username = company?.username ?? name;
      borrowerByCompany.set(name.toLowerCase(), {
        username,
        companyCode: company?.companyCode ?? null,
        corpCode: company?.corpCode ?? null,
        companyName: name,
        isNew: !knownUsernames.has(username.toLowerCase()),
      });
    }
  }

  const statements: D1PreparedStatement[] = [];
  const rawUpsert = (loan: FioLoan, lenderId: number) =>
    db
      .prepare(
        `INSERT INTO fio_raw (contract_id, lender_id, fetched_at, payload) VALUES (?, ?, ?, ?)
         ON CONFLICT (contract_id, lender_id) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`,
      )
      .bind(loan.contractId, lenderId, nowIso, JSON.stringify(loan.raw));

  for (const a of actions) {
    if (a.kind === 'insert') {
      const lenderId = lenderIds.get(a.lender.toLowerCase())!;
      const b = borrowerByCompany.get(a.loan.partnerName.toLowerCase())!;
      const companyCode = b.companyCode ?? a.loan.partnerCompanyCode;
      statements.push(
        // New borrower, or an existing one whose identity gaps get filled. Existing values are never blanked.
        db
          .prepare(
            `INSERT INTO borrowers (username, company_code, corp_code, company_name, first_seen_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (username) DO UPDATE SET
               company_code = COALESCE(borrowers.company_code, excluded.company_code),
               corp_code = COALESCE(borrowers.corp_code, excluded.corp_code),
               company_name = COALESCE(borrowers.company_name, excluded.company_name)`,
          )
          .bind(b.username, companyCode, b.corpCode, b.companyName, nowIso),
        db
          .prepare(
            `INSERT INTO loans (contract_id, lender_id, borrower_id, borrower_company_code, borrower_corp_code,
               principal_minor, currency, issued_on, duration_weeks, status, trust, source, auto_track,
               last_synced_at, source_ref, created_at, updated_at)
             VALUES (?, ?, (SELECT id FROM borrowers WHERE username = ?), ?, ?, ?, ?, ?, ?, ?, 'fio_verified', 'fio', 1, ?, ?, ?, ?)
             ON CONFLICT (contract_id) DO NOTHING`,
          )
          .bind(a.loan.contractId, lenderId, b.username, companyCode, b.corpCode, a.loan.principalMinor, a.loan.currency, a.loan.issuedOn, a.loan.durationWeeks, a.status, nowIso, `fio:${a.loan.contractId}`, nowIso, nowIso),
        // First-seen history row, only if this run really created the loan.
        db
          .prepare(
            `INSERT INTO loan_status_history (loan_id, old_status, new_status, changed_at, source)
             SELECT id, NULL, status, ?, 'fio_sync' FROM loans WHERE contract_id = ? AND created_at = ?
               AND NOT EXISTS (SELECT 1 FROM loan_status_history h WHERE h.loan_id = loans.id)`,
          )
          .bind(nowIso, a.loan.contractId, nowIso),
        rawUpsert(a.loan, lenderId),
      );
    } else if (a.kind === 'status') {
      statements.push(
        // History first, reading the old status from the row itself, then the update. Both no-ops if already applied.
        db
          .prepare(
            `INSERT INTO loan_status_history (loan_id, old_status, new_status, changed_at, source)
             SELECT id, status, ?, ?, 'fio_sync' FROM loans WHERE id = ? AND status <> ?`,
          )
          .bind(a.to, nowIso, a.loanId, a.to),
        db.prepare('UPDATE loans SET status = ?, updated_at = ? WHERE id = ? AND status <> ?').bind(a.to, nowIso, a.loanId, a.to),
      );
      if (a.loan) {
        const owner = existing.find((l) => l.id === a.loanId)!;
        statements.push(rawUpsert(a.loan, lenderIds.get(owner.lender.toLowerCase())!));
      }
    } else {
      statements.push(
        db
          .prepare(
            `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, before_json, after_json, created_at)
             SELECT 'loan', id, 'update', 'system', 'fio-sync', json_object('trust', trust), json_object('trust', 'fio_verified'), ?
             FROM loans WHERE id = ? AND trust <> 'fio_verified'`,
          )
          .bind(nowIso, a.loanId),
        db.prepare("UPDATE loans SET trust = 'fio_verified', updated_at = ? WHERE id = ? AND trust <> 'fio_verified'").bind(nowIso, a.loanId),
      );
    }
  }

  // Per lender: mark returned loans as checked, and record the run.
  for (const r of results) {
    const lenderId = lenderIds.get(r.lender.toLowerCase())!;
    const loans = kept.get(r.lender.toLowerCase());
    if (loans && loans.length > 0) {
      statements.push(
        db
          .prepare('UPDATE loans SET last_synced_at = ? WHERE auto_track = 1 AND lender_id = ? AND contract_id IN (SELECT value FROM json_each(?))')
          .bind(nowIso, lenderId, JSON.stringify(loans.map((l) => l.contractId))),
      );
    }
    statements.push(
      db
        .prepare('INSERT INTO sync_runs (run_id, lender_id, checked_at, http_status, contracts_returned, loans_kept, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(runId, lenderId, nowIso, r.httpStatus, r.contracts?.length ?? null, loans?.length ?? null, r.error),
    );
  }

  if (statements.length > 0) await db.batch(statements);

  return {
    runId,
    lenders: lenders.length,
    lendersFailed: results.filter((r) => r.contracts === null).length,
    inserted: inserts.length,
    statusChanges: actions.filter((a) => a.kind === 'status').length,
    verified: actions.filter((a) => a.kind === 'verify').length,
  };
}
