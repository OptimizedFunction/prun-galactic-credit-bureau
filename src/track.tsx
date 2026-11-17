// "Track my loans": a lender connects their own FIO API key so the sync can read their loan contracts.
import { Hono } from 'hono';
import { currentUser } from './auth';
import { listConnectedBy } from './db/lenderKeys';
import { getSyncHealth } from './db/queries';
import { Layout } from './pages';
import type { Env } from './env';

export const trackPages = new Hono<{ Bindings: Env }>();

const TRACK_CSS = `
ol.steps { padding-left: 20px; margin: 0 0 16px; }
ol.steps li { margin-bottom: 6px; }
form.track { display: grid; gap: 12px; max-width: 520px; }
form.track label { display: grid; gap: 4px; font-weight: 600; }
form.track input { padding: 9px 10px; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
form.track button, button.plain { justify-self: start; padding: 9px 16px; font: inherit; font-weight: 600; color: #fff; background: #1558b0; border: 0; border-radius: 6px; cursor: pointer; }
button.plain { color: var(--bad); background: none; border: 1px solid var(--line); font-weight: 400; padding: 4px 10px; }
.apikey { margin-top: 4px; font-size: 14px; }
button.plain.link { color: var(--link); }
.keybox { display: grid; gap: 8px; justify-items: start; margin: 12px 0; padding: 12px 14px; border: 1px solid #f2b84b; border-radius: 8px; }
.keybox[hidden] { display: none; }
.keybox code { padding: 6px 8px; background: var(--chip); border-radius: 4px; overflow-wrap: anywhere; user-select: all; }
#track-msg { min-height: 1.5em; font-weight: 600; }
#track-msg.ok { color: var(--good); } #track-msg.err { color: var(--bad); }
ul.plainlist { margin: 0; padding-left: 20px; }
ul.plainlist li { margin-bottom: 6px; }
`;

const TRACK_SCRIPT = `
(() => {
  const msg = document.getElementById('track-msg');
  const say = (text, isError) => { msg.textContent = text; msg.className = isError ? 'err' : 'ok'; };
  async function call(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message ?? 'Request failed (' + res.status + ').');
    return data;
  }
  const form = document.getElementById('track-form');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    say('Checking the key with FIO…');
    try {
      const data = await call('POST', '/api/v1/fio-keys', { apiKey: form.apiKey.value.trim() });
      form.reset();
      say('Connected ' + data.lender.username + '. FIO has ' + data.loansFound + ' loan' + (data.loansFound === 1 ? '' : 's') + ' you paid out; taking you to My lending…');
      setTimeout(() => (location.href = '/my-lending'), 3500);
    } catch (err) {
      say(err.message, true);
    } finally {
      button.disabled = false;
    }
  });
  document.addEventListener('click', async (e) => {
    const create = e.target.closest('button[data-key-create]');
    if (create) {
      if (create.dataset.replace && !confirm('Replace the API key for ' + create.dataset.keyCreate + '? The current key stops working at once.')) return;
      try {
        const data = await call('POST', '/api/v1/lender-keys', { username: create.dataset.keyCreate });
        document.getElementById('key-value').textContent = data.apiKey;
        document.getElementById('key-once').hidden = false;
        say('API key created for ' + data.username + '.');
      } catch (err) {
        say(err.message, true);
      }
      return;
    }
    const revoke = e.target.closest('button[data-key-revoke]');
    if (revoke) {
      if (!confirm('Revoke the API key for ' + revoke.dataset.keyRevoke + '? Anything using it will stop working.')) return;
      try {
        await call('DELETE', '/api/v1/lender-keys/' + encodeURIComponent(revoke.dataset.keyRevoke));
        location.reload();
      } catch (err) {
        say(err.message, true);
      }
      return;
    }
    if (e.target.id === 'key-copy' && navigator.clipboard) {
      navigator.clipboard.writeText(document.getElementById('key-value').textContent).then(() => say('Key copied.'));
      return;
    }
    const btn = e.target.closest('button[data-disconnect]');
    if (!btn) return;
    if (!confirm('Disconnect ' + btn.dataset.disconnect + '? The stored FIO key and any reporting API key are deleted, and automatic tracking stops. Loans already recorded stay.')) return;
    try {
      await call('DELETE', '/api/v1/fio-keys/' + encodeURIComponent(btn.dataset.disconnect));
      location.reload();
    } catch (err) {
      say(err.message, true);
    }
  });
})();`;

trackPages.get('/track', async (c) => {
  const user = await currentUser(c);
  const available = Boolean(c.env.FIO_KEY_SECRET);
  const connected = user ? await listConnectedBy(c.env.DB, user.id) : [];
  const health = connected.length > 0 ? await getSyncHealth(c.env.DB) : [];
  const syncOf = (username: string) => health.find((h) => h.lender.toLowerCase() === username.toLowerCase());
  c.header('Cache-Control', 'no-store');

  return c.html(
    <Layout title="Track my loans">
      <style dangerouslySetInnerHTML={{ __html: TRACK_CSS }} />
      <h1>Track my loans</h1>
      <p class="sub">Connect your FIO account once and the bureau keeps your lending up to date by itself, every hour.</p>

      <div class="panel">
        <ol class="steps">
          <li>
            In <a href="https://fio.fnar.net/settings">FIO</a>, open Settings and create an API key. Name it something like “Credit Bureau”.
          </li>
          <li>Paste it below. There is nothing else to fill in.</li>
          <li>The bureau asks FIO whose key it is, then starts reading that account's loan contracts.</li>
        </ol>
        {!available ? (
          <p class="muted">Connecting a key is not set up on this server yet.</p>
        ) : !user ? (
          <p>
            <a href="/auth/login?return=/track">Sign in with Discord</a> to connect a key.
          </p>
        ) : (
          <form class="track" id="track-form" autocomplete="off">
            <label>
              FIO API key
              <input name="apiKey" type="password" required maxlength={200} autocomplete="off" />
            </label>
            <button type="submit">Connect</button>
          </form>
        )}
        <p id="track-msg" role="status"></p>
      </div>

      {connected.length > 0 && (
        <>
          <h2>Connected by you</h2>
          <div class="panel">
            <ul class="plainlist">
              {connected.map((l) => {
                const sync = syncOf(l.username);
                return (
                  <li>
                    <a href={`/lenders/${encodeURIComponent(l.username)}`}>{l.username}</a> <span class="muted">since {l.connectedAt.slice(0, 10)}</span>{' '}
                    {!sync ? (
                      <span class="badge neutral">First sync on its way</span>
                    ) : sync.ok ? (
                      <span class="badge good">Key working</span>
                    ) : (
                      <span class="badge bad">{sync.error ?? 'Sync failing'}</span>
                    )}{' '}
                    <button type="button" class="plain" data-disconnect={l.username}>
                      Disconnect
                    </button>
                    {sync && !sync.ok && <div class="muted">Paste a new key above to reconnect. Your recorded loans stay as they are meanwhile.</div>}
                    <div class="apikey">
                      Reporting API key:{' '}
                      {l.apiKeyPrefix ? (
                        <>
                          <code>{l.apiKeyPrefix}…</code> <span class="muted">created {l.apiKeyCreatedAt?.slice(0, 10)}</span>{' '}
                          <button type="button" class="plain link" data-key-create={l.username} data-replace="1">
                            Replace
                          </button>{' '}
                          <button type="button" class="plain" data-key-revoke={l.username}>
                            Revoke
                          </button>
                        </>
                      ) : (
                        <>
                          <span class="muted">none</span>{' '}
                          <button type="button" class="plain link" data-key-create={l.username}>
                            Create
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div id="key-once" class="keybox" hidden>
              <strong>Your new API key. Copy it now; it is not shown again.</strong>
              <code id="key-value"></code>
              <button type="button" class="plain link" id="key-copy">
                Copy
              </button>
            </div>
            <p class="muted">
              A reporting key lets your own tools record loans the game cannot see, such as advances or sponsored bases, through the{' '}
              <a href="/api">API</a>. Loans already tracked from FIO do not need it.
            </p>
            <p>
              <a href="/my-lending">Go to My lending</a>
            </p>
          </div>
        </>
      )}

      <h2>What the bureau does with your key</h2>
      <div class="panel">
        <ul class="plainlist">
          <li>
            It reads your loan contracts and records only the loans <strong>you paid out</strong>. Loans you received are reported by their lenders.
          </li>
          <li>The key is stored encrypted and is never shown again, to you or anyone else.</li>
          <li>
            A FIO key can read everything in your FIO account, not just loans. The bureau only ever requests loan contracts, but you are trusting it
            with the key. The code is open for anyone to check.
          </li>
          <li>You can disconnect here at any time, which deletes the key. Revoking the key in FIO cuts access immediately as well.</li>
          <li>Loans recorded from FIO are marked FIO-verified and cannot be edited by hand, apart from their notes.</li>
        </ul>
      </div>
      <script dangerouslySetInnerHTML={{ __html: TRACK_SCRIPT }} />
    </Layout>,
  );
});
