import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EditError } from '../src/db/edits';
import { connectLender, disconnectLender, listConnectedBy } from '../src/db/lenderKeys';
import { seal, unseal } from '../src/lib/secretbox';
import type { LoanFetchResult } from '../src/sync/fio';
import { runSync, trackedLenders } from '../src/sync/run';
import { tempDatabase } from './helpers';

const ANN = { id: '111', name: 'ann' };
const BEN = { id: '222', name: 'ben' };
const SECRET = 'test-secret';

let db: D1Database;
let dispose: () => Promise<void>;

before(async () => {
  ({ db, dispose } = await tempDatabase());
  await db.prepare("INSERT INTO lenders (username, tracking_mode) VALUES ('Granted', 'fio'), ('HandEntered', 'manual')").run();
});

after(() => dispose());

test('sealed values round-trip and cannot be read with another secret or after tampering', async () => {
  const sealed = await seal('my-fio-key', SECRET);
  assert.ok(!sealed.includes('my-fio-key'));
  assert.notEqual(sealed, await seal('my-fio-key', SECRET), 'a fresh nonce each time');
  assert.equal(await unseal(sealed, SECRET), 'my-fio-key');
  assert.equal(await unseal(sealed, 'other-secret'), null);
  assert.equal(await unseal(sealed.slice(0, -2) + 'AA', SECRET), null);
  assert.equal(await unseal('garbage', SECRET), null);
});

test('connecting a key switches a lender to automatic tracking and stores only ciphertext', async () => {
  await connectLender(db, 'NewLender', await seal('key-new', SECRET), ANN);
  await connectLender(db, 'handentered', await seal('key-hand', SECRET), ANN);

  const rows = (await db.prepare('SELECT username, tracking_mode, fio_key_enc, fio_key_added_by FROM lenders ORDER BY username').all<Record<string, string | null>>()).results;
  assert.deepEqual(
    rows.map((r) => [r['username'], r['tracking_mode'], r['fio_key_added_by']]),
    [['Granted', 'fio', null], ['HandEntered', 'fio', 'ann'], ['NewLender', 'fio', 'ann']],
  );
  for (const r of rows) assert.ok(!String(r['fio_key_enc']).includes('key-'), 'the key is never stored in the clear');
  assert.deepEqual((await listConnectedBy(db, ANN.id)).map((l) => l.username), ['HandEntered', 'NewLender']);

  // The audit trail records that a key was connected, not the key.
  const audit = (await db.prepare("SELECT actor, after_json FROM revisions WHERE entity_type = 'lender'").all<{ actor: string; after_json: string }>()).results;
  assert.equal(audit.length, 2);
  assert.ok(audit.every((a) => a.actor === 'ann' && !a.after_json.includes('key-')));
});

test('each lender is fetched with their own key, falling back to the bureau key', async () => {
  const pick = async (keys: Parameters<typeof trackedLenders>[1]) => (await trackedLenders(db, keys)).map((l) => [l.username, l.key, l.ownKey]);
  assert.deepEqual(await pick({ bureauKey: 'bureau', keySecret: SECRET }), [['Granted', 'bureau', false], ['HandEntered', 'key-hand', true], ['NewLender', 'key-new', true]]);
  // No bureau key: only lenders who connected one can be fetched.
  assert.deepEqual(await pick({ keySecret: SECRET }), [['Granted', null, false], ['HandEntered', 'key-hand', true], ['NewLender', 'key-new', true]]);
  // Wrong secret (it was rotated): stored keys are unreadable, so the bureau key is used if there is one.
  assert.deepEqual(await pick({ bureauKey: 'bureau', keySecret: 'rotated' }), [['Granted', 'bureau', false], ['HandEntered', 'bureau', false], ['NewLender', 'bureau', false]]);
  const unreadable = (await trackedLenders(db, { keySecret: 'rotated' })).find((l) => l.username === 'NewLender')!;
  assert.match(unreadable.problem!, /connecting again/);
});

test('the sync uses those keys and reports a rejected or missing key per lender', async () => {
  const used: [string, string][] = [];
  const summary = await runSync(
    db,
    { keySecret: SECRET },
    {
      fetchLoans: async (key: string, lender: string): Promise<LoanFetchResult> => {
        used.push([lender, key]);
        return lender === 'NewLender' ? { lender, httpStatus: 401, contracts: null, error: 'FIO permission not granted' } : { lender, httpStatus: 200, contracts: [], error: null };
      },
      fetchCompany: async () => null,
    },
  );
  assert.deepEqual(used.sort(), [['HandEntered', 'key-hand'], ['NewLender', 'key-new']]);
  assert.equal(summary.lendersFailed, 2);
  const runs = (await db.prepare('SELECT le.username, s.http_status, s.error FROM sync_runs s JOIN lenders le ON le.id = s.lender_id ORDER BY le.username').all<Record<string, unknown>>()).results;
  assert.deepEqual(runs, [
    { username: 'Granted', http_status: null, error: 'No FIO key is available for this lender' },
    { username: 'HandEntered', http_status: 200, error: null },
    { username: 'NewLender', http_status: 401, error: 'FIO rejected the API key this lender connected' },
  ]);
});

test('only the person who connected a lender can disconnect it; the key is then gone', async () => {
  await assert.rejects(() => disconnectLender(db, 'NewLender', BEN), (err: unknown) => err instanceof EditError && err.kind === 'conflict');
  await assert.rejects(() => disconnectLender(db, 'Granted', ANN), (err: unknown) => err instanceof EditError && err.kind === 'not_found');

  await disconnectLender(db, 'newlender', ANN);
  const row = await db.prepare("SELECT tracking_mode, fio_key_enc, fio_key_added_by_id FROM lenders WHERE username = 'NewLender'").first<Record<string, unknown>>();
  assert.deepEqual(row, { tracking_mode: 'manual', fio_key_enc: null, fio_key_added_by_id: null });
  assert.deepEqual((await listConnectedBy(db, ANN.id)).map((l) => l.username), ['HandEntered']);
});
