-- Bumped on every write to a loan. An edit only applies if the loan is still at the version it read,
-- so two people saving at the same moment cannot silently overwrite each other.
ALTER TABLE loans ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- The ledger polls for loans changed since it last looked.
CREATE INDEX loans_updated_at ON loans (updated_at);
