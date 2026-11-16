-- A lender may connect their own FIO API key so the sync can read their loan contracts.
-- The key is stored encrypted (AES-GCM, see src/lib/secretbox.ts); the rest records who connected it.
ALTER TABLE lenders ADD COLUMN fio_key_enc TEXT;
ALTER TABLE lenders ADD COLUMN fio_key_added_by TEXT;
ALTER TABLE lenders ADD COLUMN fio_key_added_by_id TEXT;
ALTER TABLE lenders ADD COLUMN fio_key_added_at TEXT;
