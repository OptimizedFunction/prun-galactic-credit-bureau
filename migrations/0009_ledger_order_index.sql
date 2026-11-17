-- The ledger and the loans API list newest first. Without this index every page sorted the whole loans table,
-- reading thousands of rows to show a few hundred, and a crawler paging through it used up D1's daily read allowance.
CREATE INDEX loans_listed ON loans (issued_on DESC, id DESC) WHERE deleted_at IS NULL;
