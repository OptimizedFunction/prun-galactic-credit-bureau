// Discord sign-in. The session is a signed cookie; there is no session table.
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from './env';

export interface SessionUser {
  /** Discord user ID. */
  id: string;
  /** Discord username. */
  name: string;
}

const SESSION_COOKIE = 'session';
const STATE_COOKIE = 'oauth_state';
const RETURN_COOKIE = 'oauth_return';
const SESSION_DAYS = 30;

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text: string): Uint8Array => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

/** The signing key is derived from the Discord client secret, so no extra secret has to be managed. */
async function signingKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`bureau-session-v1:${secret}`));
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(user: SessionUser, secret: string, now = Date.now()): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify({ id: user.id, name: user.name, exp: now + SESSION_DAYS * 86_400_000 })));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload));
  return `${payload}.${b64url(new Uint8Array(signature))}`;
}

export async function readSession(cookie: string | undefined, secret: string, now = Date.now()): Promise<SessionUser | null> {
  if (!cookie) return null;
  const [payload, signature, extra] = cookie.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const valid = await crypto.subtle.verify('HMAC', await signingKey(secret), fromB64url(signature), encoder.encode(payload));
    if (!valid) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { id?: unknown; name?: unknown; exp?: unknown };
    if (typeof data.id !== 'string' || typeof data.name !== 'string' || typeof data.exp !== 'number' || data.exp < now) return null;
    return { id: data.id, name: data.name };
  } catch {
    return null;
  }
}

type Ctx = Context<{ Bindings: Env }>;

/** The signed-in user for this request, or null. */
export async function currentUser(c: Ctx): Promise<SessionUser | null> {
  const secret = c.env.DISCORD_CLIENT_SECRET;
  return secret ? readSession(getCookie(c, SESSION_COOKIE), secret) : null;
}

/** Only same-site relative paths are accepted as a place to return to after sign-in. */
const safeReturn = (path: string | undefined): string => (path && /^\/(?![/\\])/.test(path) ? path : '/');

export const auth = new Hono<{ Bindings: Env }>();

auth.get('/login', (c) => {
  if (!c.env.DISCORD_CLIENT_ID || !c.env.DISCORD_CLIENT_SECRET) return c.text('Sign-in is not configured on this server.', 503);
  const url = new URL(c.req.url);
  const secure = url.protocol === 'https:';
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const cookie = { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: 600 } as const;
  setCookie(c, STATE_COOKIE, state, cookie);
  setCookie(c, RETURN_COOKIE, safeReturn(c.req.query('return')), cookie);

  const authorize = new URL('https://discord.com/oauth2/authorize');
  authorize.search = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    response_type: 'code',
    scope: 'identify',
    redirect_uri: `${url.origin}/auth/callback`,
    state,
  }).toString();
  return c.redirect(authorize.toString());
});

auth.get('/callback', async (c) => {
  const { DISCORD_CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: clientSecret } = c.env;
  if (!clientId || !clientSecret) return c.text('Sign-in is not configured on this server.', 503);
  const url = new URL(c.req.url);
  const expected = getCookie(c, STATE_COOKIE);
  const returnTo = safeReturn(getCookie(c, RETURN_COOKIE));
  deleteCookie(c, STATE_COOKIE, { path: '/' });
  deleteCookie(c, RETURN_COOKIE, { path: '/' });

  const code = c.req.query('code');
  if (!code || !expected || c.req.query('state') !== expected) return c.text('Sign-in was cancelled or expired. Go back and try again.', 400);

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  if (!tokenRes.ok) {
    console.error('Discord token exchange failed', tokenRes.status, await tokenRes.text());
    return c.text('Discord did not accept the sign-in. Try again.', 502);
  }
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token?: string };
  const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
  const me = (await meRes.json()) as { id?: string; username?: string };
  if (!meRes.ok || !me.id || !me.username) return c.text('Could not read your Discord account. Try again.', 502);

  setCookie(c, SESSION_COOKIE, await signSession({ id: me.id, name: me.username }, clientSecret), {
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
  return c.redirect(returnTo);
});

auth.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

auth.get('/me', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ user: await currentUser(c), signInAvailable: Boolean(c.env.DISCORD_CLIENT_ID && c.env.DISCORD_CLIENT_SECRET) });
});
