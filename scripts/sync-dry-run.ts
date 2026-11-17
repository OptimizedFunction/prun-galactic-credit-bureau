// Fetches every lender who connected a FIO key from live FIO and prints what the sync WOULD change. Writes nothing.
// Needs FIO_KEY_SECRET in .dev.vars.
//
//   npm run sync:dry
import { getPlatformProxy } from 'wrangler';
import type { Currency, Status } from '../src/lib/normalize';
import { fetchLoanContracts } from '../src/sync/fio';
import { extractLoan, planSync, type ExistingLoan, type FioLoan, type LenderLoans } from '../src/sync/plan';
import { fetchTracked, trackedLenders } from '../src/sync/run';

const proxy = await getPlatformProxy<{ DB: D1Database; FIO_KEY_SECRET?: string }>();
const { DB: db, FIO_KEY_SECRET: keySecret } = proxy.env;

try {
  if (!keySecret) throw new Error('Set FIO_KEY_SECRET in .dev.vars');

  const lenders = await trackedLenders(db, { keySecret });
  const results = await Promise.all(lenders.map((l) => fetchTracked(l, fetchLoanContracts)));

  const fetched: LenderLoans[] = [];
  const conditionTypes = new Map<string, number>();
  const contractKeys = new Set<string>();
  const conditionKeys = new Set<string>();

  console.log('Lender               HTTP  contracts  kept  skipped');
  for (const r of results) {
    if (r.contracts === null) {
      fetched.push({ lender: r.lender, loans: null });
      console.log(`${r.lender.padEnd(20)} ${String(r.httpStatus ?? '-').padEnd(5)} ${r.error}`);
      continue;
    }
    const skips = new Map<string, number>();
    const loans: FioLoan[] = [];
    for (const contract of r.contracts) {
      Object.keys(contract).forEach((k) => contractKeys.add(k));
      for (const cond of contract.Conditions ?? []) {
        Object.keys(cond).forEach((k) => conditionKeys.add(k));
        conditionTypes.set(cond.Type, (conditionTypes.get(cond.Type) ?? 0) + 1);
      }
      const loan = extractLoan(contract);
      if (typeof loan === 'string') skips.set(loan, (skips.get(loan) ?? 0) + 1);
      else loans.push(loan);
    }
    fetched.push({ lender: r.lender, loans });
    const skipText = [...skips].map(([k, n]) => `${k} ${n}`).join(', ');
    console.log(`${r.lender.padEnd(20)} 200   ${String(r.contracts.length).padEnd(10)} ${String(loans.length).padEnd(5)} ${skipText}${r.error ? `  [${r.error}]` : ''}`);
  }

  console.log('\nContract fields:', [...contractKeys].sort().join(', '));
  console.log('Condition fields:', [...conditionKeys].sort().join(', '));
  console.log('Condition types:', [...conditionTypes].map(([k, n]) => `${k} ${n}`).join(', '));

  const existing = (
    await db
      .prepare(
        `SELECT l.id, l.contract_id, le.username AS lender, l.status, l.auto_track, l.trust, l.principal_minor,
                l.currency, l.issued_on, l.duration_weeks
         FROM loans l JOIN lenders le ON le.id = l.lender_id WHERE l.contract_id IS NOT NULL`,
      )
      .all<{ id: number; contract_id: string; lender: string; status: Status; auto_track: number; trust: ExistingLoan['trust']; principal_minor: number; currency: Currency | null; issued_on: string; duration_weeks: number | null }>()
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
  const byId = new Map(existing.map((l) => [l.contractId, l]));

  // How well do FIO-derived values agree with what the sheet recorded for the same contracts?
  let compared = 0;
  let amountDiff = 0;
  let dateDiff = 0;
  let durationDiff = 0;
  const durationSamples: string[] = [];
  for (const { loans } of fetched) {
    for (const loan of loans ?? []) {
      const have = byId.get(loan.contractId);
      if (!have) continue;
      compared++;
      if (have.principalMinor !== loan.principalMinor || have.currency !== loan.currency) amountDiff++;
      if (have.issuedOn !== loan.issuedOn) dateDiff++;
      if (have.durationWeeks !== null && loan.durationWeeks !== null && Math.abs(have.durationWeeks - loan.durationWeeks) > 0.5) {
        durationDiff++;
        if (durationSamples.length < 8) durationSamples.push(`${loan.contractId}: sheet ${have.durationWeeks}, FIO ${loan.durationWeeks}`);
      }
    }
  }
  console.log(`\nContracts already in the bureau: ${compared}`);
  console.log(`  amount or currency differs: ${amountDiff}`);
  console.log(`  issue date differs: ${dateDiff}`);
  console.log(`  duration differs by more than half a week: ${durationDiff}`);
  durationSamples.forEach((s) => console.log(`    ${s}`));

  const actions = planSync(existing, fetched, new Date());
  const tally = new Map<string, number>();
  for (const a of actions) {
    const key = a.kind === 'insert' ? `new loan (${a.status})` : a.kind === 'status' ? `${a.from} -> ${a.to}${a.loan ? '' : ' (not returned by FIO)'}` : a.kind === 'duration' ? 'duration refreshed on a tracked loan' : 'manual row verified';
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  console.log(`\nThe sync would make ${actions.length} changes:`);
  [...tally].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));
} finally {
  await proxy.dispose();
}
