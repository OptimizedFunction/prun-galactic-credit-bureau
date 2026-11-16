# PrUn Galactic Credit Bureau

<img src="assets/logo.svg" alt="" width="96" align="right">

A public record of lending between [Prosperous Universe](https://prosperousuniverse.com/) players. Lenders report
their loans so that anyone can see how much a borrower already owes, to whom, and how their past loans ended.

It replaces the community "PRUN Credit Bureau Automated" Google Sheet with a website and an open JSON API.

- All data is public. Reading needs no key.
- Amounts always carry a currency (AIC, CIS, ICA, NCC). They are only added across currencies on the combined leaderboard, at face value.
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
| Lender API keys and the report endpoint | Not started |
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

### FIO sync

The sync runs hourly as a cron trigger. It reads each tracked lender's loan contracts from FIO using:

- the lender's own FIO API key, if they connected one on the Track my loans page (stored encrypted with
  `FIO_KEY_SECRET`), or otherwise
- `FIO_API_KEY`, a bureau FIO account that the lender granted contract permission to (optional).

Set `FIO_KEY_SECRET` to any long random string in `.dev.vars`. Do not change it once keys are stored: they
become unreadable and lenders have to connect again.

To run the sync locally, start `npm run dev:cron` and open `http://localhost:8787/__scheduled`. Results show
on the Sync health page.

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

## API

The contract is [openapi.yaml](openapi.yaml). Examples:

```
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
src/ledger.tsx   Editable ledger and Recent changes pages
src/auth.ts      Discord sign-in and the signed session cookie
src/track.tsx    Track my loans page (lenders connect a FIO key)
assets/          Logo and the ledger's browser script
src/db/          Database queries and edits
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
