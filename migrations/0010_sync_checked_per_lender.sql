-- The hourly sync used to stamp last_synced_at on every loan FIO returned, rewriting each tracked loan every hour.
-- Now a lender carries one "last checked" time, and a loan only notes whether FIO returned it last time:
--   fio_seen = 1  FIO returned it in its lender's latest successful check (lenders.fio_checked_at)
--   fio_seen = 0  it was not, and last_synced_at is the last time it was
-- so a loan's row changes only when FIO starts or stops returning it.
ALTER TABLE lenders ADD COLUMN fio_checked_at TEXT;
ALTER TABLE loans ADD COLUMN fio_seen INTEGER NOT NULL DEFAULT 0;
