-- Community editing.

-- Deleting a loan hides it; the row and its history stay so the deletion can be undone.
ALTER TABLE loans ADD COLUMN deleted_at TEXT;

-- Discord user ID of the person who made a change (NULL for system changes).
ALTER TABLE revisions ADD COLUMN actor_id TEXT;

CREATE INDEX revisions_recent ON revisions (action, id);
