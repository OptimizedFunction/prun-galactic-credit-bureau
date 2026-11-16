// Checks the local database against the sheet's own Summary tab.
//
// The Summary tab adds all currencies together. That is wrong for the website (which never mixes
// currencies) but it is what the sheet shows, so this check reproduces it to prove the import is complete.
// The sheet's rules, reproduced here: totals leave out Terminated loans; "current" is In Progress + Overdue;
// breaches count loans whose status is Breached.
import fs from 'node:fs';
import { parseCsv } from './lib/csv';
import { openLocalDb } from './lib/db';
import { tabPath } from './lib/sheet-config';
import { formatMinor, parseAmountToMinor } from '../src/lib/normalize';

const rows = parseCsv(fs.readFileSync(tabPath('summary'), 'utf8'));
const headerIdx = rows.findIndex((r) => r[3] === 'Username' && r[11] === 'Username');
if (headerIdx < 0) throw new Error('Summary: header row not found');

interface BorrowerLine { total: number; breached: number }
interface LenderLine { total: number; current: number }
const sheetBorrowers = new Map<string, BorrowerLine>();
const sheetLenders = new Map<string, LenderLine>();

for (const r of rows.slice(headerIdx + 1)) {
  const borrower = (r[3] ?? '').trim();
  if (borrower !== '') {
    sheetBorrowers.set(borrower.toLowerCase(), { total: parseAmountToMinor(r[6] ?? '') ?? -1, breached: Number(r[7] ?? '0') });
  }
  const lender = (r[11] ?? '').trim();
  if (lender !== '') {
    sheetLenders.set(lender.toLowerCase(), { total: parseAmountToMinor(r[12] ?? '') ?? -1, current: parseAmountToMinor(r[13] ?? '') ?? -1 });
  }
}

const { db, dispose } = await openLocalDb();
let mismatches = 0;
const report = (what: string, name: string, sheet: number, ours: number, money = true) => {
  mismatches++;
  if (mismatches <= 40) {
    const f = (n: number) => (money ? formatMinor(n) : String(n));
    console.log(`  MISMATCH ${what} ${name}: sheet ${f(sheet)}, database ${f(ours)}`);
  }
};

try {
  const dbBorrowers = await db
    .prepare(
      `SELECT lower(b.username) AS name, SUM(CASE WHEN l.status <> 'terminated' THEN l.principal_minor ELSE 0 END) AS total, SUM(l.status = 'breached') AS breached
       FROM loans l JOIN borrowers b ON b.id = l.borrower_id GROUP BY b.id`,
    )
    .all<{ name: string; total: number; breached: number }>();
  const dbLenders = await db
    .prepare(
      `SELECT lower(le.username) AS name, SUM(CASE WHEN l.status <> 'terminated' THEN l.principal_minor ELSE 0 END) AS total,
              SUM(CASE WHEN l.status IN ('in_progress', 'overdue') THEN l.principal_minor ELSE 0 END) AS current
       FROM loans l JOIN lenders le ON le.id = l.lender_id GROUP BY le.id`,
    )
    .all<{ name: string; total: number; current: number }>();

  console.log(`Borrowers: sheet ${sheetBorrowers.size}, database ${dbBorrowers.results.length}`);
  for (const b of dbBorrowers.results) {
    const s = sheetBorrowers.get(b.name);
    if (!s) {
      mismatches++;
      console.log(`  MISSING in sheet summary: borrower ${b.name}`);
      continue;
    }
    if (s.total !== b.total) report('borrower total', b.name, s.total, b.total);
    if (s.breached !== b.breached) report('borrower breaches', b.name, s.breached, b.breached, false);
  }
  const dbBorrowerNames = new Set(dbBorrowers.results.map((b) => b.name));
  for (const name of sheetBorrowers.keys()) {
    if (!dbBorrowerNames.has(name)) {
      mismatches++;
      console.log(`  MISSING in database: borrower ${name}`);
    }
  }

  console.log(`Lenders: sheet ${sheetLenders.size}, database with loans ${dbLenders.results.length}`);
  const dbLenderMap = new Map(dbLenders.results.map((l) => [l.name, l]));
  for (const [name, s] of sheetLenders) {
    const l = dbLenderMap.get(name) ?? { total: 0, current: 0 };
    if (s.total !== l.total) report('lender total', name, s.total, l.total);
    if (s.current !== l.current) report('lender current', name, s.current, l.current);
  }
  for (const name of dbLenderMap.keys()) {
    if (!sheetLenders.has(name)) {
      mismatches++;
      console.log(`  MISSING in sheet summary: lender ${name}`);
    }
  }

  const grand = await db.prepare("SELECT SUM(principal_minor) AS total FROM loans WHERE status <> 'terminated'").first<{ total: number }>();
  const sheetGrand = [...sheetLenders.values()].reduce((sum, l) => sum + Math.max(l.total, 0), 0);
  console.log(`Grand total lent (all currencies added, as the sheet does): sheet ${formatMinor(sheetGrand)}, database ${formatMinor(grand!.total)}`);

  if (mismatches > 0) {
    console.log(`\nFAILED: ${mismatches} mismatches.`);
    process.exitCode = 1;
  } else {
    console.log('\nOK: every borrower total, breach count, lender total and lender current amount matches the sheet.');
  }
} finally {
  await dispose();
}
