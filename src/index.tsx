import { Hono } from 'hono';
import { api } from './api';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

app.route('/api/v1', api);

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404));

export default app;
