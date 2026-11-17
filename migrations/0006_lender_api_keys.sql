-- Lenders' API keys for reporting loans. Only the SHA-256 hash is stored (lenders.api_key_hash, from 0001);
-- the prefix is kept so a lender can tell which key is active.
ALTER TABLE lenders ADD COLUMN api_key_prefix TEXT;
ALTER TABLE lenders ADD COLUMN api_key_created_at TEXT;

CREATE UNIQUE INDEX lenders_api_key_hash ON lenders (api_key_hash) WHERE api_key_hash IS NOT NULL;
