import fs from 'node:fs';
import { getPlatformProxy } from 'wrangler';

/**
 * Opens the same local D1 database that `wrangler dev` uses. Call dispose() when done.
 * Set D1_PERSIST to a folder to use a separate local database there instead (the same folder as
 * wrangler's --persist-to), for example to build a clean seed without touching the dev data.
 */
export async function openLocalDb(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const dir = process.env.D1_PERSIST;
  const proxy = await getPlatformProxy<{ DB: D1Database }>(dir ? { persist: { path: `${dir}/v3` } } : {});
  return { db: proxy.env.DB, dispose: proxy.dispose };
}

/**
 * Opens the PRODUCTION database on Cloudflare, through the account `wrangler login` signed in to.
 * Everything run on it is real. Call dispose() when done.
 */
export async function openRemoteDb(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  // The binding is marked remote in a throwaway copy of the config, so `wrangler dev` stays on local data.
  const config = '.wrangler/remote.jsonc';
  const text = fs.readFileSync('wrangler.jsonc', 'utf8');
  if (!text.includes('"binding": "DB",')) throw new Error('wrangler.jsonc: the DB binding was not found');
  fs.mkdirSync('.wrangler', { recursive: true });
  fs.writeFileSync(config, text.replace('"binding": "DB",', '"binding": "DB", "remote": true,'));
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: config, persist: false });
  return { db: proxy.env.DB, dispose: proxy.dispose };
}

/** Run statements in transactional chunks. */
export async function runBatched(db: D1Database, statements: D1PreparedStatement[], chunkSize = 200): Promise<void> {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}
