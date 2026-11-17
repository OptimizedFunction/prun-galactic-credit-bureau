// "My lending": a signed-in lender's own view. Only for lenders who connected a FIO key, since the key
// is the proof of which game account they are. Loans typed into the ledger under the same lender
// username appear here too.
import { Hono } from 'hono';
import { currentUser } from './auth';
import { listConnectedBy } from './db/lenderKeys';
import * as q from './db/queries';
import { formatMinor } from './lib/normalize';
import { isOpen, Layout, lenderUrl, LoanTable, MoneyStat, plural, stamp, Stat, Verdict } from './pages';
import type { Env } from './env';

export const mePages = new Hono<{ Bindings: Env }>();

const DAY_MS = 86_400_000;
const SOON_DAYS = 14;

mePages.get('/my-lending', async (c) => {
  c.header('Cache-Control', 'no-store');
  const user = await currentUser(c);
  if (!user) {
    return c.html(
      <Layout title="My lending">
        <h1>My lending</h1>
        <p class="sub">Your own loans in one place: what is out, what is due soon and what needs attention.</p>
        <div class="panel">
          <p>
            <a href="/auth/login?return=/my-lending">Sign in with Discord</a> to see it.
          </p>
        </div>
      </Layout>,
    );
  }

  const connected = await listConnectedBy(c.env.DB, user.id);
  if (connected.length === 0) {
    return c.html(
      <Layout title="My lending">
        <h1>My lending</h1>
        <p class="sub">Your own loans in one place: what is out, what is due soon and what needs attention.</p>
        <div class="panel">
          <p>
            <strong>Connect FIO to switch this on.</strong> My lending is for lenders who have connected their own FIO key, because the key is how the
            bureau knows which game account is yours.
          </p>
          <p>
            <a class="button" href="/track">
              Track my loans
            </a>
          </p>
          <p class="muted">
            Not connected yet? Your loans may still be on record. Every lender has a public page; find yours with <a href="/">Lookup</a>.
          </p>
        </div>
      </Layout>,
    );
  }

  const health = await q.getSyncHealth(c.env.DB);
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + SOON_DAYS * DAY_MS).toISOString().slice(0, 10);

  const sections = await Promise.all(
    connected.map(async ({ username }) => {
      const lender = (await q.getLender(c.env.DB, username))!;
      const [exposure, { loans }] = await Promise.all([
        q.getLenderExposure(c.env.DB, lender.id),
        q.listLoans(c.env.DB, { lender: lender.username, limit: 1000, offset: 0 }),
      ]);
      return { lender, exposure, loans, sync: health.find((h) => h.lender.toLowerCase() === lender.username.toLowerCase()) };
    }),
  );

  return c.html(
    <Layout title="My lending">
      <h1>My lending</h1>
      <p class="sub">Your loans from FIO, plus any entered in the ledger under your name. Only you see this page; the figures themselves are public.</p>

      {sections.map(({ lender, exposure, loans, sync }) => {
        const all = q.combine(exposure);
        const open = loans.filter(isOpen);
        // A breach is settled history as far as the game goes, so it is listed apart from loans that still call for action.
        const attention = open.filter((l) => l.status === 'overdue' || l.status === 'stale');
        const breached = open.filter((l) => l.status === 'breached');
        const running = open.filter((l) => l.status === 'in_progress');
        const dueSoon = running.filter((l) => l.maturesOn !== null && l.maturesOn >= today && l.maturesOn <= soon);
        const pastTerm = running.filter((l) => l.maturesOn !== null && l.maturesOn < today);
        const rest = running.filter((l) => !dueSoon.includes(l) && !pastTerm.includes(l));
        const borrowers = new Set(loans.filter((l) => l.status === 'in_progress' || l.status === 'overdue').map((l) => l.borrower.username.toLowerCase()));
        const outIn = exposure.filter((e) => e.currency !== null && e.currentMinor > 0);
        const headline =
          all.currentMinor > 0
            ? `You have ${formatMinor(all.currentMinor)}${outIn.length === 1 ? ` ${outIn[0]!.currency}` : ''} out on loan to ${plural(borrowers.size, 'borrower')}.`
            : 'You have nothing out on loan at the moment.';
        const needs = attention.length + pastTerm.length;

        return (
          <section class="mine">
            {sections.length > 1 && <h2>{lender.username}</h2>}

            {sync && !sync.ok ? (
              <p class="panel alert">
                <strong>The bureau cannot read your loans from FIO.</strong> {sync.error ?? 'The last sync failed.'} Last tried {stamp(sync.checkedAt)}. If you
                revoked or replaced your key, <a href="/track">connect a new one</a>. Until then your loans stay as they were.
              </p>
            ) : (
              <p class="fresh">
                Lending as <a href={lenderUrl(lender.username)}>{lender.username}</a>.{' '}
                {sync ? (
                  <>
                    FIO key working; last read{' '}
                    <time datetime={sync.checkedAt} data-rel>
                      {stamp(sync.checkedAt)}
                    </time>
                    .
                  </>
                ) : (
                  'Your first sync is on its way; loans appear within a minute of connecting.'
                )}
              </p>
            )}

            <Verdict tone={needs > 0 ? 'warn' : 'neutral'} headline={headline} detail={needs > 0 ? `${plural(needs, 'loan')} need${needs === 1 ? 's' : ''} your attention.` : undefined}>
              <MoneyStat label="Out on loan now" combinedMinor={all.currentMinor} exposure={exposure} pick={(e) => e.currentMinor} />
              <MoneyStat label="Lent in total" combinedMinor={all.totalMinor} exposure={exposure} pick={(e) => e.totalMinor} />
              <Stat label="Borrowers now" value={borrowers.size} />
              <Stat label="In breach" value={all.breachedLoans} note={`${all.everBreachedLoans} ever · ${all.overdueLoans} overdue`} />
              <Stat label="Loans" value={(all.loans + all.nonCashLoans).toLocaleString('en-US')} note={`${open.length} open`} />
            </Verdict>

            <h2>Needs attention ({needs})</h2>
            {needs === 0 ? (
              <p class="muted">Nothing. No loan of yours is overdue, stale or past its term.</p>
            ) : (
              <>
                {attention.length > 0 && <LoanTable loans={attention} hide="lender" />}
                {pastTerm.length > 0 && (
                  <>
                    <p class="hint spaced">Past their term but still shown as In Progress in the game:</p>
                    <LoanTable loans={pastTerm} hide="lender" />
                  </>
                )}
              </>
            )}

            <h2>
              Finishing in the next {SOON_DAYS} days ({dueSoon.length})
            </h2>
            {dueSoon.length === 0 ? <p class="muted">None.</p> : <LoanTable loans={dueSoon} hide="lender" />}

            <h2>Other open loans ({rest.length})</h2>
            {rest.length === 0 ? <p class="muted">None.</p> : <LoanTable loans={rest} hide="lender" />}

            {breached.length > 0 && (
              <>
                <h2>In breach ({breached.length})</h2>
                <LoanTable loans={breached} hide="lender" />
              </>
            )}

            <p>
              Closed loans and the public view are on <a href={lenderUrl(lender.username)}>your lender page</a>.
            </p>
          </section>
        );
      })}
    </Layout>,
  );
});
