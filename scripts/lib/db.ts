import { getPlatformProxy } from 'wrangler';

/** Opens the same local D1 database that `wrangler dev` uses. Call dispose() when done. */
export async function openLocalDb(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>();
  return { db: proxy.env.DB, dispose: proxy.dispose };
}

/** Run statements in transactional chunks. */
export async function runBatched(db: D1Database, statements: D1PreparedStatement[], chunkSize = 200): Promise<void> {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}
