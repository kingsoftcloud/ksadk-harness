import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, runKey } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope } from '../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';

test('SQLite trace views read detached status and an exact event suffix without hydrating historical receipts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-trace-view-')), file = join(directory, 'runs.sqlite');
  const store = new SqliteRunStore(file), db = new DatabaseSync(file);
  t.after(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture(); store.create(config, snapshot);
  const key = runKey(scope, 'run');
  for (const seq of [1, 2]) db.prepare('INSERT INTO native_events VALUES (?,?,?,?)').run(key, seq, 'event-' + seq,
    canonical({ runId: 'run', seq, eventId: 'event-' + seq, kind: 'model.completed', payload: { exact: 9007199254740993n } }));
  db.prepare("UPDATE native_runs SET data=json_set(data,'$.snapshot.eventSeq',2) WHERE key=?").run(key);
  db.prepare('INSERT INTO native_items VALUES (?,?,?,?)').run(key, 'receipts', 'unrelated', 'NOT JSON');
  const view = store.traceView(scope, 'run', 1);
  assert.equal(view.contract, 'agentkit.native-trace-view/v1'); assert.equal(view.snapshot.eventSeq, 2);
  assert.deepEqual(view.events.map(event => event.seq), [2]); assert.equal(view.events[0].payload.exact, 9007199254740993n);
  for (const field of ['configuration', 'receipts', 'intents', 'commands', 'commits']) assert.equal(view[field], undefined);
  for (const field of ['messages', 'preparedContext', 'contextState', 'pendingTools']) assert.equal(view.snapshot[field], undefined);
  assert.throws(() => store.load(scope, 'run'), 'execution still detects malformed authoritative receipts');
  view.snapshot.scope.userId = 'changed'; view.events[0].payload.exact = 0;
  assert.equal(store.traceView(scope, 'run', 1).snapshot.scope.userId, scope.userId);
  assert.equal(store.traceView(scope, 'run', 1).events[0].payload.exact, 9007199254740993n);
  assert.deepEqual(store.traceView(scope, 'run', 20).events, [], 'a stale reader can compare the returned head with its newer cursor');
  for (const cursor of [-1, 1.5, Infinity]) assert.throws(() => store.traceView(scope, 'run', cursor), { code: 'invalid_trace_cursor' });
  assert.throws(() => store.traceView({ ...scope, userId: 'foreign' }, 'run'), { code: 'run_not_found' });
  const cold = new SqliteRunStore(file);
  try { assert.deepEqual(cold.traceView(scope, 'run'), store.traceView(scope, 'run')); }
  finally { cold.close(); }
});
