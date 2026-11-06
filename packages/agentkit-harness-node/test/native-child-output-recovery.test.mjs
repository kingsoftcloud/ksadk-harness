import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeKernel, MemoryRunStore, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../src/native/child-owner.mjs';
import { nativeChildToolDefinitions } from '../src/native/child-tools.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';

const response = (text, toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text, toolCalls, usage: emptyUsage() });
async function observe(store, childScope, childId, phase, idle = false) {
  for (let count = 0; count < 200; count++) {
    const record = store.load(childScope, childId);
    if (record.snapshot.phase === phase && (!idle || record.lease === null)) return record;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`child did not reach ${phase}: ${store.load(childScope, childId).snapshot.phase}`);
}

for (const backend of ['memory', 'sqlite']) for (const preempt of [false, true])
for (const crash of backend === 'sqlite' && !preempt ? [null, 'inside', 'after'] : [null])
for (const cause of !preempt && !crash ? ['output', 'provider'] : ['output'])
test(`${backend}: a ${cause}-paused child requires an owned explicit resume${preempt ? ', and cancellation preempts delivery' : ', preserving receipts and total usage'}${crash ? ` with SIGKILL ${crash} delivery` : ''}`, { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'child-output-resume-'));
  const store = backend === 'sqlite' ? new SqliteRunStore(join(directory, 'runs.sqlite')) : new MemoryRunStore();
  const childScope = { ...scope, agentId: 'output-child' }, start = nativeChildToolDefinitions(['worker'])[0];
  const write = tool({ name: 'write_evidence', readOnly: false, concurrentSafe: false });
  let calls = 0, writes = 0;
  const { config: childConfig } = fixture({ ...(cause === 'output'
    ? { outputRecoveryPolicy: 'response-boundary/v2', outputRestartPolicy: 'per-response/v2' }
    : { providerRecoveryPolicy: 'provider-recovery/v2' }),
    contract: { objective: 'Write and verify evidence' }, profile: { ...fixture().config.profile, maxContinuations: 0, maxOutputTokens: 8192,
      maxRetries: 0, maxProviderRetries: 0 },
    tools: [write], limits: { maxOutputRestarts: 0, maxModelCalls: 4, maxToolCalls: 2 } });
  const childPorts = { model: { generate: async request => {
    calls++; assert.equal(request.profile.maxOutputTokens, 8192);
    if (calls === 1) return response('', [{ callId: 'original-write', name: write.name, arguments: {} }]);
    if (calls === 2 && cause === 'provider') return { kind: 'provider_retryable_error', text: '', toolCalls: [], usage: emptyUsage() };
    if (calls === 2) return { kind: 'output_limit', text: '', toolCalls: [], usage: emptyUsage(),
      textCommitVersion: 'provider-finished-text/v1', outputBoundary: 'no-visible-output/v1' };
    return response('已保留原文件并完成核验。');
  } }, tools: { execute: async () => { writes++; writeFileSync(join(directory, 'evidence.txt'), 'original evidence');
    return { status: 'ok', content: 'written' }; } } };
  const makeOwner = restoring => createNativeChildOwner({ scope, childScopes: [childScope], store,
    resolveChild: async () => { assert.equal(restoring, false, 'cold recovery cannot create another child');
      return { scope: childScope, configuration: childConfig, ports: childPorts }; }, restoreChild: async () => childPorts });
  let owner = makeOwner(false);
  t.after(async () => { await owner.releaseRun({ scope, runId: 'run' }); store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [start], childLifecyclePolicy: 'owned-background/v2',
    limits: { maxModelCalls: 12, maxToolCalls: 20, effectTimeoutMs: 130000, leaseMs: crash ? 1000 : 30000 } });
  let held = false;
  const makeParent = () => new NativeKernel({ store, owner: 'parent-output-recovery', digest, ports: { children: owner,
    tools: { execute: request => owner.start(request) }, model: { generate: async () => response('', [{
      callId: 'start-worker', name: start.name, arguments: { role: 'worker', task: 'Write and verify evidence' },
    }]) } }, onCheckpoint: current => {
    if (!held && current.childBudgetReservations.length === 1) { held = true;
      parent.submit(scope, 'run', { commandId: 'inspect-child-boundary', kind: 'pause', payload: {} }); }
  } });
  let parent = makeParent();
  parent.start(snapshot, config); const pausedParent = await parent.runUntilIdle(scope, 'run');
  assert.equal(pausedParent.phase, 'paused');
  const childId = pausedParent.childRunIds[0], before = await observe(store, childScope, childId, 'paused', true);
  assert.equal(before.snapshot.reason, cause === 'output' ? 'output_budget_exhausted' : 'provider_unavailable'); assert.equal(calls, 2); assert.equal(writes, 1);
  assert.equal(parent.childTasks(scope, 'run')[0].canResume, true);
  assert.throws(() => parent.resumeChild(scope, 'run', 'foreign-child', 'foreign-resume'), { code: 'child_control_not_owned' });
  assert.equal(parent.resumeChild(scope, 'run', childId, 'explicit-resume-child').status, 'accepted');
  assert.equal(calls, 2, 'enqueue is not execution');
  if (crash) {
    const worker = fileURLToPath(new URL('./fixtures/native-child-control-crash-worker.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [worker, join(directory, 'runs.sqlite'), crash, 'resume', childScope.agentId],
      { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, null, result.stderr); assert.equal(result.signal, 'SIGKILL', result.stderr);
    const reopened = new SqliteRunStore(join(directory, 'runs.sqlite'));
    try {
      assert.equal(reopened.load(scope, 'run').commands.find(row => row.command.commandId === 'explicit-resume-child').consumed, crash === 'after');
      assert.equal(reopened.load(childScope, childId).commands.filter(row => row.command.kind === 'resume').length, crash === 'after' ? 1 : 0);
      assert.deepEqual(reopened.load(childScope, childId).receipts, before.receipts);
    } finally { reopened.close(); }
    const expires = store.load(scope, 'run').lease.expiresAt;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expires - Date.now() + 20)));
    assert.ok(store.load(scope, 'run').lease.expiresAt <= Date.now(), 'the crashed owner lease must actually expire');
    assert.equal(calls, 2); assert.equal(writes, 1);
    owner = makeOwner(true); parent = makeParent();
  }
  if (preempt) store.enqueue(childScope, childId, { commandId: 'cancel-before-resume-delivery', kind: 'cancel', payload: {} });
  assert.equal((await parent.runUntilIdle(scope, 'run')).phase, 'paused', 'child controls do not resume the parent');
  if (preempt) {
    assert.equal(calls, 2); assert.equal(writes, 1);
    assert.equal(store.load(childScope, childId).commands.some(row => row.command.kind === 'resume'), false);
    const applied = store.events(scope, 'run').find(event => event.kind === 'command.applied'
      && event.payload.commandId === 'explicit-resume-child');
    // The original driver may consume cancellation before the pair transaction.
    // Both a pending cancellation and an already canceled child reject resume.
    const canceled = store.load(childScope, childId).snapshot.phase === 'canceled';
    assert.equal(applied?.payload.reason, canceled ? 'child_control_result_unknown' : 'child_control_unavailable');
  } else {
    const after = await observe(store, childScope, childId, 'completed');
    assert.equal(calls, 3); assert.equal(writes, 1); assert.equal(after.snapshot.usage.modelCalls, 3);
    assert.equal(after.snapshot.usage.toolCalls, 1); assert.equal(after.configuration.profile.maxOutputTokens, 8192);
    assert.deepEqual(after.receipts.slice(0, before.receipts.length), before.receipts);
    assert.equal(readFileSync(join(directory, 'evidence.txt'), 'utf8'), 'original evidence');
    assert.equal(parent.resumeChild(scope, 'run', childId, 'explicit-resume-child').status, 'duplicate');
    await parent.runUntilIdle(scope, 'run'); assert.equal(calls, 3);
    assert.equal(store.load(childScope, childId).commands.filter(row => row.command.kind === 'resume').length, 1);
    assert.equal(store.events(scope, 'run').filter(event => event.kind === 'child.resume_requested').length, 1);
    assert.equal(parent.childTasks(scope, 'run')[0].canResume, false);
  }
});
