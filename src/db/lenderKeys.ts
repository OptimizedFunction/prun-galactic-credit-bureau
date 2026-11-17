// Lenders who connect their own FIO API key so the sync can read their loan contracts.
// Keys are stored encrypted (see lib/secretbox.ts) and are never returned by any query here.
import { EditError, type Editor } from './edits';

export interface ConnectedLender {
  username: string;
  connectedAt: string;
  /** The first characters of the lender's reporting API key, if one exists. */
  apiKeyPrefix: string | null;
  apiKeyCreatedAt: string | null;
}

/**
 * Stores a lender's (already encrypted) FIO key and switches them to automatic tracking.
 * The caller must already have asked FIO whose key it is; `username` is that account.
 */
export async function connectLender(
  db: D1Database,
  username: string,
  sealedKey: string,
  editor: Editor,
  options: { companyCode?: string | null; now?: Date } = {},
): Promise<void> {
  const nowIso = (options.now ?? new Date()).toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO lenders (username, tracking_mode, fio_key_enc, fio_key_added_by, fio_key_added_by_id, fio_key_added_at, company_code)
         VALUES (?1, 'fio', ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (username) DO UPDATE SET tracking_mode = 'fio', fio_key_enc = ?2, fio_key_added_by = ?3, fio_key_added_by_id = ?4,
           fio_key_added_at = ?5, company_code = COALESCE(?6, lenders.company_code)`,
      )
      .bind(username, sealedKey, editor.name, editor.id, nowIso, options.companyCode ?? null),
    // The audit row says that a key was connected, never the key itself.
    db
      .prepare(
        `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, after_json, created_at)
         SELECT 'lender', id, 'update', 'user', ?, ?, '{"tracking":"fio","fioKey":"connected"}', ? FROM lenders WHERE username = ?`,
      )
      .bind(editor.name, editor.id, nowIso, username),
  ]);
}

/** Deletes the stored key (and any reporting API key, which rested on it) and stops automatic tracking. Only the person who connected the lender may do this. */
export async function disconnectLender(db: D1Database, username: string, editor: Editor, now = new Date()): Promise<void> {
  const row = await db.prepare('SELECT id, fio_key_enc, fio_key_added_by_id FROM lenders WHERE username = ?').bind(username).first<{ id: number; fio_key_enc: string | null; fio_key_added_by_id: string | null }>();
  if (!row || row.fio_key_enc === null) throw new EditError('not_found', 'This lender has no FIO key connected.');
  if (row.fio_key_added_by_id !== editor.id) throw new EditError('conflict', 'Only the person who connected this lender can disconnect it.');
  const nowIso = now.toISOString();
  await db.batch([
    db
      .prepare("UPDATE lenders SET tracking_mode = 'manual', fio_key_enc = NULL, fio_key_added_by = NULL, fio_key_added_by_id = NULL, fio_key_added_at = NULL, api_key_hash = NULL, api_key_prefix = NULL, api_key_created_at = NULL WHERE id = ?")
      .bind(row.id),
    db
      .prepare(
        `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, after_json, created_at)
         VALUES ('lender', ?, 'update', 'user', ?, ?, '{"tracking":"manual","fioKey":"removed"}', ?)`,
      )
      .bind(row.id, editor.name, editor.id, nowIso),
  ]);
}

/** Lenders this Discord user has connected. */
export async function listConnectedBy(db: D1Database, discordId: string): Promise<ConnectedLender[]> {
  const { results } = await db
    .prepare('SELECT username, fio_key_added_at, api_key_prefix, api_key_created_at FROM lenders WHERE fio_key_added_by_id = ? AND fio_key_enc IS NOT NULL ORDER BY username')
    .bind(discordId)
    .all<{ username: string; fio_key_added_at: string; api_key_prefix: string | null; api_key_created_at: string | null }>();
  return results.map((r) => ({ username: r.username, connectedAt: r.fio_key_added_at, apiKeyPrefix: r.api_key_prefix, apiKeyCreatedAt: r.api_key_created_at }));
}

// ---- API keys for reporting loans ----
// A lender who has connected FIO (which proves the account is theirs) can create one key. Only its hash is
// stored, so the key is shown once, when it is made.

const KEY_PREFIX = 'pgcb_';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ownedLender(db: D1Database, username: string, editor: Editor): Promise<{ id: number; username: string }> {
  const row = await db
    .prepare('SELECT id, username, fio_key_enc, fio_key_added_by_id FROM lenders WHERE username = ?')
    .bind(username)
    .first<{ id: number; username: string; fio_key_enc: string | null; fio_key_added_by_id: string | null }>();
  if (!row || row.fio_key_enc === null) throw new EditError('conflict', 'Connect this lender through FIO first; that is what proves the account is yours.');
  if (row.fio_key_added_by_id !== editor.id) throw new EditError('conflict', 'Only the person who connected this lender can manage its API key.');
  return { id: row.id, username: row.username };
}

/** Creates (or replaces) a lender's API key and returns it. This is the only time the key itself exists outside the lender's hands. */
export async function createApiKey(db: D1Database, username: string, editor: Editor, now = new Date()): Promise<{ username: string; apiKey: string; prefix: string }> {
  const lender = await ownedLender(db, username, editor);
  const random = crypto.getRandomValues(new Uint8Array(32));
  const apiKey = KEY_PREFIX + btoa(String.fromCharCode(...random)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const prefix = apiKey.slice(0, KEY_PREFIX.length + 6);
  const nowIso = now.toISOString();
  await db.batch([
    db.prepare('UPDATE lenders SET api_key_hash = ?, api_key_prefix = ?, api_key_created_at = ? WHERE id = ?').bind(await sha256Hex(apiKey), prefix, nowIso, lender.id),
    db
      .prepare(
        `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, after_json, created_at)
         VALUES ('lender', ?, 'update', 'user', ?, ?, '{"apiKey":"created"}', ?)`,
      )
      .bind(lender.id, editor.name, editor.id, nowIso),
  ]);
  return { username: lender.username, apiKey, prefix };
}

export async function revokeApiKey(db: D1Database, username: string, editor: Editor, now = new Date()): Promise<void> {
  const lender = await ownedLender(db, username, editor);
  await db.batch([
    db.prepare('UPDATE lenders SET api_key_hash = NULL, api_key_prefix = NULL, api_key_created_at = NULL WHERE id = ?').bind(lender.id),
    db
      .prepare(
        `INSERT INTO revisions (entity_type, entity_id, action, actor_type, actor, actor_id, after_json, created_at)
         VALUES ('lender', ?, 'update', 'user', ?, ?, '{"apiKey":"revoked"}', ?)`,
      )
      .bind(lender.id, editor.name, editor.id, now.toISOString()),
  ]);
}

/** The lender an API key belongs to, or null. */
export async function lenderForApiKey(db: D1Database, apiKey: string): Promise<{ id: number; username: string } | null> {
  if (!apiKey.startsWith(KEY_PREFIX) || apiKey.length > 100) return null;
  return db.prepare('SELECT id, username FROM lenders WHERE api_key_hash = ?').bind(await sha256Hex(apiKey)).first<{ id: number; username: string }>();
}
