import { Hono } from 'hono';
import { api } from './api';
import { apiDocs } from './apidocs';
import { auth } from './auth';
import { ledgerPages } from './ledger';
import { mePages } from './me';
import { trackPages } from './track';
import { notFoundPage, pages } from './pages';
import { pruneBuckets } from './lib/rateLimit';
import { runSync } from './sync/run';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

app.route('/api/v1', api);
app.route('/auth', auth);
app.route('/', apiDocs);
app.route('/', ledgerPages);
app.route('/', trackPages);
app.route('/', mePages);
app.route('/', pages);

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404);
  }
  return c.html(notFoundPage(), 404);
});

export default {
  fetch: app.fetch,

  /** Cron trigger (see wrangler.jsonc): housekeeping, then pull every tracked lender's loans from FIO. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await pruneBuckets(env.DB).catch((err) => console.error('Pruning rate-limit buckets failed', err));
    if (!env.FIO_KEY_SECRET) {
      console.warn('FIO sync skipped: FIO_KEY_SECRET is not set.');
      return;
    }
    const graceDays = env.STALE_GRACE_DAYS ? Number(env.STALE_GRACE_DAYS) : undefined;
    const summary = await runSync(env.DB, { keySecret: env.FIO_KEY_SECRET }, { graceDays });
    console.log('FIO sync finished', JSON.stringify(summary));
  },
} satisfies ExportedHandler<Env>;
