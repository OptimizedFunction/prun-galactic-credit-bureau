// Pure helpers shared by the Worker, the sheet importer and (later) the FIO sync.

export const CURRENCIES = ['AIC', 'CIS', 'ICA', 'NCC'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const STATUSES = ['in_progress', 'complete', 'overdue', 'breached', 'terminated', 'stale'] as const;
export type Status = (typeof STATUSES)[number];

/** Statuses that count as money currently out on loan. Stale is unknown, so it is reported separately. */
export const CURRENT_STATUSES: readonly Status[] = ['in_progress', 'overdue'];

export const STATUS_LABELS: Record<Status, string> = {
  in_progress: 'In Progress',
  complete: 'Complete',
  overdue: 'Overdue',
  breached: 'Breached',
  terminated: 'Terminated',
  stale: 'Stale',
};

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

/** Trim (including stray \r and spaces) and upper-case a contract ID. Blank becomes null. */
export function normalizeContractId(raw: string | null | undefined): string | null {
  const id = (raw ?? '').replace(/\s+/g, '').toUpperCase();
  return id === '' ? null : id;
}

/** "In Progress" (sheet label, any case/spacing) -> "in_progress". */
export function statusFromLabel(raw: string): Status | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return isStatus(key) ? key : null;
}

/** FIO contract status -> bureau status. null means "not a live loan, ignore". */
export function statusFromFio(fioStatus: string): Status | null {
  switch (fioStatus) {
    case 'PARTIALLY_FULFILLED':
      return 'in_progress';
    case 'FULFILLED':
      return 'complete';
    case 'DEADLINE_EXCEEDED':
      return 'overdue';
    case 'BREACHED':
      return 'breached';
    case 'TERMINATED':
      return 'terminated';
    default:
      return null;
  }
}

/** Parse "$25,000,000" / "1,234.5" / "100" into hundredths, using integer maths only. */
export function parseAmountToMinor(raw: string): number | null {
  const m = /^\$?\s*([\d,]+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  const whole = m[1]!.replace(/,/g, '');
  if (whole === '') return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  const minor = Number(whole) * 100 + Number(frac);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** 2500000050 -> "25000000.50" (machine-readable, for the API). */
export function minorToDecimal(minor: number): string {
  const whole = Math.trunc(minor / 100);
  const frac = Math.abs(minor % 100);
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

/** 2500000050 -> "25,000,000.50"; whole amounts drop the decimals (for pages). */
export function formatMinor(minor: number): string {
  const whole = Math.trunc(minor / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = Math.abs(minor % 100);
  return frac === 0 ? whole : `${whole}.${String(frac).padStart(2, '0')}`;
}

/** Issue date + duration in (possibly fractional) weeks -> maturity date, YYYY-MM-DD. */
export function maturityDate(issuedOn: string, durationWeeks: number | null): string | null {
  if (durationWeeks === null) return null;
  const start = Date.parse(`${issuedOn}T00:00:00Z`);
  if (Number.isNaN(start)) return null;
  const days = Math.round(durationWeeks * 7);
  return new Date(start + days * 86_400_000).toISOString().slice(0, 10);
}
