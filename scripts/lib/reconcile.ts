// Works out what a fresh copy of the sheet means for a database that has moved on since its last import:
// which loans are new, which fields the sheet changed, and where the sheet and the site disagree.
// Pure functions: no file or database access here.
//
// The rules, per field of a loan found in both places:
//   * The site still holds what the sheet last gave it  -> the sheet's new value is taken.
//   * The site changed it and the sheet did not          -> the site's value is kept.
//   * Both changed it, to different values               -> a conflict. The site is kept unless preferSheet is set.
//   * The loan is kept up to date from FIO on the site   -> only its notes are reconciled; FIO decides the rest.
// Nothing is ever deleted: loans missing from the sheet, or deleted on the site, are only reported.
import type { LoanFields } from '../../src/db/edits';
import { parseAmountToMinor, type Status } from '../../src/lib/normalize';
import type { HistoryEntry, LedgerLoan } from './ledger';

export type Field = keyof LoanFields;
export const FIELDS: readonly Field[] = ['lender', 'borrower', 'companyCode', 'corpCode', 'principalMinor', 'currency', 'issuedOn', 'durationWeeks', 'status', 'contractId', 'autoTrack', 'notes'];

/** Names the sheet import and this migration write their changes under. */
export const SHEET_ACTORS: readonly string[] = ['sheet-import', 'sheet-migration'];

export interface SiteLoan extends LoanFields {
  id: number;
  deleted: boolean;
  source: string;
  sourceRef: string | null;
}

export interface SiteRevision {
  loanId: number;
  action: string;
  actor: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface SiteHistory {
  loanId: number;
  oldStatus: string | null;
  newStatus: string;
  changedAt: string;
}

export interface FieldChange {
  loanId: number;
  row: number;
  field: Field;
  site: unknown;
  sheet: unknown;
}

export interface Plan {
  /** Sheet rows with no loan on the site. */
  inserts: { row: LedgerLoan; values: LoanFields; history: HistoryEntry[] }[];
  /** Loans where the sheet's value is taken, with the site values they replace. */
  updates: { loanId: number; row: number; set: Partial<LoanFields>; expected: Partial<LoanFields> }[];
  /** Status changes the sheet recorded that the site does not have. */
  history: { loanId: number; entry: HistoryEntry }[];
  /** Changed on both sides. Applied only when preferSheet is set (then they are in `updates` as well). */
  conflicts: (FieldChange & { sheetBefore: unknown })[];
  /** Changed on the site only, so left as they are. */
  keptSiteEdits: FieldChange[];
  /** Differences on loans the site keeps up to date from FIO. */
  leftToFio: { loanId: number; row: number; fields: Field[] }[];
  deletedOnSite: { loanId: number; row: number }[];
  /** Imported from the sheet earlier, but no longer found in it. */
  missingFromSheet: SiteLoan[];
  /** Loans that only ever existed on the site (added there, or found by the FIO sync). */
  siteOnly: number;
  matched: number;
  unchanged: number;
}

const NEVER = Symbol('never given by the sheet');
const CASELESS: readonly Field[] = ['lender', 'borrower', 'companyCode', 'corpCode'];
const lower = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : v);
const same = (field: Field, a: unknown, b: unknown): boolean => (CASELESS.includes(field) ? lower(a ?? null) === lower(b ?? null) : (a ?? null) === (b ?? null));

/** Revisions name the amount "principal" and hold it as a decimal string. */
function fieldsOf(json: Record<string, unknown> | null): Partial<Record<Field, unknown>> {
  const out: Partial<Record<Field, unknown>> = {};
  if (!json) return out;
  for (const [key, value] of Object.entries(json)) {
    if (key === 'principal') out.principalMinor = parseAmountToMinor(String(value));
    else if ((FIELDS as readonly string[]).includes(key)) out[key as Field] = value;
  }
  return out;
}

interface Ownership {
  siteChanged: boolean;
  /** What the sheet last gave for this field, once the site has changed it. */
  sheetGave: unknown;
}

/** For each field of a loan: has the site changed it since the sheet last set it, and from what? */
function ownership(loan: SiteLoan, revisions: SiteRevision[]): Map<Field, Ownership> {
  const fromSheet = loan.source === 'sheet_import';
  const state = new Map<Field, Ownership>(FIELDS.map((f) => [f, fromSheet ? { siteChanged: false, sheetGave: undefined } : { siteChanged: true, sheetGave: NEVER }]));
  for (const rev of revisions) {
    if (rev.action !== 'update' && rev.action !== 'create') continue;
    const before = fieldsOf(rev.before);
    for (const field of Object.keys(fieldsOf(rev.after)) as Field[]) {
      if (SHEET_ACTORS.includes(rev.actor)) state.set(field, { siteChanged: false, sheetGave: undefined });
      else if (!state.get(field)!.siteChanged) state.set(field, { siteChanged: true, sheetGave: rev.action === 'create' ? NEVER : before[field] });
    }
  }
  return state;
}

const fingerprint = (l: Pick<LoanFields, 'lender' | 'borrower' | 'principalMinor' | 'currency' | 'issuedOn'>): string =>
  [l.lender.toLowerCase(), l.borrower.toLowerCase(), l.principalMinor, l.currency ?? '', l.issuedOn].join('|');

const sheetRowOf = (loan: SiteLoan): number | null => {
  const m = /^sheet:Ledger!(\d+)/.exec(loan.sourceRef ?? '');
  return m ? Number(m[1]) : null;
};

/** Pairs each sheet row with the site loan it describes, if any. */
function match(sheet: LedgerLoan[], site: SiteLoan[]): Map<LedgerLoan, SiteLoan> {
  const pairs = new Map<LedgerLoan, SiteLoan>();
  const taken = new Set<number>();
  const pair = (row: LedgerLoan, loan: SiteLoan) => (pairs.set(row, loan), taken.add(loan.id));

  // 1. The in-game contract ID settles it.
  const byContract = new Map(site.filter((l) => l.contractId !== null).map((l) => [l.contractId!, l]));
  for (const row of sheet) {
    const loan = row.contractId === null ? undefined : byContract.get(row.contractId);
    if (loan && !taken.has(loan.id)) pair(row, loan);
  }

  // 2. Otherwise the same lender, borrower, amount, currency and date. Among several, prefer the loan that came
  //    from the same sheet row, then imported loans, and never one that carries a different contract ID.
  const byPrint = new Map<string, SiteLoan[]>();
  for (const loan of site) byPrint.set(fingerprint(loan), [...(byPrint.get(fingerprint(loan)) ?? []), loan]);
  for (const row of sheet) {
    if (pairs.has(row)) continue;
    const candidates = (byPrint.get(fingerprint(row)) ?? [])
      .filter((l) => !taken.has(l.id) && (row.contractId === null || l.contractId === null))
      .sort((a, b) => score(b, row) - score(a, row));
    if (candidates[0]) pair(row, candidates[0]);
  }

  // 3. Otherwise the loan imported from this very row, if it is still between the same two parties
  //    (the amount or date was corrected in the sheet or on the site).
  const byRow = new Map<number, SiteLoan>();
  for (const loan of site) {
    const n = sheetRowOf(loan);
    if (n !== null && loan.source === 'sheet_import') byRow.set(n, loan);
  }
  for (const row of sheet) {
    if (pairs.has(row)) continue;
    const loan = byRow.get(row.row);
    if (loan && !taken.has(loan.id) && same('lender', loan.lender, row.lender) && same('borrower', loan.borrower, row.borrower)) pair(row, loan);
  }
  return pairs;
}

const score = (loan: SiteLoan, row: LedgerLoan): number =>
  (sheetRowOf(loan) === row.row ? 4 : 0) + (loan.source === 'sheet_import' ? 2 : 0) + (loan.contractId === null ? 1 : 0);

const breachedIn = (entries: { oldStatus: string | null; newStatus: string }[]): boolean => entries.some((h) => h.oldStatus === 'breached' || h.newStatus === 'breached');

export function planReconcile(
  sheet: { loans: LedgerLoan[]; history: HistoryEntry[] },
  site: { loans: SiteLoan[]; revisions: SiteRevision[]; history: SiteHistory[] },
  options: { preferSheet?: boolean } = {},
): Plan {
  const plan: Plan = { inserts: [], updates: [], history: [], conflicts: [], keptSiteEdits: [], leftToFio: [], deletedOnSite: [], missingFromSheet: [], siteOnly: 0, matched: 0, unchanged: 0 };

  const group = <T, K>(items: T[], key: (item: T) => K): Map<K, T[]> => {
    const map = new Map<K, T[]>();
    for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
    return map;
  };
  const sheetHistory = group(sheet.history, (h) => h.contractId);
  const siteHistory = group(site.history, (h) => h.loanId);
  const siteRevisions = group(site.revisions, (r) => r.loanId);

  /** The sheet's fields for a row, as the site would hold them. */
  const valuesOf = (row: LedgerLoan, loan: SiteLoan | null): LoanFields => {
    const history = row.contractId === null ? [] : (sheetHistory.get(row.contractId) ?? []);
    const everBreached = row.status === 'breached' || breachedIn(history) || (loan !== null && (loan.status === 'breached' || breachedIn(siteHistory.get(loan.id) ?? [])));
    // Owner's decision (2026-11-17): a loan the sheet left Stale is treated as repaid unless it was ever breached.
    const status: Status = row.status === 'stale' && !everBreached ? 'complete' : row.status;
    return {
      lender: row.lender,
      borrower: row.borrower,
      companyCode: row.companyCode,
      corpCode: row.corpCode,
      principalMinor: row.principalMinor,
      currency: row.currency,
      issuedOn: row.issuedOn,
      durationWeeks: row.durationWeeks,
      status,
      contractId: row.contractId,
      autoTrack: row.autoTrack,
      notes: row.notes,
    };
  };

  const pairs = match(sheet.loans, site.loans);
  for (const row of sheet.loans) {
    const loan = pairs.get(row);
    const history = row.contractId === null ? [] : (sheetHistory.get(row.contractId) ?? []);
    if (!loan) {
      plan.inserts.push({ row, values: valuesOf(row, null), history });
      continue;
    }
    plan.matched++;
    if (loan.deleted) {
      plan.deletedOnSite.push({ loanId: loan.id, row: row.row });
      continue;
    }

    const values = valuesOf(row, loan);
    const differing = FIELDS.filter((f) => !same(f, values[f], loan[f]));
    const open = loan.autoTrack ? differing.filter((f) => f === 'notes') : differing;
    const fio = differing.filter((f) => !open.includes(f));
    if (fio.length > 0) plan.leftToFio.push({ loanId: loan.id, row: row.row, fields: fio });

    const owned = ownership(loan, siteRevisions.get(loan.id) ?? []);
    const set: Partial<Record<Field, unknown>> = {};
    const expected: Partial<Record<Field, unknown>> = {};
    for (const field of open) {
      const change: FieldChange = { loanId: loan.id, row: row.row, field, site: loan[field], sheet: values[field] };
      const { siteChanged, sheetGave } = owned.get(field)!;
      let take = !siteChanged || (sheetGave !== NEVER && same(field, sheetGave, loan[field]));
      if (!take) {
        if (sheetGave !== NEVER && same(field, sheetGave, values[field])) {
          plan.keptSiteEdits.push(change);
        } else {
          plan.conflicts.push({ ...change, sheetBefore: sheetGave === NEVER ? undefined : sheetGave });
          take = options.preferSheet === true;
        }
      }
      if (take) {
        set[field] = values[field];
        expected[field] = loan[field];
      }
    }
    if (Object.keys(set).length > 0) plan.updates.push({ loanId: loan.id, row: row.row, set: set as Partial<LoanFields>, expected: expected as Partial<LoanFields> });
    else if (differing.length === 0) plan.unchanged++;

    const known = new Set((siteHistory.get(loan.id) ?? []).map((h) => `${h.newStatus}|${Date.parse(h.changedAt)}`));
    for (const entry of history) {
      if (!known.has(`${entry.newStatus}|${Date.parse(entry.changedAt)}`)) plan.history.push({ loanId: loan.id, entry });
    }
  }

  const paired = new Set([...pairs.values()].map((l) => l.id));
  for (const loan of site.loans) {
    if (paired.has(loan.id)) continue;
    if (loan.source === 'sheet_import' && !loan.deleted) plan.missingFromSheet.push(loan);
    else plan.siteOnly++;
  }
  return plan;
}
