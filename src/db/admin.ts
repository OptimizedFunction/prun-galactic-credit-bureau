// Dealing with abuse: block an account, and roll back everything it changed.
//
// Every change to a loan is a revision holding who made it and the values before and after. That log is
// the bureau's version history, and it is enough to undo one account's work without touching anyone else's.
// (For damage beyond that, D1 Time Travel restores the whole database to any minute in the last 30 days.)
import { currentValues, deleteLoan, parseLoanFields, restoreLoan, updateLoan, type Editor, type Trust } from './edits';

export interface Admin {
  id: string;
  name: string;
}

/** Maintainers are listed by Discord user ID in the ADMIN_DISCORD_IDS environment variable, comma-separated. */
export function isAdmin(adminIds: string | undefined, userId: string): boolean {
  return (adminIds ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(userId);
}

export interface Block {
  actorId: string;
  name: string | null;
  reason: string | null;
  blockedBy: string;
  blockedAt: string;
}

export async function isBlocked(db: D1Database, actorId: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS hit FROM blocked_actors WHERE actor_id = ?').bind(actorId).first()) !== null;
}

export async function block(db: D1Database, actorId: string, name: string | null, reason: string | null, admin: Admin, now = new Date()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO blocked_actors (actor_id, name, reason, blocked_by, blocked_by_id, blocked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (actor_id) DO UPDATE SET name = COALESCE(excluded.name, name), reason = excluded.reason, blocked_by = excluded.blocked_by,
         blocked_by_id = excluded.blocked_by_id, blocked_at = excluded.blocked_at`,
    )
    .bind(actorId, name, reason, admin.name, admin.id, now.toISOString())
    .run();
}

export async function unblock(db: D1Database, actorId: string): Promise<void> {
  await db.prepare('DELETE FROM blocked_actors WHERE actor_id = ?').bind(actorId).run();
}

export async function listBlocks(db: D1Database): Promise<Block[]> {
  const { results } = await db
    .prepare('SELECT actor_id, name, reason, blocked_by, blocked_at FROM blocked_actors ORDER BY blocked_at DESC')
    .all<{ actor_id: string; name: string | null; reason: string | null; blocked_by: string; blocked_at: string }>();
  return results.map((r) => ({ actorId: r.actor_id, name: r.name, reason: r.reason, blockedBy: r.blocked_by, blockedAt: r.blocked_at }));
}

export interface RollbackResult {
  /** Loans the account touched in the period. */
  loans: number;
  /** Loans it had added, now deleted. */
  removed: number;
  /** Loans it had deleted, now back. */
  restored: number;
  /** Loans with at least one field put back. */
  reverted: number;
  /** Fields left alone because someone else has changed them since, as "loan #12: status". */
  skipped: string[];
}

interface RevisionRow {
  id: number;
  entity_id: number;
  action: string;
  actor: string;
  before_json: string | null;
  after_json: string | null;
}

const NOT_FIELDS = new Set(['trust', 'deleted', 'reason']);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Undoes every change one account made to loans since a moment in time.
 *
 * For each loan it touched: a loan it added is deleted; a loan it deleted is restored; each field it
 * changed goes back to what it held before the account's first change in the period. A field that someone
 * else has changed since is left alone and reported, so honest later work is never overwritten.
 * The rollback is itself recorded in each loan's history under the maintainer who ran it, like any edit, with a
 * reason naming whose changes it undid and from when, so the change log reads as one unbroken account.
 */
export async function rollbackActor(db: D1Database, actorId: string, since: string, admin: Admin, reason?: string): Promise<RollbackResult> {
  const { results } = await db
    .prepare("SELECT id, entity_id, action, actor, before_json, after_json FROM revisions WHERE entity_type = 'loan' AND actor_id = ? AND created_at >= ? ORDER BY id")
    .bind(actorId, since)
    .all<RevisionRow>();

  const byLoan = new Map<number, RevisionRow[]>();
  for (const r of results) byLoan.set(r.entity_id, [...(byLoan.get(r.entity_id) ?? []), r]);

  const maintainer: Editor = { id: admin.id, name: admin.name, kind: 'maintainer' };
  // Named by the name they last used (a Discord name can change); the ID is what the rollback went by.
  const whose = results.length > 0 ? results[results.length - 1]!.actor : actorId;
  const why = `Rolled back changes by ${whose} since ${since.slice(0, 16).replace('T', ' ')} UTC${reason ? `: ${reason}` : ''}`;
  const result: RollbackResult = { loans: byLoan.size, removed: 0, restored: 0, reverted: 0, skipped: [] };

  for (const [loanId, revisions] of byLoan) {
    const now = await currentValues(db, loanId);

    // The account added this loan: it goes, whatever was done to it afterwards.
    if (revisions[0]!.action === 'create') {
      if (!now.deleted) {
        await deleteLoan(db, loanId, maintainer, new Date(), why);
        result.removed++;
      }
      continue;
    }

    // What each field (and the deleted flag, and the trust label) held before the account first touched it,
    // and what the account last set it to.
    const original: Record<string, unknown> = {};
    const lastSet: Record<string, unknown> = {};
    for (const r of revisions) {
      const before = r.before_json ? (JSON.parse(r.before_json) as Record<string, unknown>) : {};
      const after = r.after_json ? (JSON.parse(r.after_json) as Record<string, unknown>) : {};
      if (r.action === 'delete') {
        if (!('deleted' in original)) original['deleted'] = false;
        lastSet['deleted'] = true;
        continue;
      }
      for (const key of Object.keys(after)) {
        if (key === 'reason') continue;
        if (!(key in original)) original[key] = before[key] ?? null;
        lastSet[key] = after[key];
      }
    }

    // Deleted or not, first: a deleted loan cannot be edited.
    // Already as it was (restored by someone, or by an earlier rollback): nothing to do.
    if ('deleted' in original && now.deleted !== original['deleted']) {
      if (!same(now.deleted, lastSet['deleted'])) result.skipped.push(`loan #${loanId}: deleted`);
      else if (original['deleted'] === false && now.deleted) {
        await restoreLoan(db, loanId, maintainer, new Date(), why);
        result.restored++;
      } else if (original['deleted'] === true && !now.deleted) {
        await deleteLoan(db, loanId, maintainer, new Date(), why);
        result.removed++;
        continue;
      }
    }
    if ((await currentValues(db, loanId)).deleted) continue;

    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(original)) {
      if (NOT_FIELDS.has(key)) continue;
      if (same(now.values[key], lastSet[key])) patch[key] = original[key];
      else if (!same(now.values[key], original[key])) result.skipped.push(`loan #${loanId}: ${key}`);
    }
    // The trust label goes back only if nobody else has moved it since.
    const trust = 'trust' in original && now.trust === lastSet['trust'] ? (original['trust'] as Trust) : undefined;
    if (Object.keys(patch).length === 0 && trust === undefined) continue;

    const changed = await updateLoan(db, loanId, parseLoanFields(patch), maintainer, { trust, reason: why });
    if (changed.length > 0 || trust !== undefined) result.reverted++;
  }
  return result;
}
