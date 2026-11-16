// Downloads the bureau sheet's tabs as CSV into data/sheet/.
// Uses the plain CSV export (not gviz, which drops text typed into numeric columns).
import fs from 'node:fs';
import { SHEET_DIR, SHEET_ID, SHEET_TABS, tabPath, type TabKey } from './lib/sheet-config';

fs.mkdirSync(SHEET_DIR, { recursive: true });

for (const [tab, gid] of Object.entries(SHEET_TABS) as [TabKey, number][]) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.startsWith('text/csv')) {
    throw new Error(`${tab}: HTTP ${res.status} (${type}). Is the sheet shared publicly and the gid correct?`);
  }
  const text = await res.text();
  fs.writeFileSync(tabPath(tab), text);
  console.log(`${tab}: ${text.split('\n').length} lines -> ${tabPath(tab)}`);
}
