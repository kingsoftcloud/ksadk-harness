import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_SOURCE_CONTRACT, NativeKernel, MemoryRunStore, emptyUsage, canonical,
  collectContextContributions, contextContinuity, validateContextSource, NativeError } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';
import { refreshContextSources } from '../dist/context-source-refresh.mjs';

const source = extra => ({ contract: CONTEXT_SOURCE_CONTRACT, sourceId: 'memory', bindingDigest: 'memory/v1',
  priority: 0, timeoutMs: 1000, maxTokens: 2000, maxBytes: 131072, required: false, ...extra });
const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
const count = messages => Math.ceil(canonical(messages).length / 4);
test('model continuity bounds command history without losing an older outstanding command', () => {
  const { config, snapshot } = fixture();
  snapshot.backgroundCommands = Array.from({ length: 180 }, (_, i) => ({
    ref: { taskId: i.toString(16).padStart(64, '0'), sourceRunId: 'run', operationKey: `op-${i}` },
    notified: i !== 0,
  }));
  const before = structuredClone(snapshot.backgroundCommands);
  const projection = contextContinuity(snapshot, config);
  assert.deepEqual(projection.backgroundCommands.map(row => row.operationKey),
    ['op-0', ...Array.from({ length: 8 }, (_, i) => `op-${172 + i}`)]);
  assert.equal(projection.omittedBackgroundCommands, 171);
  assert.deepEqual(snapshot.backgroundCommands, before);
  snapshot.backgroundCommands.forEach(row => { row.notified = false; });
  const outstanding = contextContinuity(snapshot, config);
  assert.equal(outstanding.backgroundCommands.length, 32);
  assert.equal(outstanding.omittedBackgroundCommands, 148);
});
function setup(t, sqlite = false, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'context-sources-')), filename = join(root, 'runs.sqlite');
  let store = sqlite ? new SqliteRunStore(filename) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ contextSources: [source()], tools: [tool()],
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1',
      contextWindow: 8000, maxOutputTokens: 128 },
    contextPolicy: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1', enabled: true, triggerRatio: .9, targetRatio: .45,
      summaryMaxTokens: 80, maxCompactions: null, maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 }, ...overrides });
  store.create(config, snapshot);
  const ports = { tools: { execute: async () => ({ status: 'ok', content: 'Observed' }) }, model: { generate: async () => final('Delivered') },
    context: { readSource: async () => ({ items: [] }), tokens: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1',
      countText: async request => Math.ceil(request.text.length / 4), countRequest: async request => count(request.messages) } } };
  return { config, snapshot, ports, get store() { return store; }, reopen() { store.close(); store = new SqliteRunStore(filename); },
    worker: options => new NativeKernel({ store, ports, digest, owner: 'worker', ...options }) };
}

for (const sqlite of [false, true]) test(`${sqlite ? 'sqlite' : 'memory'}: each model uses a fresh source snapshot inside a persisted Context intent`, async t => {
  const run = setup(t, sqlite); let version = 1, reads = 0, models = 0;
  run.ports.context.readSource = async request => {
    reads++;
    const record = run.store.load(scope, 'run');
    assert.equal(record.snapshot.pendingIntent, request.operationKey);
    assert.equal(record.intents.find(intent => intent.operationKey === request.operationKey).status, 'running');
    assert.equal(request.executionFence, record.lease.fence);
    return { items: [{ content: 'Current memory ' + version, version, role: 'system', authority: 'approved' }] };
  };
  run.ports.tools.execute = async () => { version = 2; return { status: 'ok', content: 'Updated' }; };
  run.ports.model.generate = async request => {
    const contributions = request.messages.filter(message => message.kind === 'context_contribution');
    assert.equal(contributions.length, 1); assert.equal(contributions[0].role, 'user');
    const value = JSON.parse(contributions[0].content); assert.equal(value.trust, 'untrusted');
    assert.equal(value.item.version, ++models); assert.equal(value.item.content, 'Current memory ' + models);
    if (models === 1) return { ...final(''), kind: 'tool_calls', toolCalls: [{ callId: 'change', name: 'read', arguments: {} }] };
    return final('Delivered');
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(models, 2); assert.equal(reads, 2);
  assert.equal(result.messages.some(message => message.kind === 'context_contribution'), false);
  assert.equal(run.store.events(scope, 'run').filter(event => event.kind === 'context.planned'
    && event.payload.contributions.sources[0].admitted === 1).length, 2);
});

for (const afterModelIntent of [false, true]) test(`new lease rereads Memory after SQLite reopen ${afterModelIntent ? 'before unclaimed model dispatch' : 'after context receipt'}`, async t => {
  const run = setup(t, true); let version = 1, reads = 0, models = 0, stopped = false;
  run.ports.context.readSource = async () => { reads++; return { items: [{ version }] }; };
  await assert.rejects(run.worker({ onCheckpoint: async snapshot => {
    const pending = run.store.load(scope, 'run').intents.find(intent => intent.operationKey === snapshot.pendingIntent);
    if (!stopped && snapshot.preparedContext && (afterModelIntent ? pending?.kind === 'model' : !snapshot.pendingIntent)) {
      stopped = true; throw new Error('fixture owner exited before model dispatch');
    }
  } }).runUntilIdle(scope, 'run'), /fixture owner exited/);
  run.reopen(); version = 2;
  if (afterModelIntent) {
    const lease = run.store.acquire(scope, 'run', 'guard-audit', Date.now(), 30000);
    const record = run.store.load(scope, 'run'), intent = record.intents.find(item => item.operationKey === record.snapshot.pendingIntent);
    const batch = refreshContextSources(record.snapshot, record.configuration, intent, lease.fence);
    assert.equal(refreshContextSources(record.snapshot, record.configuration, { ...intent, status: 'running' }, lease.fence), null);
    const forged = structuredClone(batch); forged.events[0].payload.executionFence++;
    assert.throws(() => run.store.commit(scope, 'run', lease, Date.now(), record.snapshot.revision, forged), /receipt_without_claim/);
    run.store.release(scope, 'run', lease);
  }
  run.ports.model.generate = async request => {
    models++; assert.equal(JSON.parse(request.messages.find(message => message.kind === 'context_contribution').content).item.version, 2);
    return final('Fresh after recovery');
  };
  assert.equal((await run.worker().runUntilIdle(scope, 'run')).phase, 'completed');
  assert.equal(models, 1); assert.equal(reads, 2);
  assert.equal(run.store.events(scope, 'run').filter(event => event.kind === 'context.sources_invalidated').length, 1);
  const receipts = run.store.load(scope, 'run').receipts;
  assert.equal(receipts.filter(receipt => receipt.status === 'not_dispatched').length, afterModelIntent ? 1 : 0);
});

for (const required of [false, true]) test(`source timeout is ${required ? 'blocking' : 'skipped without leaking diagnostics'}`, async t => {
  const run = setup(t, false, { contextSources: [source({ required, timeoutMs: 10 })] }); let models = 0;
  run.ports.context.readSource = async () => new Promise(() => {});
  run.ports.model.generate = async request => { models++; assert.equal(request.messages.some(message => message.kind === 'context_contribution'), false); return final('Delivered'); };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, required ? 'failed' : 'completed'); assert.equal(models, required ? 0 : 1);
  if (!required) assert.equal(result.context.contributions.sources[0].status, 'skipped');
});

const timeoutRecovery = { contract: 'context-source-timeout/v1', maxRetries: 2, retryDelayMs: 1 };
for (const sqlite of [false, true]) {
  test(`${sqlite ? 'sqlite' : 'memory'}: event-loop blockage discards an overdue context result and rereads before dispatch`, async t => {
    const run = setup(t, sqlite, { contextSources: [source({ required: true, timeoutMs: 200, timeoutRecovery })] });
    let reads = 0, models = 0, blockedSignal;
    run.ports.context.readSource = async request => {
      if (++reads === 1) {
        blockedSignal = request.signal;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 240);
        return { items: [{ content: 'overdue result from a blocked event loop' }] };
      }
      assert.equal(blockedSignal.aborted, true);
      return { items: [{ content: 'fresh result after event-loop recovery' }] };
    };
    run.ports.model.generate = async request => {
      models++;
      const data = request.messages.filter(message => message.kind === 'context_contribution');
      assert.equal(data.length, 1);
      assert.equal(JSON.parse(data[0].content).item.content, 'fresh result after event-loop recovery');
      return final('Delivered');
    };
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed', result.reason);
    assert.equal(reads, 2); assert.equal(models, 1); assert.equal(result.usage.toolCalls, 0);
    assert.equal(result.context.contributions.sources[0].timeoutRetries, 1);
  });

  test(`${sqlite ? 'sqlite' : 'memory'}: timed-out context read retries with fresh data before any model request`, async t => {
    const run = setup(t, sqlite, { contextSources: [source({ required: true, timeoutMs: 30, timeoutRecovery })] });
    let reads = 0, models = 0, late, firstSignal;
    run.ports.context.readSource = async request => {
      if (++reads === 1) { firstSignal = request.signal; return new Promise(resolve => { late = resolve; }); }
      assert.equal(firstSignal.aborted, true);
      return { items: [{ content: 'fresh second read' }] };
    };
    run.ports.model.generate = async request => {
      models++;
      const data = request.messages.filter(message => message.kind === 'context_contribution');
      assert.equal(data.length, 1); assert.equal(JSON.parse(data[0].content).item.content, 'fresh second read');
      return final('Delivered');
    };
    const result = await run.worker().runUntilIdle(scope, 'run');
    late({ items: [{ content: 'stale late read must never be admitted' }] });
    assert.equal(result.phase, 'completed'); assert.equal(reads, 2); assert.equal(models, 1);
    assert.equal(result.context.contributions.sources[0].timeoutRetries, 1);
  });

  test(`${sqlite ? 'sqlite' : 'memory'}: persistent event-loop blockage pauses and permits fresh recovery without dispatching stale context`, async t => {
    const run = setup(t, sqlite, { contextSources: [source({ required: true, timeoutMs: 200, timeoutRecovery })] });
    let reads = 0, models = 0;
    run.ports.context.readSource = async () => {
      reads++;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 240);
      return { items: [{ content: 'stale overdue instruction snapshot' }] };
    };
    run.ports.model.generate = async request => {
      models++;
      const contribution = request.messages.find(message => message.kind === 'context_contribution');
      assert.equal(JSON.parse(contribution.content).item.content, 'fresh instructions after recovery');
      return final('Recovered');
    };
    const paused = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(paused.phase, 'paused'); assert.equal(paused.reason, 'context_source_unavailable');
    assert.equal(paused.outcome, null); assert.equal(reads, 3); assert.equal(models, 0);
    if (sqlite) run.reopen();
    run.ports.context.readSource = async () => { reads++; return { items: [{ content: 'fresh instructions after recovery' }] }; };
    const worker = run.worker();
    worker.submit(scope, 'run', { commandId: 'resume-after-loop-blockage', kind: 'resume', payload: {} });
    const recovered = await worker.runUntilIdle(scope, 'run');
    assert.equal(recovered.phase, 'completed', recovered.reason);
    assert.equal(recovered.runId, paused.runId); assert.equal(recovered.configDigest, paused.configDigest);
    assert.equal(reads, 4); assert.equal(models, 1); assert.equal(recovered.usage.toolCalls, 0);
  });

  test(`${sqlite ? 'sqlite' : 'memory'}: exhausted required context source pauses and resumes with a fresh read`, async t => {
    const run = setup(t, sqlite, { contextSources: [source({ required: true, timeoutMs: 30, timeoutRecovery })] });
    let reads = 0, models = 0;
    run.ports.context.readSource = async () => { reads++; return new Promise(() => {}); };
    run.ports.model.generate = async request => {
      models++; assert.equal(JSON.parse(request.messages.find(message => message.kind === 'context_contribution').content).item.version, 2);
      return final('Recovered');
    };
    const paused = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(paused.phase, 'paused'); assert.equal(paused.reason, 'context_source_unavailable');
    assert.equal(paused.resumePhase, 'preparing_context'); assert.equal(paused.outcome, null);
    assert.equal(reads, 3); assert.equal(models, 0); assert.equal(paused.usage.modelCalls, 0);
    if (sqlite) run.reopen();
    run.ports.context.readSource = async () => { reads++; return { items: [{ version: 2 }] }; };
    const checkpoints = [];
    const worker = run.worker({ onCheckpoint: snapshot => { checkpoints.push(snapshot); } });
    worker.submit(scope, 'run', { commandId: 'resume-source', kind: 'resume', payload: {} });
    const recovered = await worker.runUntilIdle(scope, 'run');
    assert.equal(recovered.phase, 'completed');
    const resumed = checkpoints.find(snapshot => snapshot.phase === 'preparing_context');
    assert.ok(resumed); assert.equal(resumed.reason, null);
    assert.equal(reads, 4); assert.equal(models, 1);
    assert.equal(recovered.goal, paused.goal); assert.equal(recovered.configDigest, paused.configDigest);
    assert.equal(recovered.usage.toolCalls, 0);
    assert.equal(run.store.events(scope, 'run').filter(event => event.kind === 'context.source_unavailable').length, 1);
  });
}

test('timeout recovery never retries an invalid or changed instruction binding', async t => {
  const run = setup(t, false, { contextSources: [source({ required: true, timeoutRecovery })] }); let reads = 0;
  run.ports.context.readSource = async () => { reads++; throw new NativeError('workspace_instruction_root_changed'); };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'failed'); assert.equal(result.reason, 'workspace_instruction_root_changed');
  assert.equal(reads, 1); assert.equal(result.usage.modelCalls, 0);
});

test('an optional timed-out context source remains optional after bounded retries', async t => {
  const run = setup(t, false, { contextSources: [source({ timeoutMs: 30, timeoutRecovery })] }); let reads = 0;
  run.ports.context.readSource = async () => { reads++; return new Promise(() => {}); };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(reads, 3);
  assert.equal(result.context.contributions.sources[0].status, 'skipped');
  assert.equal(result.context.contributions.sources[0].timeoutRetries, 2);
});

test('a timed-out token count discards its entire attempt before rereading', async () => {
  let reads = 0, counts = 0;
  const config = { contextSources: [source({ required: true, timeoutMs: 30, timeoutRecovery })],
    profile: { contextWindow: 8000, maxOutputTokens: 128 } };
  const result = await collectContextContributions({ signal: new AbortController().signal }, {}, config,
    { readSource: async () => ({ items: [{ version: ++reads }] }) },
    async () => ++counts === 1 ? new Promise(() => {}) : 10);
  assert.equal(reads, 2); assert.equal(counts, 2);
  assert.equal(JSON.parse(result.messages[0].content).item.version, 2);
});

test('caller cancellation at a source timeout cannot become another retry or a recoverable pause', async () => {
  const abort = new AbortController(); let reads = 0;
  const config = { contextSources: [source({ required: true, timeoutMs: 30, timeoutRecovery })],
    profile: { contextWindow: 8000, maxOutputTokens: 128 } };
  await assert.rejects(collectContextContributions({ signal: abort.signal }, {}, config,
    { readSource: async request => {
      reads++; request.signal.addEventListener('abort', () => abort.abort(new Error('caller stopped')), { once: true });
      return new Promise(() => {});
    } }, async () => 1), /caller stopped/);
  assert.equal(reads, 1);
});

for (const recovery of [{ ...timeoutRecovery, maxRetries: -1 }, { ...timeoutRecovery, maxRetries: 4 },
  { ...timeoutRecovery, retryDelayMs: -1 }, { ...timeoutRecovery, contract: 'unknown' }]) {
  test(`invalid context timeout recovery is rejected: ${JSON.stringify(recovery)}`, t => {
    assert.throws(() => setup(t, false, { contextSources: [source({ timeoutRecovery: recovery })] }),
      /invalid_context_source_timeout_recovery/);
  });
}

test('the complete retry span must fit inside the admitted context effect timeout', () => {
  assert.throws(() => validateContextSource(source({ timeoutMs: 1000, timeoutRecovery }), 3000),
    /invalid_context_source_timeout_recovery/);
});

test('a port error with an unavailable code cannot fabricate collector exhaustion evidence', async t => {
  const run = setup(t, false, { contextSources: [source({ required: true, timeoutRecovery })] });
  run.ports.context.readSource = async () => { throw new NativeError('context_source_unavailable'); };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'failed'); assert.equal(result.usage.modelCalls, 0);
  assert.equal(run.store.events(scope, 'run').some(event => event.kind === 'context.source_unavailable'), false);
});

test('a source timeout during compaction preserves the compaction resume phase and admitted history', async t => {
  const run = setup(t, true, { contextSources: [source({ required: true, timeoutMs: 30, timeoutRecovery })] });
  let unavailable = true, models = 0, tasks = 0;
  run.ports.context.readSource = async request => request.snapshot.phase === 'compacting' && unavailable
    ? new Promise(() => {}) : { items: [{ content: 'current rule' }] };
  run.ports.model.generate = async request => {
    models++;
    if (request.messages[0]?.kind === 'compaction_instructions') return final('Keep the task objective and current rule.');
    if (++tasks === 1) return { ...final(''), kind: 'tool_calls', toolCalls: [{ callId: 'read-before-overflow', name: 'read', arguments: {} }] };
    return tasks === 2 ? { ...final(''), kind: 'context_overflow' } : final('Recovered after compaction');
  };
  run.ports.tools.execute = async () => ({ status: 'ok', content: 'Observed historical data. '.repeat(300) });
  const paused = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(paused.phase, 'paused'); assert.equal(paused.resumePhase, 'compacting'); assert.equal(models, 2);
  const messages = structuredClone(paused.messages);
  run.reopen(); unavailable = false;
  const worker = run.worker(); worker.submit(scope, 'run', { commandId: 'resume-compaction-source', kind: 'resume', payload: {} });
  const result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed', result.reason); assert.equal(result.goal, paused.goal);
  assert.ok(result.contextState.compactions > 0); assert.equal(result.usage.toolCalls, 1);
  assert.deepEqual(result.messages.slice(0, messages.length), messages);
});

test('whole envelopes fit the bound tokenizer; oversized first item does not prevent a later small item', async t => {
  const run = setup(t, false, { contextSources: [source({ maxTokens: 200 })] });
  run.ports.context.readSource = async () => ({ items: [{ content: 'untruncatable '.repeat(1000) }, { content: 'whole small fact' }] });
  run.ports.model.generate = async request => {
    const data = request.messages.filter(message => message.kind === 'context_contribution').map(message => JSON.parse(message.content));
    assert.equal(data.length, 1); assert.equal(data[0].item.content, 'whole small fact');
    return final('Delivered');
  };
  assert.equal((await run.worker().runUntilIdle(scope, 'run')).phase, 'completed');
});

test('whole item byte limits drop oversized data while later items and mandatory input remain intact', async t => {
  const run = setup(t, false, { contextSources: [source({ maxBytes: 600 })] });
  run.ports.context.readSource = async () => ({ items: [{ content: 'too large '.repeat(100) }, { content: 'small' }] });
  run.ports.model.generate = async request => {
    const contributions = request.messages.filter(message => message.kind === 'context_contribution');
    assert.equal(contributions.length, 1); assert.equal(JSON.parse(contributions[0].content).item.content, 'small');
    assert.ok(request.messages.some(message => message.content === run.snapshot.goal));
    return final('Delivered');
  };
  assert.equal((await run.worker().runUntilIdle(scope, 'run')).phase, 'completed');
});

test('caller abort is never converted to an optional source failure or a late contribution', async () => {
  const abort = new AbortController(), request = { signal: abort.signal };
  const config = { contextSources: [source()], profile: { contextWindow: 1000, maxOutputTokens: 128 } };
  let resolve;
  const pending = collectContextContributions(request, {}, config, { readSource: async () => new Promise(done => { resolve = done; }) }, async () => 1);
  abort.abort(new Error('caller canceled')); await assert.rejects(pending, /caller canceled/);
  resolve({ items: [{ content: 'late private data' }] });
});

test('source deadline also bounds an unfinished tokenizer request', { timeout: 1000 }, async () => {
  const config = { contextSources: [source({ timeoutMs: 10 })], profile: { contextWindow: 1000, maxOutputTokens: 128 } };
  const result = await collectContextContributions({ signal: new AbortController().signal }, {}, config,
    { readSource: async () => ({ items: [{ content: 'fact' }] }) }, async () => new Promise(() => {}));
  assert.deepEqual(result.messages, []); assert.equal(result.diagnostics[0].status, 'skipped');
});
