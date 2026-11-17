import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { block, isAdmin, isBlocked, listBlocks, rollbackActor, unblock } from '../src/db/admin';
import { createLoan, deleteLoan, parseLoanFields, restoreLoan, updateLoan } from '../src/db/edits';
import * as q from '../src/db/queries';
import { tempDatabase } from './helpers';

const ANN = { id: '111', name: 'ann' };
const VANDAL = { id: '666', name: 'vandal' };
const ADMIN = { id: '999', name: 'maintainer' };

let db: D1Database;
let dispose: () => Promise<void>;
before(async () => {
  ({ db, dispose } = await tempDatabase());
});
after(() => dispose());

const add = (editor: typeof ANN, over: Record<string, unknown> = {}) =>
  createLoan(db, parseLoanFields({ lender: 'Lena', borrower: 'Bob', principal: '1,000,000', currency: 'AIC', issuedOn: '2026-08-01', status: 'In Progress', ...over }), editor);
const loan = async (id: number) => (await q.getLoan(db, id))!;
const LONG_AGO = '2000-01-01T00:00:00.000Z';

test('maintainers are named by Discord ID', () => {
  assert.equal(isAdmin('111, 999', '999'), true);
  assert.equal(isAdmin('111, 999', '99'), false);
  assert.equal(isAdmin(undefined, '999'), false);
  assert.equal(isAdmin('', ''), false);
});

test('an account can be blocked and unblocked', async () => {
  assert.equal(await isBlocked(db, VANDAL.id), false);
  await block(db, VANDAL.id, 'vandal', 'mass edits', ADMIN);
  assert.equal(await isBlocked(db, VANDAL.id), true);
  assert.deepEqual((await listBlocks(db)).map((b) => [b.actorId, b.name, b.reason, b.blockedBy]), [['666', 'vandal', 'mass edits', 'maintainer']]);
  await unblock(db, VANDAL.id);
  assert.equal(await isBlocked(db, VANDAL.id), false);
});

test('a rollback undoes one account and nobody else', async () => {
  const edited = await add(ANN, { notes: 'honest note' });
  const deleted = await add(ANN);
  const untouched = await add(ANN);

  // The vandal changes one loan (twice), deletes another and adds a fake one.
  await updateLoan(db, edited, parseLoanFields({ status: 'Breached', principal: '9' }), VANDAL);
  await updateLoan(db, edited, parseLoanFields({ status: 'Stale', notes: 'lol' }), VANDAL);
  await deleteLoan(db, deleted, VANDAL);
  const fake = await add(VANDAL, { borrower: 'Nobody', principal: '999,999,999' });
  // Ann, meanwhile, makes an honest edit elsewhere.
  await updateLoan(db, untouched, parseLoanFields({ notes: 'paid early' }), ANN);

  const result = await rollbackActor(db, VANDAL.id, LONG_AGO, ADMIN, 'vandalism');
  assert.deepEqual(result, { loans: 3, removed: 1, restored: 1, reverted: 1, skipped: [] });

  const back = await loan(edited);
  assert.deepEqual({ status: back.status, principal: back.principal, notes: back.notes }, { status: 'in_progress', principal: '1000000.00', notes: 'honest note' });
  assert.equal((await loan(deleted)).deletedAt, null, 'the deleted loan is back');
  assert.ok((await loan(fake)).deletedAt, 'the fake loan is gone');
  assert.equal((await loan(untouched)).notes, 'paid early', "Ann's edit stands");

  // The rollback is in the history, as the system, with the reason; the vandal's own entries stay as a record.
  const [latest, ...earlier] = await q.getRevisions(db, 'loan', edited);
  assert.deepEqual({ actorType: latest!.actorType, actor: latest!.actor }, { actorType: 'system', actor: 'rollback' });
  assert.equal((latest!.after as Record<string, unknown>)['reason'], 'Rolled back by maintainer: vandalism');
  assert.equal(earlier.filter((r) => r.actor === 'vandal').length, 2);

  // Running it again finds nothing left to do.
  const again = await rollbackActor(db, VANDAL.id, LONG_AGO, ADMIN);
  assert.deepEqual({ removed: again.removed, restored: again.restored, reverted: again.reverted }, { removed: 0, restored: 0, reverted: 0 });
});

test('a field someone else has changed since is left alone and reported', async () => {
  const id = await add(ANN);
  await updateLoan(db, id, parseLoanFields({ status: 'Breached', notes: 'vandal note' }), VANDAL);
  // Ann corrects the status herself before the rollback; the note is still the vandal's.
  await updateLoan(db, id, parseLoanFields({ status: 'Overdue' }), ANN);

  const result = await rollbackActor(db, VANDAL.id, LONG_AGO, ADMIN);
  assert.deepEqual(result.skipped, [`loan #${id}: status`]);
  const now = await loan(id);
  assert.deepEqual({ status: now.status, notes: now.notes }, { status: 'overdue', notes: null });
});

test('a rollback puts back the trust label and the tracking switch the account changed', async () => {
  const id = await add(ANN, { contractId: 'TRACKME', autoTrack: true });
  await db.prepare("UPDATE loans SET trust = 'fio_verified' WHERE id = ?").bind(id).run();

  // Unticking Auto track unlocks the loan, and editing a fact relabels it Community-edited.
  await updateLoan(db, id, parseLoanFields({ autoTrack: false, status: 'Complete' }), VANDAL);
  assert.deepEqual({ trust: (await loan(id)).trust, auto: (await loan(id)).autoTrack }, { trust: 'community_edited', auto: false });

  await rollbackActor(db, VANDAL.id, LONG_AGO, ADMIN);
  const now = await loan(id);
  assert.deepEqual({ trust: now.trust, auto: now.autoTrack, status: now.status }, { trust: 'fio_verified', auto: true, status: 'in_progress' });
});

test('only changes since the given time are rolled back', async () => {
  const id = await add(ANN);
  await updateLoan(db, id, parseLoanFields({ notes: 'early' }), VANDAL, { now: new Date('2026-09-01T00:00:00Z') });
  await updateLoan(db, id, parseLoanFields({ notes: 'late' }), VANDAL, { now: new Date('2026-09-10T00:00:00Z') });

  await rollbackActor(db, VANDAL.id, '2026-09-05T00:00:00.000Z', ADMIN);
  assert.equal((await loan(id)).notes, 'early');
});

test('a loan the account deleted and someone else already restored needs nothing', async () => {
  const id = await add(ANN);
  await deleteLoan(db, id, VANDAL);
  await restoreLoan(db, id, ANN);
  const result = await rollbackActor(db, VANDAL.id, LONG_AGO, ADMIN);
  assert.deepEqual({ restored: result.restored, removed: result.removed, skipped: result.skipped.filter((s) => s.startsWith(`loan #${id}:`)) }, { restored: 0, removed: 0, skipped: [] });
  assert.equal((await loan(id)).deletedAt, null);
  assert.equal((await q.getRevisions(db, 'loan', id)).some((r) => r.actor === 'rollback'), false, 'nothing was written for it');
});

test("a lender's reports can be rolled back by the lender key's ID", async () => {
  const { reportLoan } = await import('../src/db/edits');
  await db.prepare("INSERT INTO lenders (username) VALUES ('Reporter')").run();
  const lender = (await db.prepare("SELECT id, username FROM lenders WHERE username = 'Reporter'").first<{ id: number; username: string }>())!;
  const made = await reportLoan(db, lender, 'SPAM001', parseLoanFields({ borrower: 'Victim', principal: '5', currency: 'AIC', issuedOn: '2026-08-01', status: 'Breached' }));

  const result = await rollbackActor(db, `lender:${lender.id}`, LONG_AGO, ADMIN);
  assert.equal(result.removed, 1);
  assert.ok((await loan(made.loanId)).deletedAt);
  // A lender left with no loans drops out of the lenders list.
  assert.equal((await q.listLenders(db)).some((l) => l.username === 'Reporter'), false);
});
