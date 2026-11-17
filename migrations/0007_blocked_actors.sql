-- Accounts barred from changing anything. actor_id is a Discord user ID, or "lender:<id>" for a lender's API key.
CREATE TABLE blocked_actors (
  actor_id      TEXT PRIMARY KEY,
  name          TEXT,
  reason        TEXT,
  blocked_by    TEXT NOT NULL,
  blocked_by_id TEXT NOT NULL,
  blocked_at    TEXT NOT NULL
);

-- Rolling back finds an account's changes by its ID.
CREATE INDEX revisions_actor ON revisions (actor_id, id);
