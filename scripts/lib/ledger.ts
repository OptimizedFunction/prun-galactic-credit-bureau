// Parsing of the bureau sheet's tabs into clean records plus a list of data-quality issues.
// Pure functions: no file or database access here.
import {
  isCurrency,
  normalizeContractId,
  parseAmountToMinor,
  statusFromLabel,
  type Currency,
  type Status,
} from '../../src/lib/normalize';

export interface Issue {
  tab: string;
  /** 1-based sheet row. */
  row: number;
  kind:
    | 'skipped'
    | 'duplicate_contract_id'
    | 'contract_id_normalised'
    | 'odd_contract_id'
    | 'bad_duration'
    | 'non_cash_currency'
    | 'name_has_spaces_or_tags'
    | 'name_case_variant'
    | 'identity_conflict'
    | 'history_unmatched'
    | 'unknown_lender';
  detail: string;
}

export interface LedgerLoan {
  row: number;
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
  lastSyncedAt: string | null;
  notes: string | null;
  /** The untouched sheet cells, kept in the import revision. */
  raw: Record<string, string>;
}

const LEDGER_COLUMNS = [
  'Lender',
  'Name',
  'CO',
  'CORP',
  'Amount',
  'Currency',
  'Issued Date',
  'Duration (weeks)',
  'Status',
  'ContractId',
  'Auto track?',
  'Last Auto Updated',
  'Notes',
] as const;

const blankToNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());

/** Sheet timestamps look like "November 13, 2026 01:17:01 +0000". */
export function parseSheetTimestamp(raw: string): string | null {
  if (raw.trim() === '') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function parseLedger(rows: string[][]): { loans: LedgerLoan[]; issues: Issue[] } {
  const headerIdx = rows.findIndex((r) => r.includes('ContractId') && r.includes('Lender'));
  if (headerIdx < 0) throw new Error('Ledger: header row (with "Lender" and "ContractId") not found');
  const header = rows[headerIdx]!;
  const first = header.indexOf('Lender');
  LEDGER_COLUMNS.forEach((name, i) => {
    if (header[first + i] !== name) {
      throw new Error(`Ledger: expected column "${name}" at position ${first + i}, found "${header[first + i]}"`);
    }
  });

  const loans: LedgerLoan[] = [];
  const issues: Issue[] = [];
  const seenIds = new Map<string, number>();
  const issue = (row: number, kind: Issue['kind'], detail: string) => issues.push({ tab: 'Ledger', row, kind, detail });

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i]!;
    if (!cells.some((c) => c.trim() !== '')) continue;
    const row = i + 1;
    const raw: Record<string, string> = {};
    LEDGER_COLUMNS.forEach((name, c) => (raw[name] = cells[first + c] ?? ''));

    const lender = raw['Lender']!.trim();
    const borrower = raw['Name']!.trim();
    const principalMinor = parseAmountToMinor(raw['Amount']!);
    const status = statusFromLabel(raw['Status']!);
    const issuedOn = raw['Issued Date']!.trim();

    const missing = [
      lender === '' && 'lender',
      borrower === '' && 'borrower',
      principalMinor === null && `amount "${raw['Amount']}"`,
      status === null && `status "${raw['Status']}"`,
      !/^\d{4}-\d{2}-\d{2}$/.test(issuedOn) && `issued date "${raw['Issued Date']}"`,
    ].filter(Boolean);
    if (missing.length > 0 || principalMinor === null || status === null) {
      issue(row, 'skipped', `row not imported, unusable ${missing.join(', ')}`);
      continue;
    }

    const noteParts: string[] = [];
    if (raw['Notes']!.trim() !== '') noteParts.push(raw['Notes']!.trim());

    // Currency: one of the four, or a non-cash marker such as "N/A".
    const currencyRaw = raw['Currency']!.trim().toUpperCase();
    let currency: Currency | null = null;
    if (isCurrency(currencyRaw)) {
      currency = currencyRaw;
    } else {
      issue(row, 'non_cash_currency', `currency "${raw['Currency']}" stored as none (non-cash)`);
    }

    // Duration: decimal weeks; anything else is kept in the notes.
    const durationRaw = raw['Duration (weeks)']!.trim();
    let durationWeeks: number | null = null;
    if (/^\d+(\.\d+)?$/.test(durationRaw)) {
      durationWeeks = Number(durationRaw);
    } else {
      issue(row, 'bad_duration', durationRaw === '' ? 'duration blank' : `duration "${durationRaw}" is not a number`);
      if (durationRaw !== '') noteParts.push(`[Sheet duration: ${durationRaw}]`);
    }

    // Contract ID: normalise, then keep the first occurrence of a duplicate.
    let contractId = normalizeContractId(raw['ContractId']);
    if (contractId !== null) {
      if (contractId !== raw['ContractId']) {
        issue(row, 'contract_id_normalised', `${JSON.stringify(raw['ContractId'])} -> ${contractId}`);
      }
      if (!/^[A-Z0-9]{7}$/.test(contractId)) {
        issue(row, 'odd_contract_id', `"${contractId}" is not 7 letters/digits`);
      }
      const firstRow = seenIds.get(contractId);
      if (firstRow !== undefined) {
        issue(row, 'duplicate_contract_id', `${contractId} already used on row ${firstRow}; imported without a contract ID`);
        noteParts.push(`[Sheet listed contract ${contractId}, also used on row ${firstRow}]`);
        contractId = null;
      } else {
        seenIds.set(contractId, row);
      }
    }

    for (const [who, name] of [['lender', lender], ['borrower', borrower]] as const) {
      if (/[\s[\]()]/.test(name)) issue(row, 'name_has_spaces_or_tags', `${who} "${name}" is not a plain username`);
    }

    const corp = blankToNull(raw['CORP']!);
    loans.push({
      row,
      lender,
      borrower,
      companyCode: blankToNull(raw['CO']!),
      corpCode: corp === '---' ? null : corp,
      principalMinor,
      currency,
      issuedOn,
      durationWeeks,
      status,
      contractId,
      autoTrack: raw['Auto track?']!.trim().toUpperCase() === 'TRUE',
      lastSyncedAt: parseSheetTimestamp(raw['Last Auto Updated']!),
      notes: noteParts.length > 0 ? noteParts.join(' ') : null,
      raw,
    });
  }

  return { loans, issues };
}

export interface Party {
  /** First spelling seen in the sheet. */
  username: string;
  companyCode: string | null;
  corpCode: string | null;
}

/**
 * Collapse loan rows into unique lenders and borrowers (case-insensitive).
 * Borrowers keep their first-seen company and corp code; later differences are reported, not applied.
 */
export function collectParties(loans: LedgerLoan[]): { lenders: Party[]; borrowers: Party[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const lenders = new Map<string, Party>();
  const borrowers = new Map<string, Party>();
  const spellings = new Map<string, Set<string>>();
  const identities = new Map<string, Set<string>>();

  const noteSpelling = (kind: string, name: string, row: number) => {
    const key = `${kind}:${name.toLowerCase()}`;
    const set = spellings.get(key) ?? new Set<string>();
    if (set.size > 0 && !set.has(name)) {
      issues.push({ tab: 'Ledger', row, kind: 'name_case_variant', detail: `${kind} "${name}" also spelled "${[...set][0]}"; merged` });
    }
    set.add(name);
    spellings.set(key, set);
  };

  for (const loan of loans) {
    noteSpelling('lender', loan.lender, loan.row);
    noteSpelling('borrower', loan.borrower, loan.row);

    const lKey = loan.lender.toLowerCase();
    if (!lenders.has(lKey)) lenders.set(lKey, { username: loan.lender, companyCode: null, corpCode: null });

    const bKey = loan.borrower.toLowerCase();
    const existing = borrowers.get(bKey);
    if (!existing) {
      borrowers.set(bKey, { username: loan.borrower, companyCode: loan.companyCode, corpCode: loan.corpCode });
    } else {
      existing.companyCode ??= loan.companyCode;
      existing.corpCode ??= loan.corpCode;
    }
    const ids = identities.get(bKey) ?? new Set<string>();
    ids.add(`${loan.companyCode ?? '-'}/${loan.corpCode ?? '-'}`);
    identities.set(bKey, ids);
  }

  for (const [key, ids] of identities) {
    const companies = new Set([...ids].map((x) => x.split('/')[0]).filter((x) => x !== '-'));
    if (companies.size > 1) {
      issues.push({
        tab: 'Ledger',
        row: 0,
        kind: 'identity_conflict',
        detail: `borrower "${borrowers.get(key)!.username}" appears with company codes ${[...companies].join(', ')}; kept first seen`,
      });
    }
  }

  return { lenders: [...lenders.values()], borrowers: [...borrowers.values()], issues };
}

export interface HistoryEntry {
  row: number;
  contractId: string;
  oldStatus: Status | null;
  newStatus: Status;
  changedAt: string;
}

/** Tab "Status History": Time (UTC) | ContractId | Lender | Borrower | Old Status | New Status. */
export function parseStatusHistory(rows: string[][]): { entries: HistoryEntry[]; issues: Issue[] } {
  const entries: HistoryEntry[] = [];
  const issues: Issue[] = [];
  const headerIdx = rows.findIndex((r) => r.includes('ContractId') && r.includes('New Status'));
  if (headerIdx < 0) throw new Error('Status History: header row not found');

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i]!;
    if (!cells.some((c) => c.trim() !== '')) continue;
    const row = i + 1;
    const changedAt = parseSheetTimestamp(cells[0] ?? '');
    const contractId = normalizeContractId(cells[1]);
    const newStatus = statusFromLabel(cells[5] ?? '');
    const oldRaw = (cells[4] ?? '').trim();
    const oldStatus = oldRaw === '' ? null : statusFromLabel(oldRaw);
    if (!changedAt || !contractId || !newStatus || (oldRaw !== '' && !oldStatus)) {
      issues.push({ tab: 'Status History', row, kind: 'skipped', detail: `unusable row: ${JSON.stringify(cells.slice(0, 6))}` });
      continue;
    }
    entries.push({ row, contractId, oldStatus, newStatus, changedAt });
  }
  return { entries, issues };
}

export interface LenderSyncEntry {
  lender: string;
  httpStatus: number | null;
  contractsReturned: number | null;
  loansKept: number | null;
  checkedAt: string;
}

/** Tab "Lender Sync": Lender | HTTP code | contracts returned | loans kept | Checked (UTC). */
export function parseLenderSync(rows: string[][]): LenderSyncEntry[] {
  const num = (s: string | undefined) => (s && /^\d+$/.test(s.trim()) ? Number(s.trim()) : null);
  const out: LenderSyncEntry[] = [];
  for (const cells of rows.slice(1)) {
    const lender = (cells[0] ?? '').trim();
    const checkedAt = parseSheetTimestamp(cells[4] ?? '');
    if (lender === '' || !checkedAt) continue;
    out.push({ lender, httpStatus: num(cells[1]), contractsReturned: num(cells[2]), loansKept: num(cells[3]), checkedAt });
  }
  return out;
}
