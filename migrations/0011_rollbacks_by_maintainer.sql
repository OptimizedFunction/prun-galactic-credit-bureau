-- Rollbacks used to be recorded as the system job "rollback", naming the maintainer only in the reason
-- ("Rolled back by <name>" or "Rolled back by <name>: <why>"). The change log hides system entries by default,
-- so it showed the changes but not their reversal. They are now recorded under the maintainer, like any edit.
-- This moves the earlier ones over: the name comes from the reason, the Discord ID from that person's other edits.
UPDATE revisions
SET actor_type = 'user',
    actor = CASE
      WHEN instr(substr(json_extract(after_json, '$.reason'), 16), ':') > 0
        THEN substr(json_extract(after_json, '$.reason'), 16, instr(substr(json_extract(after_json, '$.reason'), 16), ':') - 1)
      ELSE substr(json_extract(after_json, '$.reason'), 16)
    END,
    actor_id = (
      SELECT r2.actor_id FROM revisions r2
      WHERE r2.actor_type = 'user' AND r2.actor_id IS NOT NULL
        AND r2.actor = CASE
          WHEN instr(substr(json_extract(revisions.after_json, '$.reason'), 16), ':') > 0
            THEN substr(json_extract(revisions.after_json, '$.reason'), 16, instr(substr(json_extract(revisions.after_json, '$.reason'), 16), ':') - 1)
          ELSE substr(json_extract(revisions.after_json, '$.reason'), 16)
        END COLLATE NOCASE
      ORDER BY r2.id DESC LIMIT 1
    )
WHERE actor_type = 'system' AND actor = 'rollback' AND json_extract(after_json, '$.reason') LIKE 'Rolled back by %';
