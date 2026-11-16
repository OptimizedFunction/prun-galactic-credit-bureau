import { Hono } from 'hono';
import { api } from './api';
import { notFoundPage, pages } from './pages';
import { runSync } from './sync/run';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

app.route('/api/v1', api);
app.route('/', pages);

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404);
  }
  return c.html(notFoundPage(), 404);
});

export default {
  fetch: app.fetch,

  /** Cron trigger (see wrangler.jsonc): pull every tracked lender's loans from FIO. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (!env.FIO_API_KEY) {
      console.warn('FIO sync skipped: FIO_API_KEY is not set.');
      return;
    }
    const graceDays = env.STALE_GRACE_DAYS ? Number(env.STALE_GRACE_DAYS) : undefined;
    const summary = await runSync(env.DB, env.FIO_API_KEY, { graceDays });
    console.log('FIO sync finished', JSON.stringify(summary));
  },
} satisfies ExportedHandler<Env>;
