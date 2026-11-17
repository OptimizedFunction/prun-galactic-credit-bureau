-- Tracking is self-serve only: a lender is tracked through FIO when, and only when, they have connected
-- their own FIO API key. The shared bureau key is gone, so lenders the sheet import marked as tracked
-- without a key go back to manual, the same state a lender is in after disconnecting a key.
-- Their loans are left exactly as they are (Auto track stays ticked), so the sync picks them up again
-- as soon as the lender connects.
INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, after_json)
SELECT 'lender', id, 'update', 'system', 'self-serve-migration', 'system',
       '{"tracking":"manual","reason":"The shared FIO key was retired. Tracking resumes when the lender connects their own key"}'
FROM lenders WHERE tracking_mode = 'fio' AND fio_key_enc IS NULL;

UPDATE lenders SET tracking_mode = 'manual' WHERE tracking_mode = 'fio' AND fio_key_enc IS NULL;
