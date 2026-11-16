// Community edits to loans. Every change runs in one transaction and writes a revision
// (who, before, after); status changes also go to the status history.
import {
  isCurrency,
  minorToDecimal,
  normalizeContractId,
  parseAmountToMinor,
  statusFromLabel,
  type Currency,
  type Status,
} from '../lib/normalize';

export interface Editor {
  /** Discord user ID. */
  id: string;
  /** Discord username. */
  name: string;
}

/** The editable fields, in the shape the API accepts them. */
export interface LoanFields {
  lender: string;
  borrower: string;
  companyCode: string | null;
  corpCode: string | null;
  principalMinor: number;
  currency: Currency | null;
  issuedOn: string;
  durationWeeks: number | null;
  status: Status;
  contractId: string | null;
  autoTrack: boolean;
  notes: string | null;
}

export class EditError extends Error {
  constructor(
    readonly kind: 'invalid' | 'conflict' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

const invalid = (message: string): never => {
  throw new EditError('invalid', message);
};

const FIELD_NAMES = ['lender', 'borrower', 'companyCode', 'corpCode', 'principal', 'currency', 'issuedOn', 'durationWeeks', 'status', 'contractId', 'autoTrack', 'notes'] as const;
type FieldName = (typeof FIELD_NAMES)[number];

/** Fields that stay editable on a loan the FIO sync manages. */
const TRACKED_EDITABLE: readonly FieldName[] = ['notes', 'autoTrack'];
/** Changing any other field means the row no longer matches what FIO verified. */
const NOT_FACTS: readonly FieldName[] = ['notes', 'autoTrack'];

const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function name(v: unknown, what: string): string {
  if (typeof v !== 'string') return invalid(`${what} must be text.`);
  const s = v.trim();
  if (s.length < 1 || s.length > 64 || /[\u0000-\u001f]/.test(s)) return invalid(`${what} must be 1 to 64 characters.`);
  return s;
}

function code(v: unknown, what: string): string | null {
  if (blank(v)) return null;
  if (typeof v !== 'string' || v.trim().length > 8 || !/^[A-Za-z0-9-]+$/.test(v.trim())) return invalid(`${what} must be up to 8 letters or digits.`);
  return v.trim().toUpperCase();
}

/** Validates the fields present in `raw`. Unknown fields are rejected. */
export function parseLoanFields(raw: Record<string, unknown>): Partial<LoanFields> {
  const out: Partial<LoanFields> = {};
  for (const key of Object.keys(raw)) {
    if (!(FIELD_NAMES as readonly string[]).includes(key)) invalid(`Unknown field "${key}".`);
  }
  if ('lender' in raw) out.lender = name(raw['lender'], 'Lender');
  if ('borrower' in raw) out.borrower = name(raw['borrower'], 'Borrower');
  if ('companyCode' in raw) out.companyCode = code(raw['companyCode'], 'Company code');
  if ('corpCode' in raw) out.corpCode = code(raw['corpCode'], 'Corp code');
  if ('principal' in raw) {
    const v = raw['principal'];
    const minor = typeof v === 'number' || typeof v === 'string' ? parseAmountToMinor(String(v)) : null;
    out.principalMinor = minor ?? invalid('Amount must be a number such as 25,000,000.');
  }
  if ('currency' in raw) {
    const v = raw['currency'];
    if (blank(v) || (typeof v === 'string' && v.trim().toUpperCase() === 'N/A')) out.currency = null;
    else if (typeof v === 'string' && isCurrency(v.trim().toUpperCase())) out.currency = v.trim().toUpperCase() as Currency;
    else invalid('Currency must be AIC, CIS, ICA, NCC or N/A.');
  }
  if ('issuedOn' in raw) {
    const v = raw['issuedOn'];
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) || Number.isNaN(Date.parse(`${v.trim()}T00:00:00Z`))) invalid('Issued date must look like 2026-01-31.');
    out.issuedOn = (v as string).trim();
  }
  if ('durationWeeks' in raw) {
    const v = raw['durationWeeks'];
    if (blank(v)) out.durationWeeks = null;
    else {
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 1000) invalid('Duration must be a number of weeks, or blank.');
      out.durationWeeks = n;
    }
  }
  if ('status' in raw) {
    const status = typeof raw['status'] === 'string' ? statusFromLabel(raw['status']) : null;
    out.status = status ?? invalid('Status must be In Progress, Complete, Overdue, Breached, Terminated or Stale.');
  }
  if ('contractId' in raw) {
    const v = raw['contractId'];
    if (blank(v)) out.contractId = null;
    else {
      const id = typeof v === 'string' ? normalizeContractId(v) : null;
      if (id === null || !/^[A-Z0-9]{1,16}$/.test(id)) invalid('Contract ID must be letters and digits only.');
      out.contractId = id;
    }
  }
  if ('autoTrack' in raw) {
    const v = raw['autoTrack'];
    if (typeof v !== 'boolean') invalid('Auto track must be true or false.');
    out.autoTrack = v as boolean;
  }
  if ('notes' in raw) {
    const v = raw['notes'];
    if (blank(v)) out.notes = null;
    else if (typeof v !== 'string' || v.length > 2000) invalid('Notes must be text of at most 2,000 characters.');
    else out.notes = v.trim();
  }
  return out;
}

interface CurrentRow {
  id: number;
  lender: string;
  borrower: string;
  borrower_company_code: string | null;
  borrower_corp_code: string | null;
  principal_minor: number;
  currency: Currency | null;
  issued_on: string;
  duration_weeks: number | null;
  status: Status;
  contract_id: string | null;
  auto_track: number;
  notes: string | null;
  deleted_at: string | null;
}

async function loadRow(db: D1Database, id: number): Promise<CurrentRow> {
  const row = await db
    .prepare(
      `SELECT l.id, le.username AS lender, b.username AS borrower, l.borrower_company_code, l.borrower_corp_code,
              l.principal_minor, l.currency, l.issued_on, l.duration_weeks, l.status, l.contract_id, l.auto_track,
              l.notes, l.deleted_at
       FROM loans l JOIN lenders le ON le.id = l.lender_id JOIN borrowers b ON b.id = l.borrower_id WHERE l.id = ?`,
    )
    .bind(id)
    .first<CurrentRow>();
  if (!row) throw new EditError('not_found', 'No such loan.');
  return row;
}

const fromRow = (r: CurrentRow): LoanFields => ({
  lender: r.lender,
  borrower: r.borrower,
  companyCode: r.borrower_company_code,
  corpCode: r.borrower_corp_code,
  principalMinor: r.principal_minor,
  currency: r.currency,
  issuedOn: r.issued_on,
  durationWeeks: r.duration_weeks,
  status: r.status,
  contractId: r.contract_id,
  autoTrack: r.auto_track === 1,
  notes: r.notes,
});

/** Values as they appear in revisions and the API (amount as a decimal string under "principal"). */
function publicValues(f: Partial<LoanFields>): Record<string, unknown> {
  const { principalMinor, ...rest } = f;
  return principalMinor === undefined ? rest : { ...rest, principal: minorToDecimal(principalMinor) };
}

const same = (a: unknown, b: unknown): boolean => a === b;

async function assertContractFree(db: D1Database, contractId: string | null, exceptId: number | null): Promise<void> {
  if (contractId === null) return;
  const clash = await db.prepare('SELECT id, deleted_at FROM loans WHERE contract_id = ? AND id IS NOT ?').bind(contractId, exceptId).first<{ id: number; deleted_at: string | null }>();
  if (clash) {
    throw new EditError('conflict', `Contract ${contractId} is already recorded as loan #${clash.id}${clash.deleted_at ? ' (deleted; restore it instead)' : ''}.`);
  }
}

const upsertLender = (db: D1Database, username: string) => db.prepare('INSERT INTO lenders (username) VALUES (?) ON CONFLICT (username) DO NOTHING').bind(username);

/** New borrowers take the codes typed on the loan; existing ones only have gaps filled, never overwritten. */
const upsertBorrower = (db: D1Database, username: string, companyCode: string | null, corpCode: string | null) =>
  db
    .prepare(
      `INSERT INTO borrowers (username, company_code, corp_code) VALUES (?, ?, ?)
       ON CONFLICT (username) DO UPDATE SET
         company_code = COALESCE(borrowers.company_code, excluded.company_code),
         corp_code = COALESCE(borrowers.corp_code, excluded.corp_code)`,
    )
    .bind(username, companyCode, corpCode);

/** Adds a manual loan. Returns its ID. */
export async function createLoan(db: D1Database, input: Partial<LoanFields>, editor: Editor, now = new Date()): Promise<number> {
  for (const required of ['lender', 'borrower', 'principalMinor', 'issuedOn', 'status'] as const) {
    if (input[required] === undefined) invalid(`${required === 'principalMinor' ? 'Amount' : required === 'issuedOn' ? 'Issued date' : required[0]!.toUpperCase() + required.slice(1)} is required.`);
  }
  const f: LoanFields = {
    lender: input.lender!,
    borrower: input.borrower!,
    companyCode: input.companyCode ?? null,
    corpCode: input.corpCode ?? null,
    principalMinor: input.principalMinor!,
    currency: input.currency ?? null,
    issuedOn: input.issuedOn!,
    durationWeeks: input.durationWeeks ?? null,
    status: input.status!,
    contractId: input.contractId ?? null,
    autoTrack: input.autoTrack ?? false,
    notes: input.notes ?? null,
  };
  if (f.autoTrack && f.contractId === null) invalid('Auto track needs a contract ID.');
  await assertContractFree(db, f.contractId, null);

  const nowIso = now.toISOString();
  const ref = `manual:${crypto.randomUUID()}`;
  const loanId = '(SELECT id FROM loans WHERE source_ref = ?)';
  await db.batch([
    upsertLender(db, f.lender),
    upsertBorrower(db, f.borrower, f.companyCode, f.corpCode),
    db
      .prepare(
        `INSERT INTO loans (contract_id, lender_id, borrower_id, borrower_company_code, borrower_corp_code, principal_minor,
           currency, issued_on, duration_weeks, status, notes, trust, source, auto_track, source_ref, created_at, updated_at)
         VALUES (?, (SELECT id FROM lenders WHERE username = ?), (SELECT id FROM borrowers WHERE username = ?), ?, ?, ?,
           ?, ?, ?, ?, ?, 'community_edited', 'manual', ?, ?, ?, ?)`,
      )
      .bind(f.contractId, f.lender, f.borrower, f.companyCode, f.corpCode, f.principalMinor, f.currency, f.issuedOn, f.durationWeeks, f.status, f.notes, f.autoTrack ? 1 : 0, ref, nowIso, nowIso),
    db
      .prepare(`INSERT INTO loan_status_history (loan_id, old_status, new_status, changed_at, source) VALUES (${loanId}, NULL, ?, ?, 'edit')`)
      .bind(ref, f.status, nowIso),
    db
      .prepare(
        `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, after_json, created_at)
         VALUES ('loan', ${loanId}, 'create', 'user', ?, ?, ?, ?)`,
      )
      .bind(ref, editor.name, editor.id, JSON.stringify(publicValues(f)), nowIso),
  ]);
  const row = await db.prepare('SELECT id FROM loans WHERE source_ref = ?').bind(ref).first<{ id: number }>();
  return row!.id;
}

/** Applies the given fields to a loan. Returns the names of the fields that actually changed. */
export async function updateLoan(db: D1Database, id: number, input: Partial<LoanFields>, editor: Editor, now = new Date()): Promise<string[]> {
  const row = await loadRow(db, id);
  if (row.deleted_at) throw new EditError('conflict', 'This loan is deleted. Restore it before editing.');
  const current = fromRow(row);

  const before: Partial<LoanFields> = {};
  const after: Partial<LoanFields> = {};
  for (const key of Object.keys(input) as (keyof LoanFields)[]) {
    if (input[key] !== undefined && !same(input[key], current[key])) {
      (before as Record<string, unknown>)[key] = current[key];
      (after as Record<string, unknown>)[key] = input[key];
    }
  }
  const changed = Object.keys(after) as (keyof LoanFields)[];
  if (changed.length === 0) return [];

  // A loan the sync manages only takes notes and the tracking switch, unless this same edit switches tracking off.
  const staysTracked = current.autoTrack && after.autoTrack !== false;
  const apiName = (k: keyof LoanFields): FieldName => (k === 'principalMinor' ? 'principal' : k);
  if (staysTracked && changed.some((k) => !TRACKED_EDITABLE.includes(apiName(k)))) {
    throw new EditError('conflict', 'This loan is kept up to date from FIO. Only Notes can be edited; untick Auto track to edit the rest.');
  }
  const next = { ...current, ...after };
  if (next.autoTrack && next.contractId === null) invalid('Auto track needs a contract ID.');
  if (after.contractId !== undefined) await assertContractFree(db, after.contractId, id);

  const nowIso = now.toISOString();
  const statements: D1PreparedStatement[] = [];
  if (after.lender !== undefined) statements.push(upsertLender(db, after.lender));
  if (after.borrower !== undefined) statements.push(upsertBorrower(db, after.borrower, next.companyCode, next.corpCode));
  if (after.status !== undefined) {
    statements.push(
      db.prepare("INSERT INTO loan_status_history (loan_id, old_status, new_status, changed_at, source) VALUES (?, ?, ?, ?, 'edit')").bind(id, current.status, after.status, nowIso),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, before_json, after_json, created_at)
         VALUES ('loan', ?, 'update', 'user', ?, ?, ?, ?, ?)`,
      )
      .bind(id, editor.name, editor.id, JSON.stringify(publicValues(before)), JSON.stringify(publicValues(after)), nowIso),
  );

  const sets: string[] = ['updated_at = ?'];
  const args: (string | number | null)[] = [nowIso];
  const set = (sql: string, value: string | number | null) => (sets.push(sql), args.push(value));
  if (after.lender !== undefined) set('lender_id = (SELECT id FROM lenders WHERE username = ?)', after.lender);
  if (after.borrower !== undefined) set('borrower_id = (SELECT id FROM borrowers WHERE username = ?)', after.borrower);
  if ('companyCode' in after) set('borrower_company_code = ?', after.companyCode ?? null);
  if ('corpCode' in after) set('borrower_corp_code = ?', after.corpCode ?? null);
  if (after.principalMinor !== undefined) set('principal_minor = ?', after.principalMinor);
  if ('currency' in after) set('currency = ?', after.currency ?? null);
  if (after.issuedOn !== undefined) set('issued_on = ?', after.issuedOn);
  if ('durationWeeks' in after) set('duration_weeks = ?', after.durationWeeks ?? null);
  if (after.status !== undefined) set('status = ?', after.status);
  if ('contractId' in after) set('contract_id = ?', after.contractId ?? null);
  if (after.autoTrack !== undefined) set('auto_track = ?', after.autoTrack ? 1 : 0);
  if ('notes' in after) set('notes = ?', after.notes ?? null);
  if (changed.some((k) => !NOT_FACTS.includes(apiName(k)))) sets.push("trust = 'community_edited'");
  statements.push(db.prepare(`UPDATE loans SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id));

  await db.batch(statements);
  return changed.map(apiName);
}

/** Hides a loan. Loans the sync manages cannot be deleted (it would only bring them back). */
export async function deleteLoan(db: D1Database, id: number, editor: Editor, now = new Date()): Promise<void> {
  const row = await loadRow(db, id);
  if (row.deleted_at) return;
  if (row.auto_track === 1) throw new EditError('conflict', 'This loan is kept up to date from FIO and cannot be deleted. Untick Auto track first.');
  const nowIso = now.toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, before_json, created_at)
         VALUES ('loan', ?, 'delete', 'user', ?, ?, ?, ?)`,
      )
      .bind(id, editor.name, editor.id, JSON.stringify(publicValues(fromRow(row))), nowIso),
    db.prepare('UPDATE loans SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(nowIso, nowIso, id),
  ]);
}

export async function restoreLoan(db: D1Database, id: number, editor: Editor, now = new Date()): Promise<void> {
  const row = await loadRow(db, id);
  if (!row.deleted_at) return;
  const nowIso = now.toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, before_json, after_json, created_at)
         VALUES ('loan', ?, 'update', 'user', ?, ?, '{"deleted":true}', '{"deleted":false}', ?)`,
      )
      .bind(id, editor.name, editor.id, nowIso),
    db.prepare('UPDATE loans SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(nowIso, id),
  ]);
}
