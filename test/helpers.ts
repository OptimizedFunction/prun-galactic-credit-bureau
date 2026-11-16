import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPlatformProxy } from 'wrangler';

/** A fresh, empty D1 database with every migration applied. Call dispose() when done. */
export async function tempDatabase(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-test-'));
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: dir } });
  const db = proxy.env.DB;
  for (const file of fs.readdirSync('migrations').sort()) {
    const statements = fs
      .readFileSync(path.join('migrations', file), 'utf8')
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch(statements.map((s) => db.prepare(s)));
  }
  return {
    db,
    dispose: async () => {
      await proxy.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
