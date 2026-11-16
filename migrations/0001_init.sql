-- PrUn Credit Bureau — initial schema.
-- Conventions:
--   * money is an INTEGER in hundredths of a currency unit, always next to a currency column
--   * timestamps are ISO 8601 UTC text; dates are YYYY-MM-DD text
--   * usernames and codes compare case-insensitively (COLLATE NOCASE)

CREATE TABLE lenders (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  company_code  TEXT COLLATE NOCASE,
  -- fio: the sync job pulls this lender's contracts; api: lender reports with a key; manual: hand-entered rows only
  tracking_mode TEXT NOT NULL DEFAULT 'manual' CHECK (tracking_mode IN ('fio', 'api', 'manual')),
  api_key_hash  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE borrowers (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- First-seen identity. Never blanked when a later company lookup fails (liquidated companies).
  company_code  TEXT COLLATE NOCASE,
  corp_code     TEXT COLLATE NOCASE,
  -- In-game company name, which is what FIO contracts name the partner by.
  company_name  TEXT COLLATE NOCASE,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX borrowers_company_name ON borrowers (company_name);

-- Former usernames, e.g. Spermatozoon_Saloon -> Dyeus_Phter.
CREATE TABLE borrower_aliases (
  alias       TEXT PRIMARY KEY COLLATE NOCASE,
  borrower_id INTEGER NOT NULL REFERENCES borrowers (id)
);

CREATE TABLE loans (
  id                    INTEGER PRIMARY KEY,
  -- Normalised (trimmed, upper-case) in-game contract ID. NULL for manual entries without one.
  contract_id           TEXT UNIQUE,
  lender_id             INTEGER NOT NULL REFERENCES lenders (id),
  borrower_id           INTEGER NOT NULL REFERENCES borrowers (id),
  -- Borrower's company/corp as recorded on this loan (corps change over time).
  borrower_company_code TEXT COLLATE NOCASE,
  borrower_corp_code    TEXT COLLATE NOCASE,
  principal_minor       INTEGER NOT NULL CHECK (principal_minor >= 0),
  -- NULL = not a cash loan in one of the four currencies (e.g. repaid in materials).
  currency              TEXT CHECK (currency IN ('AIC', 'CIS', 'ICA', 'NCC')),
  issued_on             TEXT NOT NULL,
  duration_weeks        REAL CHECK (duration_weeks >= 0),
  -- NULL = unknown.
  loan_type             TEXT CHECK (loan_type IN ('stable', 'interest', 'annuity', 'advance', 'sponsored_base', 'other')),
  status                TEXT NOT NULL CHECK (status IN ('in_progress', 'complete', 'overdue', 'breached', 'terminated', 'stale')),
  outstanding_minor     INTEGER CHECK (outstanding_minor >= 0),
  notes                 TEXT,
  trust                 TEXT NOT NULL CHECK (trust IN ('fio_verified', 'lender_reported', 'community_edited')),
  source                TEXT NOT NULL CHECK (source IN ('fio', 'api', 'manual', 'sheet_import')),
  -- 1 = managed by the FIO sync job; 0 = manual row the sync must never overwrite.
  auto_track            INTEGER NOT NULL DEFAULT 0 CHECK (auto_track IN (0, 1)),
  last_synced_at        TEXT,
  -- Where the row came from, e.g. "sheet:Ledger!17".
  source_ref            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX loans_borrower ON loans (borrower_id, issued_on);
CREATE INDEX loans_lender ON loans (lender_id, issued_on);
CREATE INDEX loans_status ON loans (status);
CREATE INDEX loans_borrower_company ON loans (borrower_company_code);

-- Append-only. Status is a snapshot, so "ever breached" and cured breaches live here.
CREATE TABLE loan_status_history (
  id         INTEGER PRIMARY KEY,
  loan_id    INTEGER NOT NULL REFERENCES loans (id),
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('fio_sync', 'api', 'edit', 'sheet_import'))
);

CREATE INDEX loan_status_history_loan ON loan_status_history (loan_id, changed_at);

-- Every edit to any record, for public version history.
CREATE TABLE revisions (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('loan', 'lender', 'borrower')),
  entity_id   INTEGER NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('import', 'create', 'update', 'delete')),
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('system', 'lender', 'user')),
  actor       TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX revisions_entity ON revisions (entity_type, entity_id, created_at);

-- One row per lender per sync run.
CREATE TABLE sync_runs (
  id                 INTEGER PRIMARY KEY,
  run_id             TEXT NOT NULL,
  lender_id          INTEGER NOT NULL REFERENCES lenders (id),
  checked_at         TEXT NOT NULL,
  http_status        INTEGER,
  contracts_returned INTEGER,
  loans_kept         INTEGER,
  error              TEXT
);

CREATE INDEX sync_runs_lender ON sync_runs (lender_id, checked_at);

-- Raw FIO contract payloads, kept as evidence.
CREATE TABLE fio_raw (
  contract_id TEXT NOT NULL,
  lender_id   INTEGER NOT NULL REFERENCES lenders (id),
  fetched_at  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (contract_id, lender_id)
);
