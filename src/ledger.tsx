// The editable ledger (spreadsheet-style) and the public list of recent changes.
import { Hono } from 'hono';
import ledgerScript from '../assets/ledger.client.js';
import { currentUser } from './auth';
import { isAdmin, listBlocks } from './db/admin';
import * as q from './db/queries';
import { Layout } from './pages';
import { FIELD_LABELS, showValue } from './lib/changeText';
import { STATUS_LABELS, type Status } from './lib/normalize';
import type { Env } from './env';

export const ledgerPages = new Hono<{ Bindings: Env }>();

const LEDGER_CSS = `
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin: 12px 0; }
.toolbar input[type=search] { flex: 1; min-width: 220px; padding: 8px 10px; font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.hint { color: var(--muted); font-size: 13px; margin: -8px 0 16px; }
.phone-only { display: none; }
@media (max-width: 760px) { .phone-only { display: block; margin: 0 0 12px; } .desk-only { display: none; } .ledger-scroll { max-height: none; } #ledger td { padding: 3px 12px; } }
#ledger-msg { min-height: 1.5em; font-weight: 600; }
#ledger-toast { position: fixed; z-index: 30; display: flex; align-items: center; gap: 12px; max-width: min(460px, calc(100vw - 16px)); padding: 8px 12px; color: var(--bg); background: var(--text); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, .35); font-size: 14px; }
#ledger-toast[hidden] { display: none; }
#ledger-toast.err { color: #fff; background: #b3261e; }
#ledger-toast button { flex: none; padding: 3px 10px; color: inherit; background: none; border: 1px solid currentColor; border-radius: 6px; font: inherit; font-weight: 600; cursor: pointer; }
#ledger td[tabindex]:focus { background: color-mix(in srgb, var(--link) 12%, transparent); }
#ledger-msg.ok { color: var(--good); } #ledger-msg.err { color: var(--bad); }
#ledger th { position: sticky; top: 0; background: var(--panel); z-index: 1; padding: 0; }
#ledger th button { width: 100%; padding: 8px 12px; font: inherit; font-weight: 600; font-size: 13px; color: var(--muted); background: none; border: 0; text-align: inherit; cursor: pointer; }
#ledger th[aria-sort=ascending] button::after { content: " ▲"; } #ledger th[aria-sort=descending] button::after { content: " ▼"; }
#ledger td { padding: 5px 12px; }
#ledger td[tabindex] { cursor: cell; }
#ledger td[tabindex]:hover, #ledger td[tabindex]:focus { outline: 2px solid var(--link); outline-offset: -2px; }
#ledger td.locked, #ledger td.readonly { color: var(--muted); }
#ledger td.tr-fio_verified { color: var(--good); }
#ledger tr td { transition: background-color 1.5s; }
#ledger tr.flash td { background-color: color-mix(in srgb, var(--link) 22%, transparent); transition: none; }
#ledger td input:not([type=checkbox]), #ledger td select { width: 100%; min-width: 90px; padding: 3px 6px; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--link); border-radius: 4px; }
#ledger td.wrap { min-width: 260px; }
#ledger td.st-breached { color: var(--bad); font-weight: 600; } #ledger td.st-complete { color: var(--good); } #ledger td.st-overdue, #ledger td.st-stale { color: var(--warn); }
.row-actions button, .undo { padding: 2px 8px; font: inherit; font-size: 13px; color: var(--bad); background: none; border: 1px solid var(--line); border-radius: 4px; cursor: pointer; }
.undo { color: var(--link); }
form.filters { display: flex; flex-wrap: wrap; align-items: end; gap: 10px 14px; margin: 0 0 16px; }
form.filters label { display: grid; gap: 2px; color: var(--muted); font-size: 13px; }
form.filters input { min-width: 200px; padding: 7px 9px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; font: inherit; }
form.filters button { padding: 8px 14px; color: #fff; background: #1558b0; border: 0; border-radius: 6px; font: inherit; font-weight: 600; cursor: pointer; }
details.panel.admin { margin: 0 0 16px; border-left: 4px solid #f2b84b; }
details.panel.admin p { margin: 0 0 12px; }
form.filters select { min-width: 220px; padding: 7px 9px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; font: inherit; }
form.filters button.danger { background: #b3261e; }
ul.blocks { margin: 6px 0 0; padding-left: 20px; }
details.columns { position: relative; }
details.columns summary { padding: 7px 12px; color: var(--link); border: 1px solid var(--line); border-radius: 6px; font-size: 14px; cursor: pointer; list-style: none; user-select: none; }
details.columns summary::-webkit-details-marker { display: none; }
details.columns .picker { position: absolute; right: 0; top: calc(100% + 6px); z-index: 5; display: grid; gap: 4px; min-width: 170px; padding: 10px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, .25); }
details.columns label { display: flex; align-items: center; gap: 8px; font-size: 14px; white-space: nowrap; }
.ledger-scroll { max-height: calc(100vh - 120px); overflow: auto; }
form.add { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; align-items: end; }
form.add label { display: grid; gap: 2px; font-size: 13px; color: var(--muted); }
form.add input, form.add select { padding: 7px 8px; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
form.add button { padding: 8px 14px; font: inherit; font-weight: 600; color: #fff; background: #1558b0; border: 0; border-radius: 6px; cursor: pointer; }
details.panel summary { cursor: pointer; font-weight: 600; }
details.panel[open] summary { margin-bottom: 12px; }
`;

ledgerPages.get('/ledger.js', (c) => c.body(ledgerScript, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }));

/** Loans sent with the page itself. The browser fetches older ones in the background, so the page opens quickly. */
const FIRST_ROWS = 200;

ledgerPages.get('/ledger', async (c) => {
  // Taken before the query, so the first background refresh picks up anything written while the page was loading.
  const cursor = new Date().toISOString();
  const [user, { loans, total }] = await Promise.all([currentUser(c), q.listLoans(c.env.DB, { limit: FIRST_ROWS, offset: 0 })]);
  const data = {
    user,
    cursor,
    total,
    loans: loans.map((l) => ({
      id: l.id,
      lender: l.lender,
      borrower: l.borrower.username,
      companyCode: l.borrower.companyCode,
      corpCode: l.borrower.corpCode,
      principal: l.principal,
      currency: l.currency,
      issuedOn: l.issuedOn,
      durationWeeks: l.durationWeeks,
      status: l.status,
      contractId: l.contractId,
      autoTrack: l.autoTrack,
      notes: l.notes,
      trust: l.trust,
    })),
  };
  // "<" is escaped so loan text can never close the script element.
  const embedded = JSON.stringify(data).replace(/</g, '\\u003c');
  c.header('Cache-Control', 'no-store');

  return c.html(
    <Layout title="Ledger" wide>
      <style dangerouslySetInnerHTML={{ __html: LEDGER_CSS }} />
      <h1>Ledger</h1>
      <p class="sub">
        Every loan on record, in one table.{' '}
        {user ? (
          <>
            Click any cell to edit it. Each change is saved at once and listed in <a href="/changes">Recent changes</a>.
          </>
        ) : (
          <>
            <a href="/auth/login?return=/ledger">Sign in with Discord</a> to edit.
          </>
        )}
      </p>
      <p class="hint">
        {user && <>Enter saves, Esc cancels, Tab moves to the next cell; arrow keys move between cells. </>}
        Loans with Auto track ticked follow FIO, so only their notes can be edited. Trust is assigned by the bureau (see{' '}
        <a href="/about">About</a>). Other people's changes appear within half a minute.
      </p>
      {user && (
        <details class="panel desk-only">
          <summary>Add a loan</summary>
          <form class="add" id="ledger-add">
            <label>
              Lender
              <input name="lender" required maxlength={64} list="names-lender" autocomplete="off" />
            </label>
            <label>
              Borrower
              <input name="borrower" required maxlength={64} list="names-borrower" autocomplete="off" />
            </label>
            <label>
              CO
              <input name="companyCode" maxlength={8} />
            </label>
            <label>
              CORP
              <input name="corpCode" maxlength={8} />
            </label>
            <label>
              Amount
              <input name="principal" required inputmode="decimal" placeholder="25,000,000" />
            </label>
            <label>
              Currency
              <select name="currency">
                <option>AIC</option>
                <option>CIS</option>
                <option>ICA</option>
                <option>NCC</option>
                <option value="">N/A</option>
              </select>
            </label>
            <label>
              Issued
              <input name="issuedOn" type="date" required />
            </label>
            <label>
              Weeks
              <input name="durationWeeks" inputmode="decimal" />
            </label>
            <label>
              Status
              <select name="status">
                {(Object.keys(STATUS_LABELS) as Status[]).map((s) => (
                  <option value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>
            </label>
            <label>
              Contract ID
              <input name="contractId" maxlength={16} />
            </label>
            <label>
              Notes
              <input name="notes" maxlength={2000} />
            </label>
            <button type="submit">Add loan</button>
          </form>
        </details>
      )}
      {user && <p class="hint phone-only">Editing is switched off on small screens, so a stray tap cannot change a loan. Use a wider screen to edit.</p>}
      <datalist id="names-lender"></datalist>
      <datalist id="names-borrower"></datalist>
      <div id="ledger-toast" role="status" aria-live="polite" hidden></div>
      <div class="toolbar">
        <input type="search" id="ledger-filter" placeholder="Filter: any text, e.g. a username, contract ID or status" aria-label="Filter loans" />
        <span id="ledger-count" class="muted"></span>
        <details class="columns" id="ledger-columns">
          <summary>Columns</summary>
          <div class="picker"></div>
        </details>
        <span id="ledger-msg" role="status"></span>
      </div>
      <div class="scroll ledger-scroll">
        <table id="ledger" class="stack">
          <thead>
            <tr></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <noscript>
        <p>The ledger needs JavaScript. Without it, use the borrower and lender pages.</p>
      </noscript>
      <script type="application/json" id="ledger-data" dangerouslySetInnerHTML={{ __html: embedded }} />
      <script src="/ledger.js" defer></script>
    </Layout>,
  );
});

const show = showValue;

/** The request that reverses a change, or null if it cannot be undone from here. */
function undoRequest(change: q.Change): { method: string; url: string; body?: unknown } | null {
  if (change.actorType === 'system') return null;
  const url = `/api/v1/loans/${change.loanId}`;
  const before = (change.before ?? {}) as Record<string, unknown>;
  if (change.action === 'delete') return change.loanDeleted ? { method: 'POST', url: `${url}/restore` } : null;
  if (change.loanDeleted) return null;
  if (change.action === 'create') return change.loanTracked ? null : { method: 'DELETE', url };
  if (change.action === 'update') {
    if ('deleted' in before) return change.loanTracked ? null : { method: 'DELETE', url };
    // Only undo if the fields still hold what this change set them to; otherwise someone has edited them since.
    return { method: 'PATCH', url, body: { ...before, expected: change.after } };
  }
  return null;
}

const ADMIN_SCRIPT = `
(() => {
  const form = document.getElementById('admin-form');
  const msg = document.getElementById('admin-msg');
  const say = (text, bad) => { msg.textContent = text; msg.style.color = bad ? 'var(--bad)' : 'var(--good)'; };
  async function call(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message ?? 'Request failed (' + res.status + ').');
    return data;
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const what = e.submitter.dataset.do;
    const actorId = form.actorId.value;
    const name = form.actorId.selectedOptions[0].textContent.trim();
    const reason = form.reason.value.trim();
    if (!actorId) return;
    try {
      if (what === 'block') {
        if (!confirm('Block ' + name + ' from making any changes?')) return;
        await call('POST', '/api/v1/admin/blocks', { actorId, name: name.replace(/ \\(.*$/, ''), reason });
        location.reload();
        return;
      }
      const since = new Date(form.since.value + 'Z').toISOString();
      if (!confirm('Roll back everything ' + name + ' changed since ' + since + '?')) return;
      const r = await call('POST', '/api/v1/admin/rollback', { actorId, since, reason });
      say('Rolled back ' + r.loans + ' loan(s): ' + r.removed + ' removed, ' + r.restored + ' restored, ' + r.reverted + ' reverted.' + (r.skipped.length ? ' Left alone (changed by others since): ' + r.skipped.join('; ') + '.' : ''));
    } catch (err) {
      say(err.message, true);
    }
  });
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-unblock]');
    if (!btn) return;
    try {
      await call('DELETE', '/api/v1/admin/blocks/' + encodeURIComponent(btn.dataset.unblock));
      location.reload();
    } catch (err) {
      say(err.message, true);
    }
  });
})();`;

const UNDO_SCRIPT = `
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.undo');
  if (!btn) return;
  const req = JSON.parse(btn.dataset.req);
  btn.disabled = true;
  const res = await fetch(req.url, { method: req.method, headers: req.body ? { 'Content-Type': 'application/json' } : {}, body: req.body ? JSON.stringify(req.body) : undefined }).catch(() => null);
  if (res && res.ok) return location.reload();
  const data = res ? await res.json().catch(() => ({})) : {};
  alert(data.error?.message ?? 'Could not undo this change.');
  btn.disabled = false;
});`;

ledgerPages.get('/changes', async (c) => {
  const includeSystem = c.req.query('system') === '1';
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const size = 100;
  const actor = (c.req.query('by') ?? '').trim() || undefined;
  const loan = (c.req.query('loan') ?? '').trim() || undefined;
  const [user, changes] = await Promise.all([
    currentUser(c),
    q.listChanges(c.env.DB, { includeSystem, actor, loan, limit: size + 1, offset: (page - 1) * size }),
  ]);
  const maintainer = user !== null && isAdmin(c.env.ADMIN_DISCORD_IDS, user.id);
  const blocks = maintainer ? await listBlocks(c.env.DB) : [];
  // The accounts behind the changes on this page, for the maintainer tools: one name can hide several accounts.
  const accounts = [...new Map(changes.filter((ch) => ch.actorType !== 'system' && ch.actorId).map((ch) => [ch.actorId!, ch.actor])).entries()];
  const more = changes.length > size;
  const query = (extra: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ by: actor, loan, system: includeSystem ? 1 : undefined, ...extra })) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const text = params.toString();
    return text ? `/changes?${text}` : '/changes';
  };
  const link = (p: number) => query({ page: p });
  const filtered = Boolean(actor || loan);
  c.header('Cache-Control', 'no-store');

  return c.html(
    <Layout title="Recent changes">
      <style dangerouslySetInnerHTML={{ __html: LEDGER_CSS }} />
      <h1>Recent changes</h1>
      <p class="sub">
        A public record of every edit, newest first.{' '}
        {!filtered && (includeSystem ? <a href={query({ system: undefined })}>Hide automatic changes</a> : <a href={query({ system: 1 })}>Show the FIO sync's automatic changes too</a>)}
        {!filtered && '.'}
        {!user && (
          <>
            {' '}
            <a href="/auth/login?return=/changes">Sign in with Discord</a> to undo a change.
          </>
        )}
      </p>
      {maintainer && (
        <details class="panel admin" open={filtered}>
          <summary>Maintainer tools</summary>
          <p class="muted">
            Roll back undoes everything an account changed since the time given: loans it added are deleted, loans it deleted come back, and fields it
            changed return to what they held before. Anything someone else has changed since is left alone.
          </p>
          <form class="filters" id="admin-form">
            <label>
              Account
              <select name="actorId" required>
                {accounts.length === 0 && <option value="">No accounts on this page</option>}
                {accounts.map(([id, name]) => (
                  <option value={id}>
                    {name} ({id})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Since (UTC)
              <input name="since" type="datetime-local" required value={new Date(Date.now() - 86_400_000).toISOString().slice(0, 16)} />
            </label>
            <label>
              Reason
              <input name="reason" maxlength={300} placeholder="Shown in each loan's history" />
            </label>
            <button type="submit" data-do="rollback">
              Roll back
            </button>
            <button type="submit" data-do="block" class="danger">
              Block account
            </button>
          </form>
          <p id="admin-msg" role="status"></p>
          {blocks.length > 0 && (
            <>
              <strong>Blocked accounts</strong>
              <ul class="blocks">
                {blocks.map((b) => (
                  <li>
                    {b.name ?? 'Unknown'} <span class="muted">({b.actorId})</span> · blocked {b.blockedAt.slice(0, 10)} by {b.blockedBy}
                    {b.reason && <> · {b.reason}</>}{' '}
                    <button type="button" class="undo" data-unblock={b.actorId}>
                      Unblock
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}
      <form class="filters" method="get" action="/changes">
        <label>
          By
          <input name="by" value={actor ?? ''} placeholder="Discord username" maxlength={64} />
        </label>
        <label>
          Loan
          <input name="loan" value={loan ?? ''} placeholder="Contract ID or loan number" maxlength={32} />
        </label>
        <button type="submit">Filter</button>
        {filtered && <a href="/changes">Clear</a>}
      </form>
      {changes.length === 0 ? (
        <p class="muted">{filtered ? 'No changes match.' : 'No changes yet.'}</p>
      ) : (
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>When (UTC)</th>
                <th>Who</th>
                <th>Loan</th>
                <th>Change</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {changes.slice(0, size).map((ch) => {
                const before = (ch.before ?? {}) as Record<string, unknown>;
                const after = (ch.after ?? {}) as Record<string, unknown>;
                const undo = user ? undoRequest(ch) : null;
                return (
                  <tr>
                    <td>
                      {ch.createdAt.slice(0, 10)} {ch.createdAt.slice(11, 16)}
                    </td>
                    <td>
                      <a class={ch.actorType === 'system' ? 'muted' : undefined} href={`/changes?by=${encodeURIComponent(ch.actor)}`} title="Show only this one's changes">
                        {ch.actor}
                      </a>
                    </td>
                    <td>
                      <a href={`/loans/${ch.loanId}`}>
                        {ch.lender} → {ch.borrower}
                      </a>
                      {ch.contractId && <span class="muted"> {ch.contractId}</span>}
                      {ch.loanDeleted && <span class="badge bad" style="margin-left:6px">deleted</span>}
                    </td>
                    <td class="wrap">
                      {ch.action === 'create' && (
                        <>
                          Added: {show('principal', after['principal'])} {show('currency', after['currency'])}, {show('status', after['status'])}
                        </>
                      )}
                      {ch.action === 'delete' && <>Deleted the loan</>}
                      {ch.action === 'update' &&
                        ('deleted' in after ? (
                          <>Restored the loan</>
                        ) : (
                          Object.keys(after)
                            .filter((field) => field !== 'reason')
                            .map((field) => (
                              <div>
                                {FIELD_LABELS[field] ?? field}: {show(field, before[field])} → <strong>{show(field, after[field])}</strong>
                              </div>
                            ))
                        ))}
                      {typeof after['reason'] === 'string' && <div class="muted">{after['reason']}</div>}
                    </td>
                    <td>
                      {undo && (
                        <button type="button" class="undo" data-req={JSON.stringify(undo)}>
                          {undo.method === 'POST' ? 'Restore' : 'Undo'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p>
        {page > 1 && <a href={link(page - 1)}>← Newer</a>} {more && <a href={link(page + 1)}>Older →</a>}
      </p>
      <script dangerouslySetInnerHTML={{ __html: UNDO_SCRIPT }} />
      {maintainer && <script dangerouslySetInnerHTML={{ __html: ADMIN_SCRIPT }} />}
    </Layout>,
  );
});
