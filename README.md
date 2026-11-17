# PrUn Galactic Credit Bureau

<img src="assets/logo.svg" alt="" width="96" align="right">

A public record of lending between [Prosperous Universe](https://prosperousuniverse.com/) players. Lenders report
their loans so that anyone can see how much a borrower already owes, to whom, and how their past loans ended.

It replaces the community "PRUN Credit Bureau Automated" Google Sheet with a website and an open JSON API.

- All data is public. Reading needs no key.
- Amounts always carry a currency (AIC, CIS, ICA, NCC). Summaries also show a combined figure, which adds the four
  currencies at face value with no exchange rate, and says so.
- Every loan keeps a status history and a version history.

## Status

| Part | State |
|---|---|
| Database schema | Done |
| Import of the existing sheet, checked against its Summary tab | Done |
| Read API (`/api/v1`) and public pages | Done |
| Automatic sync from FIO | Done; run against live FIO locally |
| Community editing (ledger page, Discord sign-in, change log with undo) | Done; sign-in itself not yet tried with a real Discord account |
| Lenders connecting their own FIO key (Track my loans page) | Done |
| My lending (a connected lender's own view, with key health) | Done |
| Lender API keys and the report endpoint | Done |
| Token-bucket rate limiting on the API | Done |
| Blocking accounts and rolling back their changes | Done |
| Deployment | Not started (runs locally only) |

## Run it locally

Needs Node.js 20.3 or newer.

```sh
npm install
npm run seed     # create the local database, download the sheet, import it, verify totals
npm run dev      # http://localhost:8787
```

`npm run seed` runs four steps you can also run one at a time:

| Command | What it does |
|---|---|
| `npm run db:migrate` | Applies `migrations/` to the local D1 database (`.wrangler/`) |
| `npm run sheet:fetch` | Downloads the sheet's tabs as CSV into `data/sheet/` |
| `npm run sheet:import` | Empties the local database and loads the sheet. Writes `data/import-report.md` listing every row it had to clean up |
| `npm run sheet:verify` | Compares borrower and lender totals in the database with the sheet's Summary tab |

Other commands: `npm test` (unit tests), `npm run typecheck`, `npm run db:reset` (delete and recreate the
local database; stop `npm run dev` first).

### Pulling later sheet changes into a database that is in use

`sheet:import` starts from nothing. Once people edit on the site, use `sheet:migrate` instead: it downloads
the sheet and reconciles it with the database, without emptying anything.

```
npm run sheet:migrate                        # look only, local database
npm run sheet:migrate -- --apply             # change the local database
npm run sheet:migrate -- --remote            # look only, production (needs `npx wrangler login`)
npm run sheet:migrate -- --remote --apply    # change production
```

Sheet rows are matched to loans by contract ID, then by lender, borrower, amount, currency and date, then
by the sheet row they were imported from. For each field of a matched loan:

| Situation | Result |
|---|---|
| Only the sheet changed it since the last import | The sheet's value is taken, recorded in the loan's history as "Update from the Google Sheet" |
| Only the site changed it | The site's value is kept |
| Both changed it, differently | Conflict: the site is kept and the field is listed. Add `--prefer-sheet` to take the sheet instead |
| The site keeps the loan up to date from FIO | Only notes are reconciled; FIO decides the rest |

Sheet rows with no loan on the site are added. Nothing is deleted: loans that left the sheet or were deleted
on the site are only listed. Every run writes `data/migration-report-local.md` or `-production.md` with each
change, and running it again after `--apply` finds nothing left to do. A production run prints the
`wrangler d1 time-travel restore` command that undoes it.

### FIO sync

The sync runs hourly as a cron trigger. It reads the loan contracts of every lender who connected their own
FIO API key on the Track my loans page, each with their own key (stored encrypted with `FIO_KEY_SECRET`).
There is no shared key and no FIO group to join: a lender who has not connected a key is not fetched, and
their loans stay as they were last recorded until they connect.

Set `FIO_KEY_SECRET` to any long random string in `.dev.vars`. Do not change it once keys are stored: they
become unreadable and lenders have to connect again.

To run the sync locally, start `npm run dev:cron` and open `http://localhost:8787/__scheduled`. Results show
in the Updates column of the Lenders page.

`npm run sync:dry` fetches from live FIO and prints what the sync would change, without writing anything.

To import a copy of the sheet instead, set `SHEET_ID` (and `SHEET_GIDS` if the tab IDs differ, e.g.
`{"status-history":123,"lender-sync":456}`).

## Editing

Anyone who signs in with Discord can add, edit and delete loans on the Ledger page. Every change is recorded
with the editor's Discord username and ID, shown on the Recent changes page, and can be undone there. Loans
the FIO sync manages (Auto track ticked) only accept edits to their notes, and cannot be deleted.

Several people can edit at once. Each save covers one cell and states the value the editor was looking at; if
someone else changed that cell first, the save is refused and the row shows the current value. The ledger
also checks for other people's changes every 30 seconds while its tab is visible.

Sign-in needs a Discord application: put its client ID and secret in `.dev.vars`, and add
`http://localhost:8787/auth/callback` and `http://127.0.0.1:8787/auth/callback` as redirect URLs in the
Discord developer portal.

## Reporting API

A lender who has connected FIO can create a reporting API key on the Track my loans page and record loans from
their own tools, for lending the game cannot see (advances, sponsored bases):

```sh
curl -X PUT https://<host>/api/v1/lenders/<username>/loans/<contract or own reference> \
  -H "Authorization: Bearer pgcb_..." -H "Content-Type: application/json" \
  -d '{"borrower":"SomePlayer","principal":"2,500,000","currency":"NCC","issuedOn":"2026-11-10","status":"In Progress"}'
```

Reports are idempotent by contract ID, labelled Lender-reported, and listed in Recent changes like any edit.
Only the key's hash is stored.

## Recovering from abuse

Every change to a loan is stored as a revision: who made it, and the values before and after. That log is
the version history, and three tools build on it, from lightest to heaviest:

1. **Undo one change.** Any signed-in user, from Recent changes.
2. **Block an account and roll back everything it did.** Maintainers only, from the Maintainer tools panel on
   Recent changes (filter by the person first). A rollback deletes loans the account added, restores loans it
   deleted and puts back the fields it changed, since a time you choose. Fields someone else has changed since
   are left alone and listed. Lender API keys can be blocked and rolled back the same way.
3. **Restore the whole database.** D1 keeps 30 days of history (Time Travel). To go back to a moment:

   ```sh
   npx wrangler d1 time-travel info bureau --timestamp=2026-11-17T10:00:00Z
   npx wrangler d1 time-travel restore bureau --timestamp=2026-11-17T10:00:00Z
   ```

   This rewinds everything, including honest edits made after that moment, so prefer step 2 when one account
   is the problem. `npm run db:backup` saves a full SQL copy of the live database to `data/`.

Maintainers are the Discord user IDs listed in `ADMIN_DISCORD_IDS` (comma-separated).

## API

The contract is [openapi.yaml](openapi.yaml). The site serves it at `/openapi.yaml` and renders it as an
interactive reference at `/api` (Swagger UI, loaded from cdnjs). Examples:

```
GET /api/v1/companies/{username or company code}   a company's whole record, as borrower and lender
GET /api/v1/borrowers/{username}        exposure per currency + all loans
GET /api/v1/search?q={name or company code}
GET /api/v1/lenders/{username}/loans
GET /api/v1/loans?contractId={id}
GET /api/v1/loans/{id}                  with status history and version history
GET /api/v1/leaderboards
GET /api/v1/sync
GET /api/v1/changes
```

## How figures are defined

- **Total** leaves out terminated loans (cancelled offers and negotiated exits).
- **Current** is In Progress plus Overdue.
- **Stale** means a loan is long past maturity and FIO no longer reports it, so the outcome is unknown. It is shown separately.
- **Ever breached** uses the status history, so a breach that was later cured still shows.

## Layout

```
migrations/      D1 schema
openapi.yaml     API contract
src/index.tsx    Worker entry (Hono)
src/api.ts       JSON API
src/pages.tsx    Server-rendered pages
src/apidocs.tsx  API reference page
src/ledger.tsx   Editable ledger and Recent changes pages
src/auth.ts      Discord sign-in and the signed session cookie
src/track.tsx    Track my loans page (lenders connect a FIO key)
src/me.tsx       My lending page
assets/          Logo and the ledger's browser script
src/db/          Database queries, edits, lender keys, blocking and rollback
src/sync/        FIO sync: client, decision rules, database writes
src/lib/         Shared pure helpers (amounts, IDs, statuses)
scripts/         Sheet download, import and verification
test/            Unit tests
```

## Secrets

No secret belongs in this repository. Copy `.dev.vars.example` to `.dev.vars` (git-ignored) for local
development; in production use `wrangler secret put`.

## Licence

MIT
