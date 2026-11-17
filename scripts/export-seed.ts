// Writes the contents of the local D1 database (or the one in D1_PERSIST) as INSERT statements, ready for
// `wrangler d1 execute bureau --remote --file <file>` against a freshly migrated, empty database.
//
//   tsx scripts/export-seed.ts data/seed.sql
import fs from 'node:fs';
import { openLocalDb } from './lib/db';

// Parents before children.
const TABLES = ['lenders', 'borrowers', 'borrower_aliases', 'loans', 'loan_status_history', 'revisions'];

const out = process.argv[2];
if (!out) throw new Error('Usage: tsx scripts/export-seed.ts <output.sql>');

const literal = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

const { db, dispose } = await openLocalDb();
try {
  const lines: string[] = [];
  for (const table of TABLES) {
    const { results } = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all<Record<string, unknown>>();
    for (const row of results) {
      const columns = Object.keys(row);
      lines.push(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => literal(row[c])).join(', ')});`);
    }
    console.log(`${table}: ${results.length}`);
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`Wrote ${lines.length} rows to ${out}`);
} finally {
  await dispose();
}
