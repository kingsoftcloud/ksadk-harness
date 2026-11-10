import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../src/native/child-owner.mjs';
import { nativeChildToolDefinitions } from '../src/native/child-tools.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';

const answer = (text, toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text, toolCalls, usage: emptyUsage() });
for (const sqlite of [false, true]) for (const foreground of [false, true]) for (const control of ['resume', 'cancel-child', 'cancel-parent'])
test(`${sqlite ? 'sqlite' : 'memory'}: a naturally paused ${foreground ? 'foreground' : 'background'} child preserves the join until explicit ${control}`, { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'natural-child-pause-'));
  const store = sqlite ? new SqliteRunStore(join(directory, 'runs.sqlite')) : new MemoryRunStore();
  const childScope = { ...scope, agentId: 'paused-child' }, write = tool({ name: 'write_evidence', readOnly: false, concurrentSafe: false });
  let calls = 0, writes = 0;
  const ports = { model: { generate: async () => {
    if (++calls === 1) return answer('', [{ callId: 'write-once', name: write.name, arguments: {} }]);
    if (calls === 2) return { kind: 'output_limit', text: '', toolCalls: [], usage: emptyUsage(),
      textCommitVersion: 'provider-finished-text/v1', outputBoundary: 'no-visible-output/v1' };
    return answer('Evidence from the original child');
  } }, tools: { execute: async () => { writes++; writeFileSync(join(directory, 'proof.txt'), 'original'); return { status: 'ok', content: 'written' }; } } };
  const { config: childConfig } = fixture({ profile: { ...fixture().config.profile, maxContinuations: 0 },
    contract: { objective: 'Inspect the assigned task' }, outputRecoveryPolicy: 'response-boundary/v2', outputRestartPolicy: 'per-response/v2',
    limits: { maxOutputRestarts: 0, maxModelCalls: 4, maxToolCalls: 2 }, tools: [write] });
  const makeOwner = () => createNativeChildOwner({ store, scope, childScopes: [childScope],
    resolveChild: async () => ({ scope: childScope, configuration: childConfig, ports }), restoreChild: async () => ports });
  let owner = makeOwner(), models = 0;
  const start = nativeChildToolDefinitions(['worker'])[0];
  const makeKernel = () => new NativeKernel({ store, digest, owner: 'natural-pause-parent', ports: { children: owner,
    tools: { execute: request => owner.start(request) }, model: { generate: async () => ++models === 1
      ? answer('', [{ callId: 'start', name: start.name, arguments: { role: 'worker', task: 'Inspect the assigned task', background: !foreground } }])
      : answer('Parent delivery with collected child evidence') } } });
  t.after(async () => { await owner.releaseRun({ scope, runId: 'run' }); store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [start], childLifecyclePolicy: 'owned-background/v2',
    childApprovalPolicy: 'owned-child-approval/v1', limits: { maxModelCalls: 12, maxToolCalls: 20, effectTimeoutMs: 130000 } });
  let kernel = makeKernel(); kernel.start(snapshot, config);
  const paused = await kernel.runUntilIdle(scope, 'run');
  assert.equal(paused.phase, 'paused', JSON.stringify({ reason: paused.reason, outcome: paused.outcome, calls, writes }));
  assert.equal(paused.reason, 'child_paused'); assert.equal(paused.outcome, null);
  assert.equal(models, foreground ? 1 : 2, 'background work can proceed independently until the parent joins');
  assert.equal(paused.descendantUsage.modelCalls, 0);
  assert.ok(paused.childBudgetReservations.every(item => item.settledUsageDigest === null));
  const childId = paused.childRunIds[0], child = store.load(childScope, childId);
  assert.equal(child.snapshot.phase, 'paused'); assert.equal(child.snapshot.reason, 'output_budget_exhausted');
  assert.equal(child.snapshot.usage.modelCalls, 2); assert.equal(calls, 2); assert.equal(writes, 1);
  const receipts = structuredClone(child.receipts), modelCount = models;
  owner = makeOwner(); kernel = makeKernel();
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'paused'); assert.equal(models, modelCount); assert.equal(calls, 2);
  const accepted = control === 'resume' ? kernel.resumeChild(scope, 'run', childId, 'operator-resumes-original-child')
    : control === 'cancel-child' ? kernel.cancelChild(scope, 'run', childId, 'operator-cancels-original-child')
      : kernel.submit(scope, 'run', { commandId: 'operator-cancels-parent', kind: 'cancel', payload: {} });
  assert.equal(accepted.status, 'accepted');
  const completed = await kernel.runUntilIdle(scope, 'run');
  assert.equal(completed.phase, control === 'cancel-parent' ? 'canceled' : 'completed');
  assert.equal(calls, control === 'resume' ? 3 : 2); assert.equal(writes, 1);
  assert.equal(completed.descendantUsage.modelCalls, calls); assert.equal(completed.descendantUsage.toolCalls, 1);
  assert.equal(store.load(childScope, childId).snapshot.phase, control === 'resume' ? 'completed' : 'canceled');
  assert.ok(completed.childBudgetReservations.every(item => item.settledUsageDigest));
  assert.deepEqual(store.load(childScope, childId).receipts.slice(0, receipts.length), receipts);
});

test('a process lost after observing a paused child recovers the same join without inference or a second write', { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'paused-child-lost-collection-'));
  const worker = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/native-child-crash-worker.mjs', import.meta.url)),
    directory, 'paused-collection'], { encoding: 'utf8', timeout: 7000 });
  assert.equal(worker.status, 0, worker.stderr);
  const store = new SqliteRunStore(join(directory, 'runs.sqlite')), childScope = { ...scope, agentId: 'child-agent' };
  let childModels = 0, parentModels = 0, writes = 0;
  const owner = createNativeChildOwner({ store, scope, childScopes: [childScope], resolveChild: async () => assert.fail('must not start another child'),
    restoreChild: async () => ({ model: { generate: async () => { childModels++; return answer('Original resumed child evidence'); } },
      tools: { execute: async () => { writes++; assert.fail('must not replay the committed write'); } } }) });
  t.after(async () => { await owner.releaseRun({ scope, runId: 'run' }); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const original = store.load(scope, 'run'), childId = original.snapshot.childRunIds[0], before = store.load(childScope, childId);
  assert.equal(before.snapshot.phase, 'paused'); assert.equal(original.intents.at(-1).status, 'running');
  const kernel = new NativeKernel({ store, digest, owner: 'replacement', ports: { children: owner,
    tools: { execute: async () => assert.fail('no new tools required') },
    model: { generate: async () => { parentModels++; return answer('Parent uses resumed child evidence'); } } } });
  const paused = await kernel.runUntilIdle(scope, 'run');
  assert.equal(paused.phase, 'paused'); assert.equal(paused.reason, 'child_paused');
  assert.equal(parentModels, 0); assert.equal(childModels, 0); assert.equal(writes, 0);
  assert.equal(readFileSync(join(directory, 'proof.txt'), 'utf8'), 'one write');
  assert.equal(kernel.resumeChild(scope, 'run', childId, 'resume-after-lost-parent').status, 'accepted');
  const completed = await kernel.runUntilIdle(scope, 'run');
  assert.equal(completed.phase, 'completed'); assert.equal(childModels, 1); assert.equal(parentModels, 1); assert.equal(writes, 0);
  assert.equal(completed.descendantUsage.modelCalls, 3); assert.equal(completed.descendantUsage.toolCalls, 1);
  assert.deepEqual(store.load(childScope, childId).receipts.slice(0, before.receipts.length), before.receipts);
});
