// Community edits to loans. Every change runs in one transaction and writes a revision
// (who, before, after); status changes also go to the status history.
import {
  formatMinor,
  isCurrency,
  minorToDecimal,
  normalizeContractId,
  parseAmountToMinor,
  statusFromLabel,
  STATUS_LABELS,
  type Currency,
  type Status,
} from '../lib/normalize';

export type Trust = 'fio_verified' | 'lender_reported' | 'community_edited';

/** Who is making a change. Every change is recorded under this identity. */
export interface Editor {
  /** A stable ID: the Discord user ID, "lender:<id>" for a lender's API key, or "system". */
  id: string;
  /** Shown in the history: the Discord username, the lender's username, or the job's name. */
  name: string;
  /** Defaults to a signed-in Discord user. */
  kind?: 'user' | 'lender' | 'system';
}

const actorType = (editor: Editor): 'user' | 'lender' | 'system' => editor.kind ?? 'user';
/** Status changes are logged by where they came from. */
const historySource = (editor: Editor): 'edit' | 'api' => (editor.kind === 'lender' ? 'api' : 'edit');
/** What a loan's facts are worth once this editor has set them. The system leaves the label alone. */
const trustAfter = (editor: Editor, current: Trust): Trust => (editor.kind === 'lender' ? 'lender_reported' : editor.kind === 'system' ? current : 'community_edited');

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

/** Longest notes a loan can carry. */
const NOTES_MAX = 2000;

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
    else if (typeof v !== 'string' || v.length > NOTES_MAX) invalid('Notes must be text of at most 2,000 characters.');
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
  version: number;
  trust: Trust;
}

async function loadRow(db: D1Database, id: number): Promise<CurrentRow> {
  const row = await db
    .prepare(
      `SELECT l.id, le.username AS lender, b.username AS borrower, l.borrower_company_code, l.borrower_corp_code,
              l.principal_minor, l.currency, l.issued_on, l.duration_weeks, l.status, l.contract_id, l.auto_track,
              l.notes, l.deleted_at, l.version, l.trust
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

/** Runs a write batch, turning a duplicate contract ID (two people adding the same one at once) into a clear refusal. */
async function runBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (err) {
    if (String(err instanceof Error ? err.message : err).includes('loans.contract_id')) {
      throw new EditError('conflict', 'That contract ID is already recorded on another loan.');
    }
    throw err;
  }
}

const FIELD_LABELS: Record<FieldName, string> = {
  lender: 'Lender',
  borrower: 'Borrower',
  companyCode: 'CO',
  corpCode: 'CORP',
  principal: 'Amount',
  currency: 'Currency',
  issuedOn: 'Issued date',
  durationWeeks: 'Duration',
  status: 'Status',
  contractId: 'Contract ID',
  autoTrack: 'Auto track',
  notes: 'Notes',
};

function describe(key: keyof LoanFields, value: unknown): string {
  if (value === null || value === undefined) return 'blank';
  if (key === 'principalMinor') return formatMinor(value as number);
  if (key === 'status') return STATUS_LABELS[value as Status];
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return `"${String(value)}"`;
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
  await runBatch(db, [
    upsertLender(db, f.lender),
    upsertBorrower(db, f.borrower, f.companyCode, f.corpCode),
    db
      .prepare(
        `INSERT INTO loans (contract_id, lender_id, borrower_id, borrower_company_code, borrower_corp_code, principal_minor,
           currency, issued_on, duration_weeks, status, notes, trust, source, auto_track, source_ref, created_at, updated_at)
         VALUES (?, (SELECT id FROM lenders WHERE username = ?), (SELECT id FROM borrowers WHERE username = ?), ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        f.contractId, f.lender, f.borrower, f.companyCode, f.corpCode, f.principalMinor, f.currency, f.issuedOn, f.durationWeeks, f.status, f.notes,
        trustAfter(editor, 'community_edited'), editor.kind === 'lender' ? 'api' : 'manual', f.autoTrack ? 1 : 0, ref, nowIso, nowIso,
      ),
    db
      .prepare(`INSERT INTO loan_status_history (loan_id, old_status, new_status, changed_at, source) VALUES (${loanId}, NULL, ?, ?, ?)`)
      .bind(ref, f.status, nowIso, historySource(editor)),
    db
      .prepare(
        `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, after_json, created_at)
         VALUES ('loan', ${loanId}, 'create', ?, ?, ?, ?, ?)`,
      )
      .bind(ref, actorType(editor), editor.name, editor.id, JSON.stringify(publicValues(f)), nowIso),
  ]);
  const row = await db.prepare('SELECT id FROM loans WHERE source_ref = ?').bind(ref).first<{ id: number }>();
  return row!.id;
}

export interface UpdateOptions {
  /**
   * The values the editor was looking at. If a field being changed no longer holds the value given here,
   * someone else got there first and the edit is refused instead of overwriting them.
   */
  expected?: Partial<LoanFields>;
  /** Set the trust label outright (used when rolling back, to put back what an edit replaced). */
  trust?: Trust;
  /** A reason, recorded with the change and shown in the loan's history. */
  reason?: string;
  now?: Date;
}

/** Applies the given fields to a loan. Returns the names of the fields that actually changed. */
export async function updateLoan(db: D1Database, id: number, input: Partial<LoanFields>, editor: Editor, options: UpdateOptions = {}): Promise<string[]> {
  // The write only lands if the loan is still at the version that was read. If another write slipped in
  // between, read again and re-check, so "before" values in the history are always the real ones.
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await tryUpdate(db, id, input, editor, options);
    if (result !== 'retry') return result;
  }
  throw new EditError('conflict', 'This loan is being changed by someone else right now. Try again.');
}

async function tryUpdate(db: D1Database, id: number, input: Partial<LoanFields>, editor: Editor, options: UpdateOptions): Promise<string[] | 'retry'> {
  const now = options.now ?? new Date();
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
  if (changed.length === 0 && (options.trust === undefined || options.trust === row.trust)) return [];

  const apiName = (k: keyof LoanFields): FieldName => (k === 'principalMinor' ? 'principal' : k);
  const expected = options.expected ?? {};
  for (const key of changed) {
    if (key in expected && !same(expected[key], current[key])) {
      const last = await db.prepare("SELECT actor FROM revisions WHERE entity_type = 'loan' AND entity_id = ? ORDER BY id DESC LIMIT 1").bind(id).first<{ actor: string }>();
      throw new EditError(
        'conflict',
        `${FIELD_LABELS[apiName(key)]} was changed to ${describe(key, current[key])}${last ? ` by ${last.actor}` : ''} while you were editing. Your change was not saved.`,
      );
    }
  }

  // A loan the sync manages only takes notes and the tracking switch, unless this same edit switches tracking off.
  // The system (a rollback) is putting things back, so it is not held to this.
  const staysTracked = current.autoTrack && after.autoTrack !== false;
  if (editor.kind !== 'system' && staysTracked && changed.some((k) => !TRACKED_EDITABLE.includes(apiName(k)))) {
    if (editor.kind === 'lender') throw new EditError('conflict', 'This loan is kept up to date from FIO, so reports for it are not applied.');
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
      db
        .prepare('INSERT INTO loan_status_history (loan_id, old_status, new_status, changed_at, source) SELECT id, ?, ?, ?, ? FROM loans WHERE id = ? AND version = ?')
        .bind(current.status, after.status, nowIso, historySource(editor), id, row.version),
    );
  }
  // Changing a loan's facts changes what its trust label can claim. The label change is recorded with the
  // edit, so a rollback can put the old label back.
  const factsChanged = changed.some((k) => !NOT_FACTS.includes(apiName(k)));
  const trust = options.trust ?? (factsChanged ? trustAfter(editor, row.trust) : row.trust);
  const beforeJson: Record<string, unknown> = publicValues(before);
  const afterJson: Record<string, unknown> = publicValues(after);
  if (trust !== row.trust) {
    beforeJson['trust'] = row.trust;
    afterJson['trust'] = trust;
  }
  if (options.reason) afterJson['reason'] = options.reason;
  statements.push(
    db
      .prepare(
        `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, before_json, after_json, created_at)
         SELECT 'loan', id, 'update', ?, ?, ?, ?, ?, ? FROM loans WHERE id = ? AND version = ?`,
      )
      .bind(actorType(editor), editor.name, editor.id, JSON.stringify(beforeJson), JSON.stringify(afterJson), nowIso, id, row.version),
  );

  const sets: string[] = ['version = version + 1', 'updated_at = ?'];
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
  if (trust !== row.trust) set('trust = ?', trust);
  statements.push(db.prepare(`UPDATE loans SET ${sets.join(', ')} WHERE id = ? AND version = ?`).bind(...args, id, row.version));

  const results = await runBatch(db, statements);
  if (results[results.length - 1]!.meta.changes === 0) return 'retry';
  return changed.map(apiName);
}

/** Hides a loan. Loans the sync manages cannot be deleted (it would only bring them back). */
export async function deleteLoan(db: D1Database, id: number, editor: Editor, now = new Date(), reason?: string): Promise<void> {
  const row = await loadRow(db, id);
  if (row.deleted_at) return;
  if (row.auto_track === 1 && editor.kind !== 'system') throw new EditError('conflict', 'This loan is kept up to date from FIO and cannot be deleted. Untick Auto track first.');
  const nowIso = now.toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, before_json, after_json, created_at)
         VALUES ('loan', ?, 'delete', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, actorType(editor), editor.name, editor.id, JSON.stringify(publicValues(fromRow(row))), reason ? JSON.stringify({ reason }) : null, nowIso),
    db.prepare('UPDATE loans SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?').bind(nowIso, nowIso, id),
  ]);
}

export async function restoreLoan(db: D1Database, id: number, editor: Editor, now = new Date(), reason?: string): Promise<void> {
  const row = await loadRow(db, id);
  if (!row.deleted_at) return;
  const nowIso = now.toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, before_json, after_json, created_at)
         VALUES ('loan', ?, 'update', ?, ?, ?, '{"deleted":true}', ?, ?)`,
      )
      .bind(id, actorType(editor), editor.name, editor.id, JSON.stringify(reason ? { deleted: false, reason } : { deleted: false }), nowIso),
    db.prepare('UPDATE loans SET deleted_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?').bind(nowIso, id),
  ]);
}

export interface ReportResult {
  loanId: number;
  created: boolean;
  /** Fields that changed (empty when the report matched what was already recorded). */
  changed: string[];
}

/**
 * Records a loan a lender reports through the API. Idempotent by contract ID: the first report creates
 * the loan, later ones update it, and an identical one changes nothing. A lender can only report loans
 * recorded under their own name, and never one the FIO sync manages.
 */
export async function reportLoan(db: D1Database, lender: { id: number; username: string }, rawContractId: string, input: Partial<LoanFields>): Promise<ReportResult> {
  // Normalised here as well as by callers, so "adv0001" and "ADV0001" can never become two loans.
  const contractId = normalizeContractId(rawContractId) ?? invalid('A contract ID is required.');
  const editor: Editor = { id: `lender:${lender.id}`, name: lender.username, kind: 'lender' };
  // The lender and contract come from the address, tracking from the bureau: none can be set in the body.
  const { lender: _lender, contractId: _contract, autoTrack: _track, ...fields } = input;

  const find = () =>
    db
      .prepare('SELECT l.id, le.username AS lender, l.deleted_at FROM loans l JOIN lenders le ON le.id = l.lender_id WHERE l.contract_id = ?')
      .bind(contractId)
      .first<{ id: number; lender: string; deleted_at: string | null }>();

  let existing = await find();
  if (!existing) {
    try {
      const loanId = await createLoan(db, { ...fields, lender: lender.username, contractId, autoTrack: false }, editor);
      return { loanId, created: true, changed: [] };
    } catch (err) {
      // The same report sent twice at once: the other one created it, so carry on as an update.
      existing = err instanceof EditError && err.kind === 'conflict' ? await find() : null;
      if (!existing) throw err;
    }
  }
  if (existing.lender.toLowerCase() !== lender.username.toLowerCase()) {
    throw new EditError('conflict', `Contract ${contractId} is already recorded under another lender (${existing.lender}).`);
  }
  if (existing.deleted_at) throw new EditError('conflict', `Contract ${contractId} was deleted from the bureau. Restore it on the site before reporting it again.`);
  const changed = await updateLoan(db, existing.id, fields, editor);
  return { loanId: existing.id, created: false, changed };
}

export type NotesChange =
  /** Replace the notes. With `expected`, only if they still read that (null = there were none). */
  | { notes: string | null; expected?: string | null }
  /** Add a line at the end, keeping whatever is there. */
  | { append: string };

/**
 * Sets the notes on one of a lender's own loans, through their API key. Unlike a report, this works on loans
 * kept up to date from FIO too: notes are the one thing the sync never touches. The loan must already exist.
 */
export async function setLoanNotes(db: D1Database, lender: { id: number; username: string }, rawContractId: string, change: NotesChange): Promise<{ loanId: number; changed: string[] }> {
  const contractId = normalizeContractId(rawContractId) ?? invalid('A contract ID is required.');
  const editor: Editor = { id: `lender:${lender.id}`, name: lender.username, kind: 'lender' };
  const existing = await db
    .prepare('SELECT l.id, le.username AS lender, l.deleted_at, l.notes FROM loans l JOIN lenders le ON le.id = l.lender_id WHERE l.contract_id = ?')
    .bind(contractId)
    .first<{ id: number; lender: string; deleted_at: string | null; notes: string | null }>();
  if (!existing) throw new EditError('not_found', `Contract ${contractId} is not in the bureau. Report it first, or wait for the FIO sync to bring it in.`);
  if (existing.lender.toLowerCase() !== lender.username.toLowerCase()) {
    throw new EditError('conflict', `Contract ${contractId} is recorded under another lender (${existing.lender}).`);
  }
  if (existing.deleted_at) throw new EditError('conflict', `Contract ${contractId} was deleted from the bureau.`);

  const clean = (text: string | null): string | null => {
    const t = (text ?? '').trim();
    if (t.length > NOTES_MAX) invalid('Notes must be text of at most 2,000 characters.');
    return t === '' ? null : t;
  };
  if ('append' in change) {
    const line = clean(change.append) ?? invalid('Say what to add ("append").');
    // Built on the notes as read, and refused if someone changed them in between, so nothing is lost.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = attempt === 0 ? existing.notes : (await db.prepare('SELECT notes FROM loans WHERE id = ?').bind(existing.id).first<{ notes: string | null }>())!.notes;
      try {
        const changed = await updateLoan(db, existing.id, { notes: clean(current ? `${current}\n${line}` : line) }, editor, { expected: { notes: current } });
        return { loanId: existing.id, changed };
      } catch (err) {
        if (!(err instanceof EditError && err.kind === 'conflict' && attempt < 2)) throw err;
      }
    }
  }
  const replace = change as { notes: string | null; expected?: string | null };
  const expected = 'expected' in replace ? { expected: { notes: clean(replace.expected ?? null) } } : {};
  const changed = await updateLoan(db, existing.id, { notes: clean(replace.notes) }, editor, expected);
  return { loanId: existing.id, changed };
}

/** A loan's current values in the form revisions store them, plus its trust label and whether it is deleted. */
export async function currentValues(db: D1Database, id: number): Promise<{ values: Record<string, unknown>; trust: Trust; deleted: boolean }> {
  const row = await loadRow(db, id);
  return { values: publicValues(fromRow(row)), trust: row.trust, deleted: row.deleted_at !== null };
}
