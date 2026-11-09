import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { NativeKernel, configure, initialSnapshot, canonical, emptyUsage, prepareEffect } from '../../agentkit-harness-core/dist/index.mjs';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';
import { sessionKeyFor } from '../src/native/workspace-state.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeToolReceiptAuthority } from '../src/native/tool-authority.mjs';

const scope = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const identity = { scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain' };
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

test('lost workspace read is retried with a fresh observation and does not authorize write replay', async t => {
  const { base, workspaceRoot, configFor, create } = setup(t);
  const tools = create(async () => 'allow');
  const read = tools.definitions.find(item => item.name === 'read_workspace_file');
  const write = tools.definitions.find(item => item.name === 'write_workspace_file');
  assert.equal(read.recoveryPolicy, 'safe-read/v1');
  assert.notEqual(write.recoveryPolicy, 'safe-read/v1');
  const store = new SqliteRunStore(join(base, 'read-recovery.sqlite')); t.after(() => store.close());
  const config = configFor(tools), snapshot = initialSnapshot(identity, config, digest(config));
  store.create(config, snapshot);
  const lease = store.acquire(scope, 'run', 'lost', 1, 2);
  const calls = [{ callId: 'read', name: 'read_workspace_file', arguments: { path: 'file.txt' } }];
  const batch = prepareEffect(snapshot, 'tool', 'executing_tools', { calls, interaction: null }, {
    pendingTools: calls, messages: [...snapshot.messages, { role: 'assistant', content: '', toolCalls: calls }],
  });
  store.commit(scope, 'run', lease, 1, 0, batch);
  store.claim(scope, 'run', lease, 1, batch.snapshot.pendingIntent);
  // The lost operation cannot be treated as an observation of the old bytes.
  writeFileSync(join(workspaceRoot, 'file.txt'), 'changed after interruption\n');
  const model = { generate: async request => {
    assert.match(request.messages.at(-1).content, /changed after interruption/);
    return { kind: 'final_candidate', text: 'read complete', toolCalls: [], usage: emptyUsage() };
  } };
  const kernel = new NativeKernel({ store, owner: 'replacement', digest, now: () => 100,
    ports: { model, tools, workspace: tools } });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed');
  assert.equal(result.recoveryRetriesUsed, 1);
  assert.ok(store.load(scope, 'run').events.some(event => event.kind === 'effect.recovery_scheduled'));
  assert.equal(readFileSync(join(workspaceRoot, 'file.txt'), 'utf8'), 'changed after interruption\n');
});

test('real Native ledger repairs invalid Python through the Node parser and persists both diagnostics', async t => {
  const { base, workspaceRoot, configFor, create } = setup(t), filename = join(base, 'syntax.sqlite');
  writeFileSync(join(workspaceRoot, 'source.py'), 'def f(:\n    return 1\n');
  let tools = create(async () => 'allow'), store = new SqliteRunStore(filename); t.after(() => store.close());
  const config = configFor(tools), steps = [
    ['read_workspace_file', { path: 'source.py' }], ['lint_workspace_file', { path: 'source.py' }],
    ['edit_workspace_file', { path: 'source.py', old_text: 'def f(:', new_text: 'def f():' }],
    ['lint_workspace_file', { path: 'source.py' }],
  ];
  let calls = 0;
  const model = { generate: async () => {
    const step = steps[calls++];
    return step ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: `step-${calls}`, name: step[0], arguments: step[1] }] }
      : { kind: 'final_candidate', text: 'Repaired source.py', toolCalls: [], usage: emptyUsage() };
  } };
  let kernel = new NativeKernel({ store, owner: 'first', digest, ports: { model, tools, workspace: tools } });
  kernel.start(initialSnapshot(identity, config, digest(config)), config);
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  const diagnostics = store.load(scope, 'run').receipts.flatMap(item => item.result.results ?? [])
    .filter(item => item.content?.language === 'python');
  assert.deepEqual(diagnostics.map(item => item.status), ['error', 'ok']);
  assert.equal(diagnostics[0].content.issues[0].severity, 'error');
  assert.deepEqual(diagnostics[1].content.issues, []);
  assert.equal(readFileSync(join(workspaceRoot, 'source.py'), 'utf8'), 'def f():\n    return 1\n');
  store.close(); store = new SqliteRunStore(filename); tools = create(async () => 'allow');
  kernel = new NativeKernel({ store, owner: 'replacement', digest, ports: { model, tools, workspace: tools } });
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(calls, 5);
});
function setup(t) {
  const base = mkdtempSync(join(tmpdir(), 'native-workspace-kernel-')), workspaceRoot = join(base, 'workspace'), stateDir = join(base, 'state');
  mkdirSync(workspaceRoot); writeFileSync(join(workspaceRoot, 'file.txt'), 'original\n');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const configFor = tools => configure({ profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1' },
    hostBindingDigest: 'fixture-host/v1', tools: tools.definitions, contract: { objective: 'Read and edit file.txt' } });
  const create = authorize => createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 'session', ...(authorize ? { authorize } : {}) });
  const generate = async request => {
    const receipts = request.messages.filter(message => message.role === 'tool');
    if (receipts.length < 2) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{
      callId: receipts.length ? 'edit' : 'read', name: receipts.length ? 'edit_workspace_file' : 'read_workspace_file',
      arguments: receipts.length ? { path: 'file.txt', old_text: 'original', new_text: 'updated' } : { path: 'file.txt' },
    }] };
    return { kind: 'final_candidate', text: 'Edited file.txt', toolCalls: [], usage: emptyUsage() };
  };
  return { base, workspaceRoot, stateDir, configFor, create, generate };
}

test('a lost write before its checkpoint is observed without executing it again', async t => {
  const { base, workspaceRoot, stateDir, configFor } = setup(t);
  const create = () => createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: identity.sessionId,
    authorize: async () => 'allow', enableRewind: true });
  let tools = create();
  const definition = tools.definitions.find(item => item.name === 'write_workspace_file');
  const signal = new AbortController().signal;
  const prior = { ...identity, definition, signal, executionFence: 1, operationKey: 'previous',
    call: { name: definition.name, callId: 'previous', arguments: { path: 'previous.txt', content: 'committed\n' } } };
  assert.equal((await tools.execute(prior, { assertCurrent: () => true })).status, 'ok');
  const receiptQuery = { ...prior, contract: 'agentkit.tool-receipt-observation/v1', originalOperationKey: prior.operationKey,
    originalClaimedFence: prior.executionFence, operationKey: 'observation', executionFence: 2 };
  // The earlier write published but has no final Host receipt. It remains unknown.
  assert.equal((await tools.observeReceipt(receiptQuery, { assertCurrent: () => true })).result, null);
  assert.equal((await tools.observeReceipt({ ...receiptQuery, originalClaimedFence: 999 }, { assertCurrent: () => true })).result, null);
  assert.equal((await tools.observeReceipt({ ...receiptQuery, runId: 'another', originalOperationKey: 'absent' },
    { assertCurrent: () => true })).result, null);
  await assert.rejects(tools.observeReceipt(receiptQuery, { assertCurrent: () => false }),
    { code: 'checkpoint_receipt_authority_changed' });

  const filename = join(base, 'write-recovery.sqlite');
  let store = new SqliteRunStore(filename); t.after(() => store.close());
  const config = configFor(tools), snapshot = initialSnapshot(identity, config, digest(config));
  store.create(config, snapshot);
  const beforeCrash = Date.now() - 1000;
  const lease = store.acquire(scope, 'run', 'lost', beforeCrash, 2);
  const calls = [{ callId: 'write', name: definition.name, arguments: { path: 'README.md', content: 'result\n' } }];
  const batch = prepareEffect(snapshot, 'tool', 'executing_tools', { calls, interaction: null }, {
    pendingTools: calls, messages: [...snapshot.messages, { role: 'assistant', content: '', toolCalls: calls }],
  });
  store.commit(scope, 'run', lease, beforeCrash, 0, batch);
  const operationKey = batch.snapshot.pendingIntent;
  store.claim(scope, 'run', lease, beforeCrash, operationKey);
  store.close(); store = new SqliteRunStore(filename); tools = create();
  const assertCurrent = createNativeToolReceiptAuthority({ scope, sessionId: identity.sessionId, store });
  const model = { generate: async request => {
    assert.deepEqual(JSON.parse(request.messages.at(-1).content), { code: 'workspace_mutation_not_started', executed: false });
    return { kind: 'final_candidate', text: 'The original write did not start.', toolCalls: [], usage: emptyUsage() };
  } };
  const kernel = new NativeKernel({ store, owner: 'replacement', digest,
    ports: { model, workspace: tools, tools: {
      execute: () => assert.fail('The original write cannot run again'),
      observeReceipt: request => tools.observeReceipt(request, { assertCurrent }),
    } } });
  const waiting = await kernel.runUntilIdle(scope, 'run');
  assert.equal(waiting.phase, 'awaiting_reconciliation');
  assert.equal(waiting.toolReconciliation.operationKey, operationKey);
  kernel.reconcileTool(scope, 'run', operationKey, 'observe-original');
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed');
  assert.equal(result.runId, identity.runId);
  assert.deepEqual(result.workspaceModifiedPaths, []);
  assert.deepEqual(readdirSync(workspaceRoot).sort(), ['file.txt', 'previous.txt']);
  const record = store.load(scope, 'run');
  assert.equal(record.receipts.find(receipt => receipt.operationKey === operationKey).status, 'uncertain');
  assert.equal(record.events.filter(event => event.kind === 'tool.receipt_reconciled').length, 1);
});

test('actual Native kernel and workspace port resume an approval after SQLite and port reopen', async t => {
  const { base, workspaceRoot, configFor, create, generate } = setup(t), filename = join(base, 'ledger.sqlite');
  let store = new SqliteRunStore(filename); t.after(() => store.close());
  let tools = create(); const config = configFor(tools);
  const first = new NativeKernel({ store, owner: 'first', digest, ports: { model: { generate }, tools, workspace: tools } });
  first.start(initialSnapshot(identity, config, digest(config)), config);
  const pending = await first.runUntilIdle(scope, 'run'); assert.equal(pending.phase, 'awaiting_interaction');
  assert.equal(readFileSync(join(workspaceRoot, 'file.txt'), 'utf8'), 'original\n'); store.close();
  store = new SqliteRunStore(filename); tools = create();
  const replacement = new NativeKernel({ store, owner: 'replacement', digest, ports: { model: { generate }, tools, workspace: tools } });
  replacement.submit(scope, 'run', { commandId: 'approve', kind: 'submit_interaction',
    payload: { interactionId: pending.pendingInteraction.interactionId, decision: 'allow' } });
  const result = await replacement.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.usage.toolCalls, 2);
  assert.equal(readFileSync(join(workspaceRoot, 'file.txt'), 'utf8'), 'updated\n');
  assert.deepEqual(result.workspaceModifiedPaths, ['file.txt']); assert.deepEqual(readdirSync(workspaceRoot), ['file.txt']);
});

test('a state-write failure after real publication interrupts instead of presenting a safely repeatable tool failure', async t => {
  const { base, workspaceRoot, stateDir, configFor, create, generate } = setup(t), filename = join(base, 'ledger.sqlite');
  let store = new SqliteRunStore(filename), writes = 0; t.after(() => store.close());
  const tools = create(async () => {
    writes++;
    const readStatePath = join(stateDir, sessionKeyFor('session'), 'read-state.json');
    rmSync(readStatePath); mkdirSync(readStatePath); // rename of the new state must fail after publication
    return 'allow';
  });
  const config = configFor(tools), kernel = new NativeKernel({ store, owner: 'first', digest, ports: { model: { generate }, tools, workspace: tools } });
  kernel.start(initialSnapshot(identity, config, digest(config)), config); const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(writes, 1);
  assert.equal(readFileSync(join(workspaceRoot, 'file.txt'), 'utf8'), 'updated\n');
  const receipt = store.load(scope, 'run').receipts.find(receipt => receipt.result.results?.[0]?.status === 'uncertain');
  assert.ok(receipt); assert.equal(receipt.result.results[0].content.executed, true); store.close();
  store = new SqliteRunStore(filename);
  const replacement = new NativeKernel({ store, owner: 'replacement', digest, ports: { model: { generate }, tools, workspace: tools } });
  assert.equal((await replacement.runUntilIdle(scope, 'run')).phase, 'interrupted'); assert.equal(writes, 1);
});
