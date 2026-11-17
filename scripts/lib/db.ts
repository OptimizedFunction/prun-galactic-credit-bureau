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

/** Run statements in transactional chunks. */
export async function runBatched(db: D1Database, statements: D1PreparedStatement[], chunkSize = 200): Promise<void> {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}
