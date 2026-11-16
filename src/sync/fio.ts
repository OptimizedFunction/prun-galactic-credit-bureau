// Thin client for FIO (https://rest.fnar.net), the community API that caches game data.
// FIO publishes no payload schema; the fields below were checked against live responses (2026-11-17).
// Everything FIO-shaped is confined to this file and plan.ts.

const FIO_BASE = 'https://rest.fnar.net';
const TIMEOUT_MS = 20_000;
/** FIO caps the result at `count`. A response of exactly this many contracts may be cut off. */
export const LOAN_FETCH_COUNT = 1000;

export interface FioCondition {
  Type: string;
  Party: string;
  Status?: string | null;
  /** Set on LOAN_PAYOUT (the principal). Installments use the three amounts below instead. */
  Amount?: number | null;
  Currency?: string | null;
  InterestAmount?: number | null;
  RepaymentAmount?: number | null;
  TotalAmount?: number | null;
  /** Time allowed once the previous condition is fulfilled. Missing on older cached contracts. */
  DeadlineDurationMs?: number | null;
  /** Only set on the condition that is currently due. */
  DeadlineEpochMs?: number | null;
  ConditionIndex?: number | null;
}

export interface FioContract {
  ContractLocalId: string;
  Status: string;
  /** This user's side of the contract: PROVIDER or CUSTOMER. */
  Party: string;
  /** The other side's company name. */
  PartnerName: string;
  PartnerCompanyCode?: string | null;
  Name?: string | null;
  Preamble?: string | null;
  DateEpochMs: number;
  /** Deadline of the condition currently due, if any. */
  DueDateEpochMs?: number | null;
  Conditions: FioCondition[];
}

export interface LoanFetchResult {
  lender: string;
  httpStatus: number | null;
  contracts: FioContract[] | null;
  error: string | null;
}

/** Loan contracts of one user. Needs that user to have granted `permissionContracts` to the key's account. */
export async function fetchLoanContracts(apiKey: string, lender: string, fetcher: typeof fetch = fetch): Promise<LoanFetchResult> {
  try {
    const res = await fetcher(`${FIO_BASE}/contract/loans/${encodeURIComponent(lender)}?count=${LOAN_FETCH_COUNT}`, {
      headers: { Authorization: apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) {
      const why = res.status === 401 ? 'FIO permission not granted' : res.status === 204 ? 'FIO has no data for this user' : `HTTP ${res.status}`;
      return { lender, httpStatus: res.status, contracts: null, error: why };
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return { lender, httpStatus: 200, contracts: null, error: 'Unexpected response (not a list)' };
    return {
      lender,
      httpStatus: 200,
      contracts: body as FioContract[],
      error: body.length >= LOAN_FETCH_COUNT ? `Returned ${body.length} contracts, the request limit; older ones may be missing` : null,
    };
  } catch (err) {
    return { lender, httpStatus: null, contracts: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface FioCompany {
  username: string;
  companyCode: string | null;
  corpCode: string | null;
}

/** Company name -> owner. null when FIO does not know the company (e.g. it was liquidated) or the call fails. */
export async function fetchCompanyByName(apiKey: string, companyName: string, fetcher: typeof fetch = fetch): Promise<FioCompany | null> {
  try {
    const res = await fetcher(`${FIO_BASE}/company/name/${encodeURIComponent(companyName)}`, {
      headers: { Authorization: apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { UserName?: unknown; CompanyCode?: unknown; CorporationCode?: unknown };
    if (typeof body.UserName !== 'string' || body.UserName.trim() === '') return null;
    const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
    return { username: body.UserName.trim(), companyCode: text(body.CompanyCode), corpCode: text(body.CorporationCode) };
  } catch {
    return null;
  }
}

/**
 * Asks FIO whose key this is. Returns the account's username (FIO gives it in upper case),
 * null if FIO rejects the key, and throws if FIO cannot be reached.
 */
export async function fetchKeyOwner(apiKey: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const res = await fetcher(`${FIO_BASE}/auth`, { headers: { Authorization: apiKey }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401) return null;
  if (res.status !== 200) throw new Error(`FIO answered HTTP ${res.status}`);
  const name = (await res.text()).trim();
  return name === '' ? null : name;
}
