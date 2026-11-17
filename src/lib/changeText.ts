// Turns stored revisions (before/after field values) into words a reader can follow.
// Shared by the loan page's timeline and the Recent changes page.
import { formatMinor, isStatus, parseAmountToMinor, STATUS_LABELS } from './normalize';

export const TRUST_LABELS = {
  fio_verified: 'FIO-verified',
  lender_reported: 'Lender-reported',
  community_edited: 'Community-edited',
} as const;

export type Trust = keyof typeof TRUST_LABELS;

/** One sentence on what each trust label means. */
export const TRUST_HELP: Record<Trust, string> = {
  fio_verified: 'Checked against the in-game contract through FIO.',
  lender_reported: 'Reported by the lender; not checked against the game.',
  community_edited: 'Typed in or changed by a community member; not checked against the game.',
};

export const FIELD_LABELS: Record<string, string> = {
  lender: 'Lender',
  borrower: 'Borrower',
  companyCode: 'Company',
  corpCode: 'Corp',
  principal: 'Amount',
  currency: 'Currency',
  issuedOn: 'Issued',
  durationWeeks: 'Duration (weeks)',
  status: 'Status',
  contractId: 'Contract ID',
  autoTrack: 'Auto track',
  notes: 'Notes',
  trust: 'Trust',
  deleted: 'Deleted',
};

/** A stored field value as a reader should see it. */
export function showValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'blank';
  if (field === 'status' && isStatus(value)) return STATUS_LABELS[value];
  if (field === 'trust' && typeof value === 'string' && value in TRUST_LABELS) return TRUST_LABELS[value as Trust];
  if (field === 'principal' && typeof value === 'string') {
    const minor = parseAmountToMinor(value);
    return minor === null ? value : formatMinor(minor);
  }
  if (field === 'durationWeeks' && typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

export interface ChangeLine {
  label: string;
  /** null when there was no earlier value to show (a newly added loan). */
  from: string | null;
  to: string;
}

export interface ChangeText {
  /** What happened, in a word or two: "Added", "Changed", "Deleted", "Restored", "Imported from the Google Sheet". */
  summary: string;
  lines: ChangeLine[];
  /** A reason recorded with the change, if any. */
  note: string | null;
}

const asRecord = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Fields shown when a loan is added, in reading order. */
const CREATE_FIELDS = ['lender', 'borrower', 'principal', 'currency', 'issuedOn', 'durationWeeks', 'status', 'contractId', 'notes'];

export function describeRevision(revision: { action: string; before: unknown; after: unknown }): ChangeText {
  const before = asRecord(revision.before);
  const after = asRecord(revision.after);
  const note = typeof after['reason'] === 'string' ? after['reason'] : null;

  if (revision.action === 'import') return { summary: 'Imported from the Google Sheet', lines: [], note };
  if (revision.action === 'delete') return { summary: 'Deleted', lines: [], note };
  if (revision.action === 'create') {
    const lines = CREATE_FIELDS.filter((f) => after[f] !== null && after[f] !== undefined).map((f) => ({ label: FIELD_LABELS[f] ?? f, from: null, to: showValue(f, after[f]) }));
    return { summary: 'Added', lines, note };
  }
  if ('deleted' in after) return { summary: after['deleted'] ? 'Deleted' : 'Restored', lines: [], note };

  const lines = Object.keys(after)
    .filter((f) => f !== 'reason')
    .map((f) => ({ label: FIELD_LABELS[f] ?? f, from: showValue(f, before[f]), to: showValue(f, after[f]) }));
  return { summary: 'Changed', lines, note };
}
