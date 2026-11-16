import path from 'node:path';

/** The public "PRUN Credit Bureau Automated" sheet. Override with SHEET_ID to import a copy. */
export const SHEET_ID = process.env.SHEET_ID ?? '1KDopb9Um5ZC40FV0T9hPrBZhU3a4WLellHjiaJ7HOSQ';

/** Tab name -> gid. Copies of the sheet get new gids for tabs added after the copy; override via SHEET_GIDS (JSON). */
export const SHEET_TABS: Record<TabKey, number> = {
  ledger: 0,
  'status-history': 413121668,
  'lender-sync': 213507354,
  summary: 1118378778,
  ...(process.env.SHEET_GIDS ? (JSON.parse(process.env.SHEET_GIDS) as Partial<Record<TabKey, number>>) : {}),
};

export type TabKey = 'ledger' | 'status-history' | 'lender-sync' | 'summary';

/** Downloaded CSVs and the import report live here (git-ignored). */
export const DATA_DIR = path.resolve('data');
export const SHEET_DIR = path.join(DATA_DIR, 'sheet');

export function tabPath(tab: TabKey): string {
  return path.join(SHEET_DIR, `${tab}.csv`);
}
