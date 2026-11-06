import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, emptyUsage, normalizeHostApprovalOutcome, approvalOutcomePauseReason } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

function setup(t, backend, durable, policy = 'owner-outcome/v1') {
  const directory = mkdtempSync(join(tmpdir(), 'approval-outcome-')), path = join(directory, 'runs.sqlite');
  let store = backend === 'sqlite' ? new SqliteRunStore(path) : new MemoryRunStore();
  let models = 0, invocations = 0, writes = 0;
  const ports = { model: { generate: async () => (++models === 1
    ? { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'write', name: 'write', arguments: {} }], usage: emptyUsage() }
    : { kind: 'final_candidate', text: '已核对操作结果。', toolCalls: [], usage: emptyUsage() }) },
  tools: { ...(durable ? { approvalPolicy: 'durable-preflight/v1' } : {}), execute: async request => {
    invocations++;
    const answer = durable ? store.events(scope, 'run').filter(event => event.kind === 'approval.resolved').at(-1)?.payload : request.interaction;
    if (!answer) return { status: 'approval_required', interactionId: 'permission-request', content: {},
      ...(durable ? { approvalPolicy: 'durable-preflight/v1' } : {}) };
    if (answer.decision !== 'allow') return { status: 'error', content: { reason: approvalOutcomePauseReason(answer.approvalOutcome), executed: false } };
    writes++; return { status: 'ok', content: 'written' };
  } } };
  const { config, snapshot } = fixture({ ...(policy ? { approvalOutcomePolicy: policy } : {}),
    tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false, ...(durable ? { approvalPolicy: 'durable-preflight/v1' } : {}) })] });
  const kernel = () => new NativeKernel({ store, ports, digest, owner: 'approval-owner' });
  kernel().start(snapshot, config);
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  return { kernel, get store() { return store; }, counts: () => ({ models, invocations, writes }),
    reopen() { if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(path); } } };
}

for (const backend of ['memory', 'sqlite']) for (const durable of [false, true])
for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable'])
test(`${backend}/${durable ? 'durable preflight' : 'tool-owned'}: ${outcome} keeps its cause and non-grants pause before another model or tool effect`, async t => {
  const run = setup(t, backend, durable), pending = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(pending.phase, 'awaiting_interaction', JSON.stringify({ counts: run.counts(), reason: pending.reason,
    tools: pending.messages.filter(message => message.role === 'tool') })); assert.equal(run.counts().writes, 0);
  const decision = outcome === 'allowed-once' ? 'allow' : 'deny';
  const command = { commandId: 'original-answer', kind: 'submit_interaction', payload: {
    interactionId: pending.pendingInteraction.interactionId, decision, approvalOutcome: outcome,
  } };
  run.kernel().submit(scope, 'run', command); const observed = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(run.store.events(scope, 'run').find(event => event.kind === 'approval.resolved').payload.approvalOutcome, outcome);
  if (decision === 'allow') { assert.equal(observed.phase, 'completed'); assert.equal(run.counts().writes, 1); return; }
  assert.equal(observed.phase, 'paused'); assert.equal(observed.reason, approvalOutcomePauseReason(outcome));
  assert.equal(observed.resumePhase, 'executing_tools'); assert.equal(observed.outcome, null);
  assert.deepEqual(run.counts(), { models: 1, invocations: 1, writes: 0 });
  const receipts = structuredClone(run.store.load(scope, 'run').receipts), usage = structuredClone(observed.usage);
  run.reopen(); assert.equal((await run.kernel().runUntilIdle(scope, 'run')).phase, 'paused');
  assert.equal(run.kernel().submit(scope, 'run', command).status, 'duplicate');
  assert.equal((await run.kernel().runUntilIdle(scope, 'run')).phase, 'paused');
  assert.deepEqual(run.counts(), { models: 1, invocations: 1, writes: 0 });
  assert.deepEqual(run.store.load(scope, 'run').snapshot.usage, usage);
  run.kernel().submit(scope, 'run', { commandId: 'explicit-resume-after-answer', kind: 'resume', payload: {} });
  const final = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(final.phase, 'completed'); assert.equal(final.reason, 'verification_report_missing');
  assert.deepEqual(run.counts(), { models: 2, invocations: 2, writes: 0 });
  assert.deepEqual(run.store.load(scope, 'run').receipts.slice(0, receipts.length), receipts);
});

test('unknown, contradictory and unadmitted outcomes cannot resolve or authorize a pending interaction', async t => {
  for (const policy of [undefined, 'owner-outcome/v1']) {
    const run = setup(t, 'memory', true, policy ?? null), pending = await run.kernel().runUntilIdle(scope, 'run');
    for (const [index, extra] of [
      { decision: 'allow', approvalOutcome: 'rejected' }, { decision: 'deny', approvalOutcome: 'allowed-once' },
      { decision: 'allow', approvalOutcome: 'allowed-session' }, { decision: 'deny', approvalOutcome: null },
      ...(policy ? [] : [{ decision: 'allow', approvalOutcome: 'allowed-once' }]),
    ].entries()) {
      run.kernel().submit(scope, 'run', { commandId: `invalid-${index}`, kind: 'submit_interaction',
        payload: { interactionId: pending.pendingInteraction.interactionId, ...extra } });
      assert.equal((await run.kernel().runUntilIdle(scope, 'run')).phase, 'awaiting_interaction');
      assert.equal(run.store.events(scope, 'run').some(event => event.kind === 'approval.resolved'), false);
      assert.equal(run.counts().writes, 0);
    }
  }
});

test('legacy permission decisions preserve their frozen behavior, and unknown Host answers normalize to unavailable', async t => {
  const run = setup(t, 'memory', false, null), pending = await run.kernel().runUntilIdle(scope, 'run');
  run.kernel().submit(scope, 'run', { commandId: 'legacy-deny', kind: 'submit_interaction',
    payload: { interactionId: pending.pendingInteraction.interactionId, decision: 'deny' } });
  assert.equal((await run.kernel().runUntilIdle(scope, 'run')).phase, 'completed');
  for (const value of [null, undefined, {}, 'allow', 'allowed-session', true]) assert.equal(normalizeHostApprovalOutcome(value), 'unavailable');
  assert.throws(() => fixture({ approvalOutcomePolicy: 'unknown' }), { code: 'invalid_approval_outcome_policy' });
});
