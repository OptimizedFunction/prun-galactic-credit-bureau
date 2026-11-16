// All database reads for the API and the pages. Every money figure is grouped by currency.
import { maturityDate, minorToDecimal, type Currency, type Status } from '../lib/normalize';

export interface Loan {
  id: number;
  contractId: string | null;
  lender: string;
  borrower: { username: string; companyCode: string | null; corpCode: string | null };
  /** Decimal string, e.g. "25000000.00". */
  principal: string;
  principalMinor: number;
  /** null = not a cash loan in one of the four currencies. */
  currency: Currency | null;
  issuedOn: string;
  durationWeeks: number | null;
  maturesOn: string | null;
  loanType: string | null;
  status: Status;
  everBreached: boolean;
  outstanding: string | null;
  notes: string | null;
  trust: 'fio_verified' | 'lender_reported' | 'community_edited';
  source: 'fio' | 'api' | 'manual' | 'sheet_import';
  autoTrack: boolean;
  lastSyncedAt: string | null;
  updatedAt: string;
  /** Set when the loan has been deleted (hidden from lists and totals). */
  deletedAt: string | null;
}

interface LoanRow {
  id: number;
  contract_id: string | null;
  lender: string;
  borrower: string;
  borrower_company_code: string | null;
  borrower_corp_code: string | null;
  principal_minor: number;
  currency: Currency | null;
  issued_on: string;
  duration_weeks: number | null;
  loan_type: string | null;
  status: Status;
  ever_breached: number;
  outstanding_minor: number | null;
  notes: string | null;
  trust: Loan['trust'];
  source: Loan['source'];
  auto_track: number;
  last_synced_at: string | null;
  updated_at: string;
  deleted_at: string | null;
}

const LOAN_SELECT = `
  SELECT l.id, l.contract_id, le.username AS lender, b.username AS borrower,
         l.borrower_company_code, l.borrower_corp_code, l.principal_minor, l.currency, l.issued_on,
         l.duration_weeks, l.loan_type, l.status, l.outstanding_minor, l.notes, l.trust, l.source,
         l.auto_track, l.last_synced_at, l.updated_at, l.deleted_at,
         (l.status = 'breached' OR EXISTS (
            SELECT 1 FROM loan_status_history h WHERE h.loan_id = l.id AND h.new_status = 'breached'
         )) AS ever_breached
  FROM loans l
  JOIN lenders le ON le.id = l.lender_id
  JOIN borrowers b ON b.id = l.borrower_id`;

function toLoan(r: LoanRow): Loan {
  return {
    id: r.id,
    contractId: r.contract_id,
    lender: r.lender,
    borrower: { username: r.borrower, companyCode: r.borrower_company_code, corpCode: r.borrower_corp_code },
    principal: minorToDecimal(r.principal_minor),
    principalMinor: r.principal_minor,
    currency: r.currency,
    issuedOn: r.issued_on,
    durationWeeks: r.duration_weeks,
    maturesOn: maturityDate(r.issued_on, r.duration_weeks),
    loanType: r.loan_type,
    status: r.status,
    everBreached: r.ever_breached === 1,
    outstanding: r.outstanding_minor === null ? null : minorToDecimal(r.outstanding_minor),
    notes: r.notes,
    trust: r.trust,
    source: r.source,
    autoTrack: r.auto_track === 1,
    lastSyncedAt: r.last_synced_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

export interface LoanFilter {
  lender?: string;
  borrower?: string;
  contractId?: string;
  status?: Status;
  currency?: Currency;
  limit: number;
  offset: number;
}

export async function listLoans(db: D1Database, f: LoanFilter): Promise<{ loans: Loan[]; total: number }> {
  const where: string[] = ['l.deleted_at IS NULL'];
  const args: (string | number)[] = [];
  if (f.lender) (where.push('le.username = ?'), args.push(f.lender));
  if (f.borrower) (where.push('b.username = ?'), args.push(f.borrower));
  if (f.contractId) (where.push('l.contract_id = ?'), args.push(f.contractId));
  if (f.status) (where.push('l.status = ?'), args.push(f.status));
  if (f.currency) (where.push('l.currency = ?'), args.push(f.currency));
  const clause = `WHERE ${where.join(' AND ')}`;

  const [rows, count] = await db.batch<LoanRow | { n: number }>([
    db.prepare(`${LOAN_SELECT} ${clause} ORDER BY l.issued_on DESC, l.id DESC LIMIT ? OFFSET ?`).bind(...args, f.limit, f.offset),
    db
      .prepare(`SELECT COUNT(*) AS n FROM loans l JOIN lenders le ON le.id = l.lender_id JOIN borrowers b ON b.id = l.borrower_id ${clause}`)
      .bind(...args),
  ]);
  return {
    loans: (rows!.results as LoanRow[]).map(toLoan),
    total: (count!.results[0] as { n: number }).n,
  };
}

export async function getLoan(db: D1Database, id: number): Promise<Loan | null> {
  const row = await db.prepare(`${LOAN_SELECT} WHERE l.id = ?`).bind(id).first<LoanRow>();
  return row ? toLoan(row) : null;
}

export interface StatusChange {
  oldStatus: Status | null;
  newStatus: Status;
  changedAt: string;
  source: string;
}

export async function getLoanHistory(db: D1Database, loanId: number): Promise<StatusChange[]> {
  const { results } = await db
    .prepare('SELECT old_status, new_status, changed_at, source FROM loan_status_history WHERE loan_id = ? ORDER BY changed_at, id')
    .bind(loanId)
    .all<{ old_status: Status | null; new_status: Status; changed_at: string; source: string }>();
  return results.map((r) => ({ oldStatus: r.old_status, newStatus: r.new_status, changedAt: r.changed_at, source: r.source }));
}

export interface Revision {
  id: number;
  action: string;
  actorType: string;
  actor: string;
  actorId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export async function getRevisions(db: D1Database, entityType: 'loan' | 'lender' | 'borrower', entityId: number): Promise<Revision[]> {
  const { results } = await db
    .prepare(
      'SELECT id, action, actor_type, actor, actor_id, before_json, after_json, created_at FROM revisions WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC, id DESC',
    )
    .bind(entityType, entityId)
    .all<{ id: number; action: string; actor_type: string; actor: string; actor_id: string | null; before_json: string | null; after_json: string | null; created_at: string }>();
  return results.map((r) => ({
    id: r.id,
    action: r.action,
    actorType: r.actor_type,
    actor: r.actor,
    actorId: r.actor_id,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
    createdAt: r.created_at,
  }));
}

/** Per-currency figures. Terminated loans (cancelled offers, negotiated exits) are counted but not added to "total". */
export interface Exposure {
  currency: Currency | null;
  loans: number;
  /** Everything lent, excluding terminated loans. */
  total: string;
  totalMinor: number;
  /** In Progress + Overdue. */
  current: string;
  currentMinor: number;
  /** Outcome unknown. */
  stale: string;
  staleMinor: number;
  breachedLoans: number;
  everBreachedLoans: number;
  overdueLoans: number;
  terminatedLoans: number;
}

interface ExposureRow {
  currency: Currency | null;
  loans: number;
  total: number;
  current: number;
  stale: number;
  breached: number;
  ever_breached: number;
  overdue: number;
  terminated: number;
}

const EXPOSURE_COLUMNS = `
  l.currency,
  COUNT(*) AS loans,
  SUM(CASE WHEN l.status <> 'terminated' THEN l.principal_minor ELSE 0 END) AS total,
  SUM(CASE WHEN l.status IN ('in_progress', 'overdue') THEN l.principal_minor ELSE 0 END) AS current,
  SUM(CASE WHEN l.status = 'stale' THEN l.principal_minor ELSE 0 END) AS stale,
  SUM(l.status = 'breached') AS breached,
  SUM(l.status = 'breached' OR EXISTS (
    SELECT 1 FROM loan_status_history h WHERE h.loan_id = l.id AND h.new_status = 'breached'
  )) AS ever_breached,
  SUM(l.status = 'overdue') AS overdue,
  SUM(l.status = 'terminated') AS terminated`;

function toExposure(r: ExposureRow): Exposure {
  return {
    currency: r.currency,
    loans: r.loans,
    total: minorToDecimal(r.total),
    totalMinor: r.total,
    current: minorToDecimal(r.current),
    currentMinor: r.current,
    stale: minorToDecimal(r.stale),
    staleMinor: r.stale,
    breachedLoans: r.breached,
    everBreachedLoans: r.ever_breached,
    overdueLoans: r.overdue,
    terminatedLoans: r.terminated,
  };
}

export interface Borrower {
  id: number;
  username: string;
  companyCode: string | null;
  corpCode: string | null;
  aliases: string[];
}

/** Finds a borrower by current username or a former one. */
export async function getBorrower(db: D1Database, username: string): Promise<Borrower | null> {
  const row = await db
    .prepare(
      `SELECT id, username, company_code, corp_code FROM borrowers
       WHERE username = ?1 OR id = (SELECT borrower_id FROM borrower_aliases WHERE alias = ?1)`,
    )
    .bind(username)
    .first<{ id: number; username: string; company_code: string | null; corp_code: string | null }>();
  if (!row) return null;
  const aliases = await db.prepare('SELECT alias FROM borrower_aliases WHERE borrower_id = ? ORDER BY alias').bind(row.id).all<{ alias: string }>();
  return { id: row.id, username: row.username, companyCode: row.company_code, corpCode: row.corp_code, aliases: aliases.results.map((a) => a.alias) };
}

export async function getBorrowerExposure(db: D1Database, borrowerId: number): Promise<Exposure[]> {
  const { results } = await db
    .prepare(`SELECT ${EXPOSURE_COLUMNS} FROM loans l WHERE l.borrower_id = ? AND l.deleted_at IS NULL GROUP BY l.currency ORDER BY l.currency`)
    .bind(borrowerId)
    .all<ExposureRow>();
  return results.map(toExposure);
}

export interface Lender {
  id: number;
  username: string;
  companyCode: string | null;
  trackingMode: 'fio' | 'api' | 'manual';
}

export async function getLender(db: D1Database, username: string): Promise<Lender | null> {
  const row = await db
    .prepare('SELECT id, username, company_code, tracking_mode FROM lenders WHERE username = ?')
    .bind(username)
    .first<{ id: number; username: string; company_code: string | null; tracking_mode: Lender['trackingMode'] }>();
  return row ? { id: row.id, username: row.username, companyCode: row.company_code, trackingMode: row.tracking_mode } : null;
}

export async function getLenderExposure(db: D1Database, lenderId: number): Promise<Exposure[]> {
  const { results } = await db
    .prepare(`SELECT ${EXPOSURE_COLUMNS} FROM loans l WHERE l.lender_id = ? AND l.deleted_at IS NULL GROUP BY l.currency ORDER BY l.currency`)
    .bind(lenderId)
    .all<ExposureRow>();
  return results.map(toExposure);
}

export interface LenderSummary {
  username: string;
  trackingMode: Lender['trackingMode'];
  loans: number;
  /** Cash exposure per currency (non-cash loans are left out). */
  exposure: Exposure[];
}

/** Every lender with per-currency figures. */
export async function listLenders(db: D1Database): Promise<LenderSummary[]> {
  const [lenders, exposure] = await db.batch<{ id: number; username: string; tracking_mode: Lender['trackingMode'] } | (ExposureRow & { lender_id: number })>([
    db.prepare('SELECT id, username, tracking_mode FROM lenders ORDER BY username'),
    db.prepare(`SELECT l.lender_id, ${EXPOSURE_COLUMNS} FROM loans l WHERE l.currency IS NOT NULL AND l.deleted_at IS NULL GROUP BY l.lender_id, l.currency ORDER BY l.currency`),
  ]);
  const byLender = new Map<number, Exposure[]>();
  for (const row of exposure!.results as (ExposureRow & { lender_id: number })[]) {
    byLender.set(row.lender_id, [...(byLender.get(row.lender_id) ?? []), toExposure(row)]);
  }
  return (lenders!.results as { id: number; username: string; tracking_mode: Lender['trackingMode'] }[]).map((l) => {
    const exp = byLender.get(l.id) ?? [];
    return { username: l.username, trackingMode: l.tracking_mode, loans: exp.reduce((n, e) => n + e.loans, 0), exposure: exp };
  });
}

export interface LeaderboardEntry {
  rank: number;
  lender: string;
  amount: string;
  amountMinor: number;
}

export interface Leaderboard {
  currency: Currency;
  byTotal: LeaderboardEntry[];
  byCurrent: LeaderboardEntry[];
}

export interface Leaderboards {
  leaderboards: Leaderboard[];
  /**
   * All four currencies added together at face value, with no exchange rate applied. A rough measure of
   * scale only: the currencies are not worth the same.
   */
  combined: { byTotal: LeaderboardEntry[]; byCurrent: LeaderboardEntry[] };
}

/** Top lenders per currency, by everything lent and by what is out now. */
export async function getLeaderboards(db: D1Database, size = 20): Promise<Leaderboards> {
  const lenders = await listLenders(db);
  const currencies: Currency[] = ['AIC', 'CIS', 'ICA', 'NCC'];
  type Row = { lender: string; total: number; current: number };
  const board = (rows: Row[]) => {
    const top = (key: 'total' | 'current'): LeaderboardEntry[] =>
      rows
        .filter((r) => r[key] > 0)
        .sort((a, b) => b[key] - a[key] || a.lender.localeCompare(b.lender))
        .slice(0, size)
        .map((r, i) => ({ rank: i + 1, lender: r.lender, amount: minorToDecimal(r[key]), amountMinor: r[key] }));
    return { byTotal: top('total'), byCurrent: top('current') };
  };
  return {
    leaderboards: currencies.map((currency) => ({
      currency,
      ...board(
        lenders.flatMap((l) => {
          const e = l.exposure.find((x) => x.currency === currency);
          return e ? [{ lender: l.username, total: e.totalMinor, current: e.currentMinor }] : [];
        }),
      ),
    })),
    combined: board(
      lenders.map((l) => ({
        lender: l.username,
        total: l.exposure.reduce((sum, e) => sum + e.totalMinor, 0),
        current: l.exposure.reduce((sum, e) => sum + e.currentMinor, 0),
      })),
    ),
  };
}

export interface SearchResult {
  borrowers: { username: string; companyCode: string | null; corpCode: string | null; loans: number }[];
  lenders: { username: string; loans: number }[];
}

/** Username substring, or exact company code (current or as recorded on any loan). */
export async function search(db: D1Database, q: string, limit = 25): Promise<SearchResult> {
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const [borrowers, lenders] = await db.batch<{ username: string; company_code?: string | null; corp_code?: string | null; loans: number }>([
    db
      .prepare(
        `SELECT b.username, b.company_code, b.corp_code, (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = b.id AND l.deleted_at IS NULL) AS loans
         FROM borrowers b
         WHERE b.username LIKE ?1 ESCAPE '\\'
            OR b.company_code = ?2
            OR b.id IN (SELECT borrower_id FROM loans WHERE borrower_company_code = ?2)
            OR b.id IN (SELECT borrower_id FROM borrower_aliases WHERE alias LIKE ?1 ESCAPE '\\')
         ORDER BY (b.username = ?2) DESC, (b.company_code = ?2) DESC, b.username
         LIMIT ?3`,
      )
      .bind(like, q, limit),
    db
      .prepare(
        `SELECT le.username, (SELECT COUNT(*) FROM loans l WHERE l.lender_id = le.id AND l.deleted_at IS NULL) AS loans
         FROM lenders le WHERE le.username LIKE ?1 ESCAPE '\\'
         ORDER BY (le.username = ?2) DESC, le.username LIMIT ?3`,
      )
      .bind(like, q, limit),
  ]);
  return {
    borrowers: borrowers!.results.map((b) => ({ username: b.username, companyCode: b.company_code ?? null, corpCode: b.corp_code ?? null, loans: b.loans })),
    lenders: lenders!.results.map((l) => ({ username: l.username, loans: l.loans })),
  };
}

export interface SyncHealth {
  lender: string;
  checkedAt: string;
  httpStatus: number | null;
  contractsReturned: number | null;
  loansKept: number | null;
  error: string | null;
  ok: boolean;
}

/** Latest sync result for each FIO-tracked lender. */
export async function getSyncHealth(db: D1Database): Promise<SyncHealth[]> {
  const { results } = await db
    .prepare(
      `SELECT le.username AS lender, s.checked_at, s.http_status, s.contracts_returned, s.loans_kept, s.error
       FROM sync_runs s JOIN lenders le ON le.id = s.lender_id
       WHERE s.id = (SELECT s2.id FROM sync_runs s2 WHERE s2.lender_id = s.lender_id ORDER BY s2.checked_at DESC, s2.id DESC LIMIT 1)
       ORDER BY le.username`,
    )
    .all<{ lender: string; checked_at: string; http_status: number | null; contracts_returned: number | null; loans_kept: number | null; error: string | null }>();
  return results.map((r) => ({
    lender: r.lender,
    checkedAt: r.checked_at,
    httpStatus: r.http_status,
    contractsReturned: r.contracts_returned,
    loansKept: r.loans_kept,
    error: r.error,
    ok: r.http_status === 200 && r.error === null,
  }));
}

export interface Totals {
  loans: number;
  lenders: number;
  borrowers: number;
  exposure: Exposure[];
}

export async function getTotals(db: D1Database): Promise<Totals> {
  const [counts, exposure] = await db.batch<{ loans: number; lenders: number; borrowers: number } | ExposureRow>([
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM loans WHERE deleted_at IS NULL) AS loans,
              (SELECT COUNT(DISTINCT lender_id) FROM loans WHERE deleted_at IS NULL) AS lenders,
              (SELECT COUNT(*) FROM borrowers) AS borrowers`,
    ),
    db.prepare(`SELECT ${EXPOSURE_COLUMNS} FROM loans l WHERE l.currency IS NOT NULL AND l.deleted_at IS NULL GROUP BY l.currency ORDER BY l.currency`),
  ]);
  const c = counts!.results[0] as { loans: number; lenders: number; borrowers: number };
  return { ...c, exposure: (exposure!.results as ExposureRow[]).map(toExposure) };
}

export interface Change extends Revision {
  loanId: number;
  contractId: string | null;
  lender: string;
  borrower: string;
  loanDeleted: boolean;
  loanTracked: boolean;
}

/** Recent changes to loans, newest first. Sheet-import rows are left out; system (sync) changes are optional. */
export async function listChanges(db: D1Database, opts: { includeSystem: boolean; limit: number; offset: number }): Promise<Change[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.entity_id, r.action, r.actor_type, r.actor, r.actor_id, r.before_json, r.after_json, r.created_at,
              l.contract_id, le.username AS lender, b.username AS borrower, l.deleted_at, l.auto_track
       FROM revisions r
       JOIN loans l ON l.id = r.entity_id
       JOIN lenders le ON le.id = l.lender_id
       JOIN borrowers b ON b.id = l.borrower_id
       WHERE r.entity_type = 'loan' AND r.action <> 'import' AND (?1 = 1 OR r.actor_type = 'user')
       ORDER BY r.id DESC LIMIT ?2 OFFSET ?3`,
    )
    .bind(opts.includeSystem ? 1 : 0, opts.limit, opts.offset)
    .all<{ id: number; entity_id: number; action: string; actor_type: string; actor: string; actor_id: string | null; before_json: string | null; after_json: string | null; created_at: string; contract_id: string | null; lender: string; borrower: string; deleted_at: string | null; auto_track: number }>();
  return results.map((r) => ({
    id: r.id,
    action: r.action,
    actorType: r.actor_type,
    actor: r.actor,
    actorId: r.actor_id,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
    createdAt: r.created_at,
    loanId: r.entity_id,
    contractId: r.contract_id,
    lender: r.lender,
    borrower: r.borrower,
    loanDeleted: r.deleted_at !== null,
    loanTracked: r.auto_track === 1,
  }));
}

/** Loans written at or after `since`, deleted ones included, oldest change first. For the ledger's background refresh. */
export async function listLoansUpdatedSince(db: D1Database, since: string, limit = 500): Promise<Loan[]> {
  const { results } = await db.prepare(`${LOAN_SELECT} WHERE l.updated_at >= ? ORDER BY l.updated_at, l.id LIMIT ?`).bind(since, limit).all<LoanRow>();
  return results.map(toLoan);
}
