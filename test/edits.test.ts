import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readSession, signSession } from '../src/auth';
import { createLoan, deleteLoan, EditError, parseLoanFields, restoreLoan, updateLoan } from '../src/db/edits';
import * as q from '../src/db/queries';
import { tempDatabase } from './helpers';

const ANN = { id: '111', name: 'ann' };
const BEN = { id: '222', name: 'ben' };

let db: D1Database;
let dispose: () => Promise<void>;
let trackedId: number;

before(async () => {
  ({ db, dispose } = await tempDatabase());
  await db.batch([
    db.prepare("INSERT INTO lenders (username, tracking_mode) VALUES ('Lena', 'fio')"),
    db.prepare("INSERT INTO borrowers (username, company_code) VALUES ('Bob', 'BOB')"),
    db.prepare(
      `INSERT INTO loans (contract_id, lender_id, borrower_id, principal_minor, currency, issued_on, duration_weeks, status, trust, source, auto_track)
       VALUES ('TRACKED', 1, 1, 500000000, 'AIC', '2026-01-01', 8, 'in_progress', 'fio_verified', 'fio', 1)`,
    ),
  ]);
  trackedId = (await db.prepare("SELECT id FROM loans WHERE contract_id = 'TRACKED'").first<{ id: number }>())!.id;
});

after(() => dispose());

const rejects = (fn: () => unknown, kind: EditError['kind'], pattern: RegExp) =>
  assert.rejects(async () => fn(), (err: unknown) => err instanceof EditError && err.kind === kind && pattern.test(err.message));

test('fields are validated and normalised', () => {
  assert.deepEqual(parseLoanFields({ principal: '$25,000,000', currency: 'aic', status: 'In Progress', contractId: ' abc1234 ', notes: '  ', durationWeeks: '8.5', corpCode: '' }), {
    principalMinor: 2_500_000_000,
    currency: 'AIC',
    status: 'in_progress',
    contractId: 'ABC1234',
    notes: null,
    durationWeeks: 8.5,
    corpCode: null,
  });
  assert.equal(parseLoanFields({ currency: 'N/A' }).currency, null);
  for (const bad of [{ principal: 'lots' }, { currency: 'USD' }, { status: 'Paid' }, { issuedOn: '31/01/2026' }, { durationWeeks: '-1' }, { lender: '' }, { autoTrack: 'yes' }, { hacker: 1 }]) {
    assert.throws(() => parseLoanFields(bad), EditError, JSON.stringify(bad));
  }
});

test('a signed-in user can add a loan; it is logged and labelled community-edited', async () => {
  const id = await createLoan(db, parseLoanFields({ lender: 'NewLender', borrower: 'Carol', companyCode: 'crl', principal: '1,000,000', currency: 'NCC', issuedOn: '2026-03-01', status: 'In Progress' }), ANN);
  const loan = (await q.getLoan(db, id))!;
  assert.deepEqual(
    { lender: loan.lender, borrower: loan.borrower, principal: loan.principal, status: loan.status, trust: loan.trust, source: loan.source, autoTrack: loan.autoTrack },
    { lender: 'NewLender', borrower: { username: 'Carol', companyCode: 'CRL', corpCode: null }, principal: '1000000.00', status: 'in_progress', trust: 'community_edited', source: 'manual', autoTrack: false },
  );
  const [revision] = await q.getRevisions(db, 'loan', id);
  assert.deepEqual({ action: revision!.action, actor: revision!.actor, actorId: revision!.actorId }, { action: 'create', actor: 'ann', actorId: '111' });
  assert.equal((await q.getLoanHistory(db, id)).length, 1);
  await rejects(() => createLoan(db, parseLoanFields({ lender: 'X' }), ANN), 'invalid', /required/);
});

test('anyone signed in can edit any untracked loan; changes record before and after', async () => {
  const id = await createLoan(db, parseLoanFields({ lender: 'Lena', borrower: 'Bob', principal: '2000000', currency: 'AIC', issuedOn: '2026-02-01', status: 'In Progress' }), ANN);
  const changed = await updateLoan(db, id, parseLoanFields({ status: 'Breached', principal: '2,500,000', notes: 'missed two payments' }), BEN);
  assert.deepEqual(changed.sort(), ['notes', 'principal', 'status']);

  const loan = (await q.getLoan(db, id))!;
  assert.deepEqual({ status: loan.status, principal: loan.principal, notes: loan.notes, everBreached: loan.everBreached }, { status: 'breached', principal: '2500000.00', notes: 'missed two payments', everBreached: true });

  const [latest] = await q.getRevisions(db, 'loan', id);
  assert.equal(latest!.actor, 'ben');
  assert.deepEqual(latest!.before, { status: 'in_progress', notes: null, principal: '2000000.00' });
  assert.deepEqual(latest!.after, { status: 'breached', notes: 'missed two payments', principal: '2500000.00' });
  assert.deepEqual((await q.getLoanHistory(db, id)).map((h) => [h.oldStatus, h.newStatus, h.source]), [[null, 'in_progress', 'edit'], ['in_progress', 'breached', 'edit']]);

  // Sending the same values again changes nothing and logs nothing.
  assert.deepEqual(await updateLoan(db, id, parseLoanFields({ status: 'Breached' }), BEN), []);
  assert.equal((await q.getRevisions(db, 'loan', id)).length, 2);

  // Undo is just an edit back to the "before" values.
  await updateLoan(db, id, parseLoanFields(latest!.before as Record<string, unknown>), ANN);
  assert.equal((await q.getLoan(db, id))!.status, 'in_progress');
});

test('tracked loans only take notes, until Auto track is switched off', async () => {
  await rejects(() => updateLoan(db, trackedId, parseLoanFields({ status: 'Complete' }), ANN), 'conflict', /kept up to date from FIO/);
  await rejects(() => deleteLoan(db, trackedId, ANN), 'conflict', /cannot be deleted/);

  await updateLoan(db, trackedId, parseLoanFields({ notes: 'paying on time' }), ANN);
  let loan = (await q.getLoan(db, trackedId))!;
  assert.deepEqual({ notes: loan.notes, trust: loan.trust, status: loan.status }, { notes: 'paying on time', trust: 'fio_verified', status: 'in_progress' });

  // Switching tracking off and editing in one go is allowed; the row is then community-edited.
  await updateLoan(db, trackedId, parseLoanFields({ autoTrack: false, status: 'Complete' }), ANN);
  loan = (await q.getLoan(db, trackedId))!;
  assert.deepEqual({ autoTrack: loan.autoTrack, status: loan.status, trust: loan.trust }, { autoTrack: false, status: 'complete', trust: 'community_edited' });
});

test('contract IDs stay unique and Auto track needs one', async () => {
  const id = await createLoan(db, parseLoanFields({ lender: 'Lena', borrower: 'Bob', principal: '1', currency: 'AIC', issuedOn: '2026-02-01', status: 'Complete' }), ANN);
  await rejects(() => updateLoan(db, id, parseLoanFields({ contractId: 'tracked' }), ANN), 'conflict', /already recorded/);
  await rejects(() => updateLoan(db, id, parseLoanFields({ autoTrack: true }), ANN), 'invalid', /needs a contract ID/);
  await rejects(() => updateLoan(db, 999_999, parseLoanFields({ notes: 'x' }), ANN), 'not_found', /No such loan/);
});

test('deleting hides a loan from lists and totals, and it can be restored', async () => {
  const id = await createLoan(db, parseLoanFields({ lender: 'Solo', borrower: 'Dave', principal: '7,000,000', currency: 'ICA', issuedOn: '2026-02-01', status: 'In Progress' }), ANN);
  const dave = (await q.getBorrower(db, 'Dave'))!;
  assert.equal((await q.getBorrowerExposure(db, dave.id))[0]!.current, '7000000.00');

  await deleteLoan(db, id, BEN);
  assert.equal((await q.listLoans(db, { borrower: 'Dave', limit: 10, offset: 0 })).total, 0);
  assert.deepEqual(await q.getBorrowerExposure(db, dave.id), []);
  assert.ok((await q.getLoan(db, id))!.deletedAt);
  await rejects(() => updateLoan(db, id, parseLoanFields({ notes: 'x' }), ANN), 'conflict', /deleted/);

  await restoreLoan(db, id, ANN);
  assert.equal((await q.listLoans(db, { borrower: 'Dave', limit: 10, offset: 0 })).total, 1);

  const changes = await q.listChanges(db, { includeSystem: false, limit: 3, offset: 0 });
  assert.deepEqual(changes.map((c) => [c.action, c.actor, c.borrower]), [['update', 'ann', 'Dave'], ['delete', 'ben', 'Dave'], ['create', 'ann', 'Dave']]);
});

test('sessions are signed: tampered, foreign and expired cookies are rejected', async () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  const cookie = await signSession(ANN, 'secret-a', now);
  assert.deepEqual(await readSession(cookie, 'secret-a', now), { ...ANN, avatar: null });
  const withFace = await signSession({ ...ANN, avatar: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }, 'secret-a', now);
  assert.equal((await readSession(withFace, 'secret-a', now))!.avatar, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');

  assert.equal(await readSession(cookie, 'secret-b', now), null, 'signed with another key');
  assert.equal(await readSession(cookie, 'secret-a', now + 31 * 86_400_000), null, 'expired');
  assert.equal(await readSession(undefined, 'secret-a', now), null);
  assert.equal(await readSession('garbage', 'secret-a', now), null);

  // Swap the payload for another user's while keeping the signature.
  const forged = btoa(JSON.stringify({ id: '999', name: 'mallory', exp: now + 1e9 })).replace(/=+$/, '');
  assert.equal(await readSession(`${forged}.${cookie.split('.')[1]}`, 'secret-a', now), null, 'payload swapped');
});

const newLoan = (over: Record<string, unknown> = {}) =>
  createLoan(db, parseLoanFields({ lender: 'Lena', borrower: 'Bob', principal: '1,000,000', currency: 'AIC', issuedOn: '2026-04-01', status: 'In Progress', ...over }), ANN);

test('an edit is refused when the value changed under the editor', async () => {
  const id = await newLoan();
  // Ben saves first. Ann was still looking at "In Progress" and "1,000,000".
  await updateLoan(db, id, parseLoanFields({ status: 'Overdue' }), BEN, { expected: parseLoanFields({ status: 'In Progress' }) });
  await rejects(
    () => updateLoan(db, id, parseLoanFields({ status: 'Complete' }), ANN, { expected: parseLoanFields({ status: 'In Progress' }) }),
    'conflict',
    /Status was changed to Overdue by ben while you were editing/,
  );
  assert.equal((await q.getLoan(db, id))!.status, 'overdue', 'Ben’s value stands');

  // A different cell of the same loan is not a conflict.
  await updateLoan(db, id, parseLoanFields({ principal: '1,500,000' }), ANN, { expected: parseLoanFields({ principal: '1000000' }) });
  // Nor is making the change someone else already made.
  assert.deepEqual(await updateLoan(db, id, parseLoanFields({ status: 'Overdue' }), ANN, { expected: parseLoanFields({ status: 'In Progress' }) }), []);
  const loan = (await q.getLoan(db, id))!;
  assert.deepEqual({ status: loan.status, principal: loan.principal }, { status: 'overdue', principal: '1500000.00' });
});

test('two saves at the same moment both land, with a truthful history', async () => {
  const id = await newLoan();
  // Different cells: both are kept.
  await Promise.all([updateLoan(db, id, parseLoanFields({ notes: 'from ann' }), ANN), updateLoan(db, id, parseLoanFields({ durationWeeks: '9' }), BEN)]);
  let loan = (await q.getLoan(db, id))!;
  assert.deepEqual({ notes: loan.notes, weeks: loan.durationWeeks }, { notes: 'from ann', weeks: 9 });

  // Same cell, no "expected": last write wins, but each revision's "before" is what was really there.
  await Promise.all([updateLoan(db, id, parseLoanFields({ status: 'Overdue' }), ANN), updateLoan(db, id, parseLoanFields({ status: 'Breached' }), BEN)]);
  loan = (await q.getLoan(db, id))!;
  const statusRevisions = (await q.getRevisions(db, 'loan', id)).filter((r) => r.action === 'update' && (r.after as Record<string, unknown> | null)?.['status']).reverse();
  const chain = statusRevisions.map((r) => [(r.before as Record<string, unknown>)['status'], (r.after as Record<string, unknown>)['status']]);
  assert.equal(chain.length, 2);
  assert.equal(chain[0]![0], 'in_progress');
  assert.equal(chain[1]![0], chain[0]![1], 'the second change starts from what the first one left');
  assert.equal(chain[1]![1], loan.status);
  assert.deepEqual((await q.getLoanHistory(db, id)).map((h) => h.newStatus), ['in_progress', chain[0]![1], chain[1]![1]]);

  // Same cell, both saying what they saw: exactly one wins.
  const outcomes = await Promise.allSettled([
    updateLoan(db, id, parseLoanFields({ notes: 'ann wins' }), ANN, { expected: parseLoanFields({ notes: 'from ann' }) }),
    updateLoan(db, id, parseLoanFields({ notes: 'ben wins' }), BEN, { expected: parseLoanFields({ notes: 'from ann' }) }),
  ]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
});

test('the refresh feed returns loans changed since a time, deleted ones included', async () => {
  const id = await newLoan();
  const other = await newLoan();
  const mark = new Date(Date.now() + 5).toISOString();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(await q.listLoansUpdatedSince(db, mark), []);

  await updateLoan(db, id, parseLoanFields({ notes: 'changed' }), BEN);
  await deleteLoan(db, other, BEN);
  const changed = await q.listLoansUpdatedSince(db, mark);
  assert.deepEqual(changed.map((l) => [l.id, l.notes, Boolean(l.deletedAt)]), [[id, 'changed', false], [other, null, true]]);
});

test('adding the same contract ID twice at once gives one loan and a clear refusal', async () => {
  const add = () => newLoan({ contractId: 'RACE001' });
  const outcomes = await Promise.allSettled([add(), add()]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
  const failure = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
  assert.ok(failure.reason instanceof EditError && failure.reason.kind === 'conflict', String(failure.reason));
  assert.equal((await q.listLoans(db, { contractId: 'RACE001', limit: 5, offset: 0 })).total, 1);
});
