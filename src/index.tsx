import { Hono } from 'hono';
import { api } from './api';
import { notFoundPage, pages } from './pages';
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

export default app;
