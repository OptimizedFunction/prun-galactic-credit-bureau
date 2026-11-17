-- Token buckets for rate limiting writes (see src/lib/rateLimit.ts).
-- key is "user:<discord id>" or "lender:<lender id>", never a network address.
CREATE TABLE rate_buckets (
  key        TEXT PRIMARY KEY,
  tokens     REAL NOT NULL,
  updated_ms INTEGER NOT NULL
);
