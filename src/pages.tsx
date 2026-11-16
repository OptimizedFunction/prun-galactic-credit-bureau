// Server-rendered public pages. No client-side framework; plain HTML and one stylesheet.
import { Hono } from 'hono';
import { html } from 'hono/html';
import type { Child } from 'hono/jsx';
import logoSvg from '../assets/logo.svg';
import * as q from './db/queries';
import { formatMinor, STATUS_LABELS, type Status } from './lib/normalize';
import type { Env } from './env';

export const pages = new Hono<{ Bindings: Env }>();

const CSS = `
:root {
  --bg: #f6f7f9; --panel: #fff; --text: #1b1f24; --muted: #5f6b7a; --line: #dfe3e8; --link: #1558b0;
  --good: #1a7f37; --warn: #9a6700; --bad: #c62828; --neutral: #57606a; --chip: #eef1f4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --panel: #171b21; --text: #e6e9ed; --muted: #98a2ae; --line: #2a3038; --link: #6cb0ff;
    --good: #4cc26a; --warn: #e0a63a; --bad: #ff6b6b; --neutral: #9aa4af; --chip: #222830;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
header.site { background: var(--panel); border-bottom: 1px solid var(--line); }
header.site .inner, main, footer { max-width: 1100px; margin: 0 auto; padding: 0 16px; }
header.site .inner { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; padding-top: 12px; padding-bottom: 12px; }
header.site .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; color: var(--text); margin-right: auto; }
header.site nav { display: flex; flex-wrap: wrap; gap: 16px; }
main { padding-top: 24px; padding-bottom: 40px; }
footer { color: var(--muted); font-size: 13px; padding-bottom: 32px; }
h1 { font-size: 26px; margin: 0 0 4px; overflow-wrap: anywhere; }
h2 { font-size: 18px; margin: 32px 0 10px; }
p.sub { color: var(--muted); margin: 0 0 16px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
form.search { display: flex; gap: 8px; margin: 16px 0; }
form.search input { flex: 1; min-width: 0; padding: 10px 12px; font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
form.search button { padding: 10px 18px; font: inherit; font-weight: 600; color: #fff; background: #1558b0; border: 0; border-radius: 6px; cursor: pointer; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.card .cur { font-weight: 700; font-size: 13px; color: var(--muted); letter-spacing: .04em; }
.card .big { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
.card dl { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; margin: 8px 0 0; font-size: 14px; }
.card dt { color: var(--muted); }
.card dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
th { color: var(--muted); font-weight: 600; font-size: 13px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.wrap { white-space: normal; min-width: 220px; overflow-wrap: anywhere; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--chip); }
.badge.good { color: var(--good); } .badge.warn { color: var(--warn); } .badge.bad { color: var(--bad); } .badge.neutral { color: var(--neutral); }
.muted { color: var(--muted); }
.alert { border-left: 4px solid var(--bad); }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px; margin: 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
`;

const Layout = (props: { title: string; children?: Child }) => html`<!doctype html>${(
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{props.title} · PrUn Galactic Credit Bureau</title>
      <link rel="icon" type="image/svg+xml" href="/logo.svg" />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <header class="site">
        <div class="inner">
          <a class="brand" href="/">
            <img src="/logo.svg" alt="" width="28" height="28" />
            PrUn Galactic Credit Bureau
          </a>
          <nav>
            <a href="/lenders">Lenders</a>
            <a href="/leaderboards">Leaderboards</a>
            <a href="/sync">Sync health</a>
            <a href="/about">About</a>
          </nav>
        </div>
      </header>
      <main>{props.children}</main>
      <footer>Public data about lending in Prosperous Universe. Amounts are in-game currency and are never added across currencies.</footer>
    </body>
  </html>
)}`;

const STATUS_TONE: Record<Status, string> = {
  in_progress: 'neutral',
  complete: 'good',
  overdue: 'warn',
  breached: 'bad',
  terminated: 'neutral',
  stale: 'warn',
};

const StatusBadge = ({ status }: { status: Status }) => <span class={`badge ${STATUS_TONE[status]}`}>{STATUS_LABELS[status]}</span>;

const TRUST_LABELS: Record<q.Loan['trust'], string> = {
  fio_verified: 'FIO-verified',
  lender_reported: 'Lender-reported',
  community_edited: 'Community-edited',
};

const Money = ({ minor, currency }: { minor: number; currency: string | null }) => (
  <>
    {formatMinor(minor)} <span class="muted">{currency ?? 'non-cash'}</span>
  </>
);

const day = (iso: string) => iso.slice(0, 10);
const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const borrowerUrl = (name: string) => `/borrowers/${encodeURIComponent(name)}`;
const lenderUrl = (name: string) => `/lenders/${encodeURIComponent(name)}`;

const SearchForm = ({ value }: { value?: string }) => (
  <form class="search" action="/search" method="get">
    <input type="search" name="q" value={value ?? ''} placeholder="Borrower or lender username, or company code" aria-label="Search" required minlength={2} />
    <button type="submit">Search</button>
  </form>
);

const ExposureCards = ({ exposure, role }: { exposure: q.Exposure[]; role: 'borrowed' | 'lent' }) => (
  <div class="cards">
    {exposure.map((e) => (
      <div class="card">
        <div class="cur">{e.currency ?? 'NON-CASH'}</div>
        <div class="big">{formatMinor(e.currentMinor)}</div>
        <div class="muted">currently {role === 'borrowed' ? 'owed' : 'out on loan'}</div>
        <dl>
          <dt>Total {role}</dt>
          <dd>{formatMinor(e.totalMinor)}</dd>
          <dt>Loans</dt>
          <dd>{e.loans}</dd>
          <dt>Breached now</dt>
          <dd>{e.breachedLoans}</dd>
          <dt>Ever breached</dt>
          <dd>{e.everBreachedLoans}</dd>
          <dt>Overdue</dt>
          <dd>{e.overdueLoans}</dd>
          {e.staleMinor > 0 && (
            <>
              <dt>Stale (outcome unknown)</dt>
              <dd>{formatMinor(e.staleMinor)}</dd>
            </>
          )}
          {e.terminatedLoans > 0 && (
            <>
              <dt>Terminated (not in total)</dt>
              <dd>{e.terminatedLoans}</dd>
            </>
          )}
        </dl>
      </div>
    ))}
  </div>
);

const LoanTable = ({ loans, hide }: { loans: q.Loan[]; hide?: 'lender' | 'borrower' }) =>
  loans.length === 0 ? (
    <p class="muted">No loans.</p>
  ) : (
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>Issued</th>
            {hide !== 'lender' && <th>Lender</th>}
            {hide !== 'borrower' && <th>Borrower</th>}
            <th class="num">Amount</th>
            <th class="num">Weeks</th>
            <th>Status</th>
            <th>Contract</th>
            <th>Trust</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {loans.map((l) => (
            <tr>
              <td>
                <a href={`/loans/${l.id}`}>{l.issuedOn}</a>
              </td>
              {hide !== 'lender' && (
                <td>
                  <a href={lenderUrl(l.lender)}>{l.lender}</a>
                </td>
              )}
              {hide !== 'borrower' && (
                <td>
                  <a href={borrowerUrl(l.borrower.username)}>{l.borrower.username}</a>
                </td>
              )}
              <td class="num">
                <Money minor={l.principalMinor} currency={l.currency} />
              </td>
              <td class="num">{l.durationWeeks === null ? '–' : Number(l.durationWeeks.toFixed(1))}</td>
              <td>
                <StatusBadge status={l.status} />
                {l.everBreached && l.status !== 'breached' && <span class="badge bad" style="margin-left:4px">was breached</span>}
              </td>
              <td>{l.contractId ?? <span class="muted">–</span>}</td>
              <td class="muted">{TRUST_LABELS[l.trust]}</td>
              <td class="wrap">{l.notes ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

const NotFound = ({ what }: { what: string }) => (
  <Layout title="Not found">
    <h1>Not found</h1>
    <p class="sub">{what}</p>
    <SearchForm />
  </Layout>
);

pages.get('/logo.svg', (c) => c.body(logoSvg, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }));

pages.get('/', async (c) => {
  const totals = await q.getTotals(c.env.DB);
  return c.html(
    <Layout title="Borrower lookup">
      <h1>PrUn Galactic Credit Bureau</h1>
      <p class="sub">
        See what a borrower already owes, and to whom, before you lend. {totals.loans.toLocaleString('en-US')} loans from {totals.lenders} lenders to{' '}
        {totals.borrowers} borrowers.
      </p>
      <SearchForm />
      <h2>All recorded lending</h2>
      <ExposureCards exposure={totals.exposure} role="lent" />
    </Layout>,
  );
});

pages.get('/search', async (c) => {
  const term = (c.req.query('q') ?? '').trim();
  if (term.length < 2) return c.redirect('/');
  const results = await q.search(c.env.DB, term);

  // A single exact hit goes straight to its page.
  const exactBorrower = results.borrowers.find((b) => b.username.toLowerCase() === term.toLowerCase());
  if (exactBorrower && results.lenders.length === 0 && results.borrowers.length === 1) return c.redirect(borrowerUrl(exactBorrower.username));

  return c.html(
    <Layout title={`Search: ${term}`}>
      <h1>Search</h1>
      <SearchForm value={term} />
      <h2>Borrowers</h2>
      {results.borrowers.length === 0 ? (
        <p class="muted">No borrower matches “{term}”. That means no lender has reported a loan to them, not that they have never borrowed.</p>
      ) : (
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Company</th>
                <th>Corp</th>
                <th class="num">Loans</th>
              </tr>
            </thead>
            <tbody>
              {results.borrowers.map((b) => (
                <tr>
                  <td>
                    <a href={borrowerUrl(b.username)}>{b.username}</a>
                  </td>
                  <td>{b.companyCode ?? '–'}</td>
                  <td>{b.corpCode ?? '–'}</td>
                  <td class="num">{b.loans}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {results.lenders.length > 0 && (
        <>
          <h2>Lenders</h2>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th class="num">Loans</th>
                </tr>
              </thead>
              <tbody>
                {results.lenders.map((l) => (
                  <tr>
                    <td>
                      <a href={lenderUrl(l.username)}>{l.username}</a>
                    </td>
                    <td class="num">{l.loans}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Layout>,
  );
});

pages.get('/borrowers/:username', async (c) => {
  const borrower = await q.getBorrower(c.env.DB, c.req.param('username'));
  if (!borrower) {
    c.status(404);
    return c.html(<NotFound what="No lender has reported a loan to this borrower." />);
  }
  const [exposure, { loans }] = await Promise.all([
    q.getBorrowerExposure(c.env.DB, borrower.id),
    q.listLoans(c.env.DB, { borrower: borrower.username, limit: 500, offset: 0 }),
  ]);
  const breachedNow = exposure.reduce((n, e) => n + e.breachedLoans, 0);
  const everBreached = exposure.reduce((n, e) => n + e.everBreachedLoans, 0);
  const lenders = new Set(loans.filter((l) => l.status === 'in_progress' || l.status === 'overdue').map((l) => l.lender));

  return c.html(
    <Layout title={borrower.username}>
      <h1>{borrower.username}</h1>
      <p class="sub">
        Borrower · company {borrower.companyCode ?? 'unknown'} · corp {borrower.corpCode ?? 'none'}
        {borrower.aliases.length > 0 && <> · formerly {borrower.aliases.join(', ')}</>}
        {' · '}
        <a href={lenderUrl(borrower.username)}>lender page</a>
      </p>
      {everBreached > 0 && (
        <p class="panel alert">
          <strong>
            {breachedNow > 0
              ? `${breachedNow} loan${breachedNow === 1 ? ' is' : 's are'} in breach.`
              : 'No loan is in breach now.'}
          </strong>{' '}
          {everBreached} loan{everBreached === 1 ? ' has' : 's have'} been breached at some point.
        </p>
      )}
      <p>
        Currently owes {lenders.size} lender{lenders.size === 1 ? '' : 's'}
        {lenders.size > 0 && <>: {[...lenders].join(', ')}</>}.
      </p>
      <ExposureCards exposure={exposure} role="borrowed" />
      <h2>Loans ({loans.length})</h2>
      <LoanTable loans={loans} hide="borrower" />
    </Layout>,
  );
});

pages.get('/lenders', async (c) => {
  const lenders = (await q.listLenders(c.env.DB)).sort((a, b) => b.loans - a.loans || a.username.localeCompare(b.username));
  const cell = (l: q.LenderSummary, currency: string) => {
    const e = l.exposure.find((x) => x.currency === currency);
    return e && e.currentMinor > 0 ? formatMinor(e.currentMinor) : '';
  };
  return c.html(
    <Layout title="Lenders">
      <h1>Lenders</h1>
      <p class="sub">Amounts are what each lender currently has out on loan, per currency.</p>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Lender</th>
              <th>Tracking</th>
              <th class="num">Loans</th>
              <th class="num">AIC</th>
              <th class="num">CIS</th>
              <th class="num">ICA</th>
              <th class="num">NCC</th>
            </tr>
          </thead>
          <tbody>
            {lenders.map((l) => (
              <tr>
                <td>
                  <a href={lenderUrl(l.username)}>{l.username}</a>
                </td>
                <td class="muted">{l.trackingMode === 'fio' ? 'Automatic (FIO)' : l.trackingMode === 'api' ? 'Reported (API)' : 'Manual'}</td>
                <td class="num">{l.loans}</td>
                <td class="num">{cell(l, 'AIC')}</td>
                <td class="num">{cell(l, 'CIS')}</td>
                <td class="num">{cell(l, 'ICA')}</td>
                <td class="num">{cell(l, 'NCC')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>,
  );
});

pages.get('/lenders/:username', async (c) => {
  const lender = await q.getLender(c.env.DB, c.req.param('username'));
  if (!lender) {
    c.status(404);
    return c.html(<NotFound what="This player has not reported any loans as a lender." />);
  }
  const [exposure, { loans, total }] = await Promise.all([
    q.getLenderExposure(c.env.DB, lender.id),
    q.listLoans(c.env.DB, { lender: lender.username, limit: 500, offset: 0 }),
  ]);
  return c.html(
    <Layout title={lender.username}>
      <h1>{lender.username}</h1>
      <p class="sub">
        Lender · {lender.trackingMode === 'fio' ? 'loans tracked automatically through FIO' : lender.trackingMode === 'api' ? 'loans reported through the API' : 'loans entered by hand'}
      </p>
      <ExposureCards exposure={exposure} role="lent" />
      <h2>
        Loans ({total}
        {total > loans.length && `, newest ${loans.length} shown`})
      </h2>
      <LoanTable loans={loans} hide="lender" />
    </Layout>,
  );
});

pages.get('/loans/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const loan = Number.isInteger(id) && id > 0 ? await q.getLoan(c.env.DB, id) : null;
  if (!loan) {
    c.status(404);
    return c.html(<NotFound what="No such loan." />);
  }
  const [history, revisions] = await Promise.all([q.getLoanHistory(c.env.DB, id), q.getRevisions(c.env.DB, 'loan', id)]);
  return c.html(
    <Layout title={`Loan ${loan.contractId ?? `#${loan.id}`}`}>
      <h1>
        Loan {loan.contractId ?? `#${loan.id}`} <StatusBadge status={loan.status} />
      </h1>
      <p class="sub">
        <a href={lenderUrl(loan.lender)}>{loan.lender}</a> lent to <a href={borrowerUrl(loan.borrower.username)}>{loan.borrower.username}</a>
      </p>
      <div class="panel">
        <dl class="facts">
          <dt>Amount</dt>
          <dd>
            <Money minor={loan.principalMinor} currency={loan.currency} />
          </dd>
          <dt>Issued</dt>
          <dd>{loan.issuedOn}</dd>
          <dt>Duration</dt>
          <dd>{loan.durationWeeks === null ? 'Unknown' : `${Number(loan.durationWeeks.toFixed(2))} weeks`}</dd>
          <dt>Matures</dt>
          <dd>{loan.maturesOn ?? 'Unknown'}</dd>
          <dt>Borrower company</dt>
          <dd>
            {loan.borrower.companyCode ?? 'Unknown'} · corp {loan.borrower.corpCode ?? 'none'}
          </dd>
          <dt>Contract ID</dt>
          <dd>{loan.contractId ?? 'None recorded'}</dd>
          <dt>Trust</dt>
          <dd>{TRUST_LABELS[loan.trust]}</dd>
          <dt>Tracking</dt>
          <dd>{loan.autoTrack ? `Automatic${loan.lastSyncedAt ? `, last checked ${stamp(loan.lastSyncedAt)}` : ''}` : 'Manual entry'}</dd>
          {loan.everBreached && loan.status !== 'breached' && (
            <>
              <dt>Breach</dt>
              <dd>This loan was breached at some point and later changed status.</dd>
            </>
          )}
          {loan.notes && (
            <>
              <dt>Notes</dt>
              <dd>{loan.notes}</dd>
            </>
          )}
        </dl>
      </div>
      <h2>Status history</h2>
      {history.length === 0 ? (
        <p class="muted">No status changes recorded yet.</p>
      ) : (
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>From</th>
                <th>To</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr>
                  <td>{stamp(h.changedAt)}</td>
                  <td>{h.oldStatus ? <StatusBadge status={h.oldStatus} /> : <span class="muted">first seen</span>}</td>
                  <td>
                    <StatusBadge status={h.newStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Version history</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Change</th>
              <th>Recorded values</th>
            </tr>
          </thead>
          <tbody>
            {revisions.map((r) => (
              <tr>
                <td>{day(r.createdAt)}</td>
                <td>{r.actor}</td>
                <td>{r.action === 'import' ? 'Imported from the sheet' : r.action}</td>
                <td class="wrap">
                  <pre>{JSON.stringify(r.after, null, 1)}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>,
  );
});

pages.get('/leaderboards', async (c) => {
  const boards = await q.getLeaderboards(c.env.DB);
  const Board = ({ title, entries }: { title: string; entries: q.LeaderboardEntry[] }) => (
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th class="num">#</th>
            <th>{title}</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colspan={3} class="muted">
                Nobody yet.
              </td>
            </tr>
          )}
          {entries.map((e) => (
            <tr>
              <td class="num">{e.rank}</td>
              <td>
                <a href={lenderUrl(e.lender)}>{e.lender}</a>
              </td>
              <td class="num">{formatMinor(e.amountMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return c.html(
    <Layout title="Leaderboards">
      <h1>Leaderboards</h1>
      <p class="sub">Top 20 lenders in each currency. Terminated loans are not counted.</p>
      {boards.map((b) => (
        <>
          <h2>{b.currency}</h2>
          <div class="cols">
            <Board title="Total lent, all time" entries={b.byTotal} />
            <Board title="Out on loan now" entries={b.byCurrent} />
          </div>
        </>
      ))}
    </Layout>,
  );
});

pages.get('/sync', async (c) => {
  const health = await q.getSyncHealth(c.env.DB);
  return c.html(
    <Layout title="Sync health">
      <h1>Sync health</h1>
      <p class="sub">The latest attempt to read each automatically tracked lender's loan contracts from FIO.</p>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Lender</th>
              <th>Result</th>
              <th class="num">Contracts returned</th>
              <th class="num">Loans kept</th>
              <th>Checked</th>
            </tr>
          </thead>
          <tbody>
            {health.map((h) => (
              <tr>
                <td>
                  <a href={lenderUrl(h.lender)}>{h.lender}</a>
                </td>
                <td>
                  {h.ok ? (
                    <span class="badge good">OK</span>
                  ) : (
                    <span class="badge bad">{h.httpStatus === 401 ? 'No FIO permission (401)' : (h.error ?? 'Failed')}</span>
                  )}
                </td>
                <td class="num">{h.contractsReturned ?? '–'}</td>
                <td class="num">{h.loansKept ?? '–'}</td>
                <td>{stamp(h.checkedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>,
  );
});

pages.get('/about', (c) =>
  c.html(
    <Layout title="About">
      <h1>About the bureau</h1>
      <div class="panel">
        <p>
          The PrUn Galactic Credit Bureau collects loans reported by lenders so that anyone can see how much a borrower already owes and how
          their past loans ended. Reporting is optional. All data is public.
        </p>
        <p>You can report in-game loan contracts, advances (advance purchases of goods) and sponsored bases.</p>
        <h2>Statuses</h2>
        <dl class="facts">
          <dt>In Progress</dt>
          <dd>Paid out and being repaid.</dd>
          <dt>Overdue</dt>
          <dd>A payment deadline has passed.</dd>
          <dt>Breached</dt>
          <dd>The contract was breached in game.</dd>
          <dt>Complete</dt>
          <dd>Fully repaid.</dd>
          <dt>Terminated</dt>
          <dd>Ended early: a cancelled offer or a negotiated exit. Not counted in totals.</dd>
          <dt>Stale</dt>
          <dd>Long past maturity and FIO no longer reports it, so the outcome is unknown.</dd>
        </dl>
        <h2>Trust labels</h2>
        <dl class="facts">
          <dt>FIO-verified</dt>
          <dd>The contract was checked against FIO game data.</dd>
          <dt>Lender-reported</dt>
          <dd>Sent by the lender, not verified.</dd>
          <dt>Community-edited</dt>
          <dd>Entered or changed by someone else. See the loan's version history.</dd>
        </dl>
        <h2>API</h2>
        <p>
          Everything on this site is available as JSON under <a href="/api/v1/stats">/api/v1</a>, with no key needed. For example{' '}
          <code>/api/v1/borrowers/&#123;username&#125;</code>.
        </p>
      </div>
    </Layout>,
  ),
);

/** Used by the app-level 404 handler. */
export const notFoundPage = () => <NotFound what="This page does not exist." />;
