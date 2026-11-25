import test from 'node:test';
import assert from 'node:assert/strict';
import { splitContextContinuity } from '../dist/index.mjs';

test('continuity splits into fixed run facts and the non-empty current state', () => {
  const continuity = { schemaVersion: 'agentkit.native-context-continuity/v1', authority: 'host_record', goal: 'Fix the parser',
    goalRevision: 0, contract: { objective: 'Fix the parser' }, limits: { maxModelCalls: 40 }, hostBindingDigest: 'sha256:h',
    usage: { modelCalls: 3 }, workspaceRevision: 'sha256:w', workspaceModifiedPaths: [], pendingInteraction: null, children: [],
    backgroundCommands: [{ taskId: 'a', notified: true }, { taskId: 'b', notified: false }] };
  const { fixed, current } = splitContextContinuity(continuity);
  assert.equal(fixed.part, 'fixed');
  for (const key of ['schemaVersion', 'authority', 'goal', 'goalRevision', 'contract', 'limits', 'hostBindingDigest'])
    assert.deepEqual(fixed[key], continuity[key], key);
  assert.deepEqual(current, { part: 'current', usage: { modelCalls: 3 }, workspaceRevision: 'sha256:w',
    backgroundCommands: [{ taskId: 'b', notified: false }], reportedBackgroundCommands: 1 });
});

test('the fixed part is identical while only current state changes', () => {
  const base = { schemaVersion: 's', authority: 'host_record', goal: 'g', goalRevision: 0, contract: {}, limits: {}, hostBindingDigest: 'h' };
  const first = splitContextContinuity({ ...base, usage: { modelCalls: 1 } });
  const later = splitContextContinuity({ ...base, usage: { modelCalls: 9 }, backgroundCommands: [{ taskId: 'x', notified: true }] });
  assert.deepEqual(first.fixed, later.fixed);
  assert.notDeepEqual(first.current, later.current);
});
