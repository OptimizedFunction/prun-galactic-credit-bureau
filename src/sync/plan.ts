// The sync's decisions, as pure functions: FIO contracts in, a list of changes out. No I/O here.
import {
  isCurrency,
  maturityDate,
  normalizeContractId,
  statusFromFio,
  type Currency,
  type Status,
} from '../lib/normalize';
import type { FioContract } from './fio';

const WEEK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

export interface FioLoan {
  contractId: string;
  /** Borrower's company name as FIO gives it. */
  partnerName: string;
  partnerCompanyCode: string | null;
  principalMinor: number;
  currency: Currency;
  issuedOn: string;
  durationWeeks: number | null;
  /** Status as FIO reports it, before any Stale rule. */
  status: Status;
  raw: FioContract;
}

export type Skip = 'not_a_loan' | 'not_the_lender' | 'not_live' | 'unusable';

/**
 * Turns one of a lender's FIO contracts into a loan, or says why it is skipped.
 * The lender is whoever pays the LOAN_PAYOUT; contracts where the fetched user is the other side are
 * loans they received, which their own lender reports.
 */
export function extractLoan(contract: FioContract): FioLoan | Skip {
  const conditions = Array.isArray(contract.Conditions) ? contract.Conditions : [];
  const payout = conditions.find((c) => c.Type === 'LOAN_PAYOUT');
  if (!payout) return 'not_a_loan';
  if (contract.Party !== payout.Party) return 'not_the_lender';

  const status = statusFromFio(contract.Status);
  if (status === null) return 'not_live';

  const contractId = normalizeContractId(contract.ContractLocalId);
  const partnerName = typeof contract.PartnerName === 'string' ? contract.PartnerName.trim() : '';
  const amount = payout.Amount;
  if (
    contractId === null ||
    partnerName === '' ||
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    !isCurrency(payout.Currency) ||
    typeof contract.DateEpochMs !== 'number'
  ) {
    return 'unusable';
  }

  // Duration: from the contract date to the last installment's deadline.
  const installments = conditions.filter((c) => c.Type === 'LOAN_INSTALLMENT');
  const deadlines = installments.map((c) => c.DeadlineEpochMs ?? c.DueDateEpochMs).filter((d): d is number => typeof d === 'number');
  const durations = installments.map((c) => c.DeadlineDurationMs).filter((d): d is number => typeof d === 'number');
  let durationMs: number | null = null;
  if (deadlines.length > 0) durationMs = Math.max(...deadlines) - contract.DateEpochMs;
  else if (durations.length > 0) durationMs = Math.max(...durations);
  const durationWeeks = durationMs !== null && durationMs >= 0 ? Math.round((durationMs / WEEK_MS) * 10_000) / 10_000 : null;

  return {
    contractId,
    partnerName,
    partnerCompanyCode: typeof contract.PartnerCompanyCode === 'string' && contract.PartnerCompanyCode.trim() !== '' ? contract.PartnerCompanyCode.trim() : null,
    principalMinor: Math.round(amount * 100),
    currency: payout.Currency,
    issuedOn: new Date(contract.DateEpochMs).toISOString().slice(0, 10),
    durationWeeks,
    status,
    raw: contract,
  };
}

/** A loan already in the bureau that has a contract ID. */
export interface ExistingLoan {
  id: number;
  contractId: string;
  lender: string;
  status: Status;
  autoTrack: boolean;
  trust: 'fio_verified' | 'lender_reported' | 'community_edited';
  principalMinor: number;
  currency: Currency | null;
  issuedOn: string;
  durationWeeks: number | null;
}

/** One lender's result this run. `loans` is null when the fetch failed, in which case nothing is concluded about them. */
export interface LenderLoans {
  lender: string;
  loans: FioLoan[] | null;
}

export type Action =
  /** A contract the bureau has not seen. */
  | { kind: 'insert'; lender: string; loan: FioLoan; status: Status }
  /** A tracked loan whose status changed. `loan` is absent when FIO no longer returns it (Stale sweep). */
  | { kind: 'status'; loanId: number; contractId: string; from: Status; to: Status; loan?: FioLoan }
  /** A manual or lender-reported row that FIO confirms. Only its trust label changes. */
  | { kind: 'verify'; loanId: number; contractId: string; loan: FioLoan };

const UNRESOLVED: readonly Status[] = ['in_progress', 'overdue'];
const RESOLVED: readonly Status[] = ['complete', 'breached', 'terminated'];

/** True once `now` is more than `graceDays` past the loan's maturity. Unknown maturity is never past grace. */
export function pastGrace(issuedOn: string, durationWeeks: number | null, now: Date, graceDays: number): boolean {
  const matures = maturityDate(issuedOn, durationWeeks);
  if (matures === null) return false;
  return now.getTime() > Date.parse(`${matures}T00:00:00Z`) + graceDays * DAY_MS;
}

/**
 * Decides what to change.
 *
 * - New contracts are inserted.
 * - Tracked loans follow FIO's status. A real FIO status always wins.
 * - Stale: a loan FIO still shows as active, or no longer returns while the bureau has it active, becomes
 *   Stale once it is `graceDays` past maturity (measured from maturity, not issue date). Stale never
 *   replaces Complete, Breached or Terminated.
 * - Manual rows (autoTrack off) are never changed, except that a matching FIO contract marks them verified.
 * - Lenders whose fetch failed are left entirely alone.
 */
export function planSync(existing: ExistingLoan[], fetched: LenderLoans[], now: Date, graceDays = 91): Action[] {
  const actions: Action[] = [];
  const byId = new Map(existing.map((l) => [l.contractId, l]));
  const seen = new Set<string>();
  const fetchedLenders = new Set<string>();

  for (const { lender, loans } of fetched) {
    if (loans === null) continue;
    fetchedLenders.add(lender.toLowerCase());

    for (const loan of loans) {
      if (seen.has(loan.contractId)) continue;
      seen.add(loan.contractId);

      const stale = UNRESOLVED.includes(loan.status) && pastGrace(loan.issuedOn, loan.durationWeeks, now, graceDays);
      const status: Status = stale ? 'stale' : loan.status;
      const current = byId.get(loan.contractId);

      if (!current) {
        actions.push({ kind: 'insert', lender, loan, status });
      } else if (!current.autoTrack) {
        const matches =
          current.lender.toLowerCase() === lender.toLowerCase() &&
          current.principalMinor === loan.principalMinor &&
          current.currency === loan.currency;
        if (matches && current.trust !== 'fio_verified') {
          actions.push({ kind: 'verify', loanId: current.id, contractId: current.contractId, loan });
        }
      } else if (current.status !== status && !(status === 'stale' && RESOLVED.includes(current.status))) {
        actions.push({ kind: 'status', loanId: current.id, contractId: current.contractId, from: current.status, to: status, loan });
      }
    }
  }

  // Stale sweep: tracked, still active in the bureau, not returned by a lender we did hear from.
  for (const loan of existing) {
    if (
      loan.autoTrack &&
      UNRESOLVED.includes(loan.status) &&
      !seen.has(loan.contractId) &&
      fetchedLenders.has(loan.lender.toLowerCase()) &&
      pastGrace(loan.issuedOn, loan.durationWeeks, now, graceDays)
    ) {
      actions.push({ kind: 'status', loanId: loan.id, contractId: loan.contractId, from: loan.status, to: 'stale' });
    }
  }

  return actions;
}
