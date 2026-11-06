import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage, completeContinuation, reduceModel, contextMessageRef,
  planNativeContext, canonical, prepareEffect, transition, outputRestartPayload } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeModelPort } from '@kingsoftcloud/agentkit-harness-node/native/model-port';
import { fixture, digest, tool, scope, acceptance, verificationReport } from './fixtures.mjs';
import { outputRecoveryMode } from '../dist/output-recovery.mjs';

const response = (text, kind = 'final_candidate', extra = {}) => ({ kind, text, toolCalls: [], usage: emptyUsage(), ...extra });
const configuration = overrides => ({ outputRecoveryPolicy: 'task-or-delivery/v1', tools: [tool()], ...overrides });
const limitedText = text => response(text, 'output_limit', { textCommitVersion: 'provider-finished-text/v1', outputBoundary: 'assistant-text/v1' });

test('v3 treats visible truncated text as unfinished work while preserving an explicitly sealed suffix chain', () => {
  const { config, snapshot } = fixture({ outputRecoveryPolicy: 'response-boundary/v3', tools: [tool()] });
  assert.equal(outputRecoveryMode(snapshot, config, true, limitedText('Let me now modify core.py.')), 'task_resume');
  assert.equal(outputRecoveryMode(snapshot, config, false, limitedText('Delivery prefix')), 'suffix');
  snapshot.messages.push({ role: 'assistant', kind: 'continuation_fragment', content: 'Delivery prefix', continuationResponseId: 'delivery' },
    { role: 'user', kind: 'continuation_observation', content: 'Continue', continuationMode: 'suffix',
      continuationPolicy: 'response-boundary/v2', continuationResponseId: 'delivery', continuationFragmentDigest: digest('Delivery prefix') });
  assert.equal(outputRecoveryMode(snapshot, config, true, limitedText('Delivery prefix')), 'suffix');
});

for (const sqlite of [false, true]) test(`v3 ${sqlite ? 'sqlite' : 'memory'}: a delivery-only admission retains exact text joining`, async t => {
  let calls = 0;
  const run = setup(t, { sqlite, options: { outputRecoveryPolicy: 'response-boundary/v3', tools: [] }, model: async request => {
    assert.deepEqual(request.tools, []);
    if (++calls === 1) return limitedText('Report line\nFinal incomplete');
    assert.equal(request.messages.at(-1).continuationMode, 'suffix');
    assert.equal(request.messages.at(-1).continuationPolicy, 'response-boundary/v2');
    return response('Final incomplete line.');
  } });
  const result = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.finalText, 'Report line\nFinal incomplete line.');
  assert.equal(result.usage.toolCalls, 0); assert.equal(calls, 2);
});

test('v3 cold reopen retains unfinished work, tools and the original single-effect ownership', async t => {
  let calls = 0, writes = 0;
  const run = setup(t, { sqlite: true, options: { outputRecoveryPolicy: 'response-boundary/v3',
    tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] },
    model: async request => {
      if (++calls === 1) return limitedText('I have read the files. Let me now write the implementation.');
      assert.ok(request.tools.some(tool => tool.name === 'write'));
      return response('', 'tool_calls', { toolCalls: [{ callId: 'write-after-reopen', name: 'write', arguments: {} }] });
    }, tools: async () => { writes++; writeFileSync(join(run.root, 'cold-result.txt'), 'one effect'); return { status: 'ok', content: 'written' }; } });
  const first = run.kernel({ onCheckpoint: async state => {
    if (state.phase === 'preparing_context' && state.messages.at(-1)?.continuationMode === 'task_resume')
      first.submit(scope, 'run', { commandId: 'pause-interrupted-work', kind: 'pause', payload: {} });
  } });
  assert.equal((await first.runUntilIdle(scope, 'run')).phase, 'paused');
  assert.equal(writes, 0); assert.equal(calls, 1);
  run.reopen();
  let resumed = 0;
  run.ports.model.generate = async request => {
    if (++resumed === 1) {
      assert.equal(request.messages.at(-1).continuationMode, 'task_resume');
      assert.ok(request.tools.some(tool => tool.name === 'write'));
      return response('', 'tool_calls', { toolCalls: [{ callId: 'write-after-reopen', name: 'write', arguments: {} }] });
    }
    assert.equal(readFileSync(join(run.root, 'cold-result.txt'), 'utf8'), 'one effect');
    return response('The implementation was written after recovery.');
  };
  run.kernel().submit(scope, 'run', { commandId: 'resume-interrupted-work', kind: 'resume', payload: {} });
  const result = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(writes, 1); assert.equal(resumed, 2);
  assert.equal(result.finalText, 'The implementation was written after recovery.');
});

for (const sqlite of [false, true]) test(`response recovery v2 ${sqlite ? 'sqlite' : 'memory'}: empty reasoning exhaustion pauses, preserves effects and requires explicit resume`, async t => {
  let calls = 0, writes = 0, recovered = false, recoveredCalls = 0;
  const budgets = [];
  const exhausted = () => response('', 'output_limit', {
    outputBoundary: 'no-visible-output/v1', textCommitVersion: 'provider-finished-text/v1', usageReported: true,
    usage: { ...emptyUsage(), outputTokens: 8192, reasoningTokens: 8192 },
  });
  const run = setup(t, { sqlite, options: {
    outputRecoveryPolicy: 'response-boundary/v2', outputRestartPolicy: 'per-response/v2',
    tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })],
    profile: { ...fixture().config.profile, maxOutputTokens: 8192, maxContinuations: 1 },
    limits: { maxOutputRestarts: 1 },
  }, model: async request => {
    calls++; budgets.push(request.profile.maxOutputTokens);
    if (recovered) return ++recoveredCalls === 1 ? exhausted() : response('已有文件保留，任务继续完成。');
    if (calls === 1) return response('', 'tool_calls', {
      toolCalls: [{ callId: 'original-write', name: 'write', arguments: {} }],
    });
    return exhausted();
  }, tools: async () => { writes++; writeFileSync(join(run.root, 'result.txt'), 'original effect');
    return { status: 'ok', content: 'written' }; } });
  const paused = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(paused.phase, 'paused'); assert.equal(paused.reason, 'output_budget_exhausted');
  assert.equal(paused.resumePhase, 'preparing_context'); assert.equal(paused.outcome, null);
  assert.equal(calls, 5); assert.equal(writes, 1); assert.equal(paused.finalText, '');
  assert.equal(paused.usage.outputTokens, 32768); assert.equal(paused.usage.reasoningTokens, 32768);
  const receipts = structuredClone(run.store.load(scope, 'run').receipts), configDigest = paused.configDigest;
  if (sqlite) run.reopen();
  assert.equal((await run.kernel().runUntilIdle(scope, 'run')).phase, 'paused');
  assert.equal(calls, 5, 'reopening or polling cannot spend another inference');
  assert.equal(run.store.load(scope, 'run').snapshot.configDigest, configDigest);
  assert.equal(readFileSync(join(run.root, 'result.txt'), 'utf8'), 'original effect');
  recovered = true;
  run.kernel().submit(scope, 'run', { commandId: 'operator-resume-output', kind: 'resume', payload: {} });
  const final = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(final.phase, 'completed'); assert.equal(final.finalText, '已有文件保留，任务继续完成。');
  assert.equal(calls, 7); assert.equal(writes, 1); assert.ok(budgets.every(value => value === 8192), 'explicit output cap is never raised');
  assert.deepEqual(run.store.load(scope, 'run').receipts.slice(0, receipts.length), receipts);
});

test('response recovery v2: cancellation after exhausted SQLite pause never replays inference or a partial tool', async t => {
  let calls = 0;
  const port = createNativeModelPort({ resolveProfile: async () => ({ protocol: 'openai-chat',
    baseUrl: 'https://model.example.test/v1', apiKey: 'fixture-key', model: 'fixture' }),
  fetchImpl: async () => {
    calls++;
    const frames = [
      { id: 'partial-output', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'incomplete', type: 'function',
        function: { name: 'read', arguments: '{"path":' } }] }, finish_reason: null }] },
      { id: 'partial-output', choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 32, total_tokens: 42 } },
    ];
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  const run = setup(t, { sqlite: true, options: {
    outputRecoveryPolicy: 'response-boundary/v2', outputRestartPolicy: 'per-response/v2',
    profile: { ...fixture().config.profile, maxContinuations: 0 }, limits: { maxOutputRestarts: 0 },
  }, model: request => port.generate(request, () => {}) });
  const paused = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(paused.phase, 'paused'); assert.equal(paused.reason, 'output_budget_exhausted');
  assert.equal(paused.pendingTools.length, 0); assert.equal(calls, 1);
  const receipts = structuredClone(run.store.load(scope, 'run').receipts);
  run.reopen(); run.kernel().submit(scope, 'run', { commandId: 'cancel-paused-output', kind: 'cancel', payload: {} });
  assert.equal((await run.kernel().runUntilIdle(scope, 'run')).phase, 'canceled'); assert.equal(calls, 1);
  assert.deepEqual(run.store.load(scope, 'run').receipts, receipts);
});

for (const allowance of [0, 1]) test(`response recovery v2: answer fragments survive exhaustion and cold resume, allowance=${allowance}`, async t => {
  const pieces = ['已核实的报告前缀：', '补充证据；']; let produced = 0;
  const run = setup(t, { sqlite: true, options: {
    outputRecoveryPolicy: 'response-boundary/v2', outputRestartPolicy: 'per-response/v2',
    profile: { ...fixture().config.profile, maxContinuations: allowance }, limits: { maxOutputRestarts: 3 },
  }, model: async () => limitedText(pieces[produced++]) });
  const paused = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(paused.phase, 'paused'); assert.equal(paused.outputRestarts, 0);
  run.reopen(); let resumed = 0;
  run.ports.model.generate = async request => { resumed++; assert.deepEqual(request.tools, []); return response('完整结论。'); };
  run.kernel().submit(scope, 'run', { commandId: 'resume-sealed-answer', kind: 'resume', payload: {} });
  const final = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(final.finalText, pieces.slice(0, allowance + 1).join('') + '完整结论。'); assert.equal(resumed, 1);
});

test('response recovery v2: explicit resume cannot replenish the total model-call budget', async t => {
  let calls = 0;
  const run = setup(t, { options: {
    outputRecoveryPolicy: 'response-boundary/v2', outputRestartPolicy: 'per-response/v2',
    profile: { ...fixture().config.profile, maxContinuations: 0 },
    limits: { maxOutputRestarts: 0, maxModelCalls: 1, finalizationReserveModelCalls: 0 },
  }, model: async () => { calls++; return response('', 'output_limit', {
    textCommitVersion: 'provider-finished-text/v1', outputBoundary: 'no-visible-output/v1',
  }); } });
  const exhausted = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(exhausted.phase, 'paused', JSON.stringify({ reason: exhausted.reason, calls,
    failures: run.store.events(scope, 'run').filter(event => event.kind.includes('failure')).map(event => event.payload) }));
  run.kernel().submit(scope, 'run', { commandId: 'resume-without-total-budget', kind: 'resume', payload: {} });
  const final = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(calls, 1); assert.equal(final.usage.modelCalls, 1); assert.equal(final.outcome, 'budget_exhausted');
});

test('response recovery v2 requires the response-boundary admission contract', () => {
  assert.throws(() => fixture({ outputRestartPolicy: 'per-response/v2' }), { code: 'invalid_output_restart_policy' });
});

for (const sqlite of [false, true]) test(`response-scoped restart ${sqlite ? 'sqlite' : 'memory'}: independent complete tool steps end the previous output-failure streak`, async t => {
  let calls = 0, tools = 0;
  const run = setup(t, { sqlite, options: { outputRecoveryPolicy: 'response-boundary/v2', outputRestartPolicy: 'per-response/v1',
    limits: { maxModelCalls: 20, maxOutputRestarts: 1 }, profile: { ...fixture().config.profile, maxContinuations: 1 } },
    model: async () => {
      calls++;
      if ([1, 2, 4, 5].includes(calls)) return response('Unfinished action', 'output_limit', {
        textCommitVersion: 'provider-finished-text/v1', outputBoundary: 'tool-call/v1' });
      if ([3, 6].includes(calls)) return response('', 'tool_calls', { toolCalls: [{ callId: `read-${calls}`, name: 'read', arguments: {} }] });
      return response('Complete answer after both steps.');
    }, tools: async () => { tools++; return { status: 'ok', content: 'evidence' }; } });
  if (sqlite) {
    const first = run.kernel({ onCheckpoint: state => {
      if (state.usage.toolCalls === 1) first.submit(scope, 'run', { commandId: 'hold-after-step', kind: 'pause', payload: {} });
    } });
    assert.equal((await first.runUntilIdle(scope, 'run')).phase, 'paused');
    run.reopen();
    run.kernel().submit(scope, 'run', { commandId: 'resume-next-step', kind: 'resume', payload: {} });
  }
  const result = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(tools, 2); assert.equal(calls, 7);
  assert.equal(result.finalText, 'Complete answer after both steps.');
  assert.equal(run.store.events(scope, 'run').filter(e => e.kind === 'output.restarted').length, 2);
  if (sqlite) { run.reopen(); assert.equal(run.store.load(scope, 'run').configuration.outputRestartPolicy, 'per-response/v1'); }
});

for (const sqlite of [false, true]) test(`response-scoped restart ${sqlite ? 'sqlite' : 'memory'}: no completed step means a bounded failure, including cold resume`, async t => {
  let calls = 0;
  const run = setup(t, { sqlite, options: { outputRecoveryPolicy: 'response-boundary/v2', outputRestartPolicy: 'per-response/v1',
    limits: { maxOutputRestarts: 1 }, profile: { ...fixture().config.profile, maxContinuations: 1 } },
    model: async () => { calls++; return response('unfinished', 'output_limit', {
      textCommitVersion: 'provider-finished-text/v1', outputBoundary: 'tool-call/v1' }); } });
  if (sqlite) {
    const first = run.kernel({ onCheckpoint: state => {
      if (state.outputRestarts === 1) first.submit(scope, 'run', { commandId: 'hold-restart', kind: 'pause', payload: {} });
    } });
    assert.equal((await first.runUntilIdle(scope, 'run')).phase, 'paused');
    run.reopen(); run.kernel().submit(scope, 'run', { commandId: 'resume-restart', kind: 'resume', payload: {} });
  }
  const result = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'continuation_budget_exhausted'); assert.equal(result.outputRestarts, 1);
  assert.equal(calls, 4); assert.equal(result.usage.toolCalls, 0); assert.equal(result.finalText, '');
});

for (const sqlite of [false, true]) test(`response boundary ${sqlite ? 'sqlite' : 'memory'}: full tool catalog cannot turn a truncated answer into new work`, async t => {
  let calls = 0;
  const run = setup(t, { sqlite, options: { outputRecoveryPolicy: 'response-boundary/v2',
    profile: { ...fixture().config.profile, providerFamily: 'anthropic-messages',
      anthropicPolicy: { contract: 'anthropic-wire/v1', midSystem: true, blockBinding: 'drop_block' },
      operatorGuidancePolicy: 'journaled-system/v1', toolCatalogPolicy: 'stable-task/v1' } },
    model: async request => {
      calls++;
      if (calls === 1) { assert.ok(request.tools.some(tool => tool.name === 'read')); return limitedText('Verified report: '); }
      assert.deepEqual(request.tools, []);
      if (calls === 2) return response('', 'tool_calls', { toolCalls: [{ callId: 'must-not-run', name: 'read', arguments: {} }] });
      if (calls === 3) return response('', 'output_limit', { textCommitVersion: 'provider-finished-text/v1', outputBoundary: 'no-visible-output/v1' });
      return response('complete.');
    } });
  const result = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(result.finalText, 'Verified report: complete.'); assert.equal(result.usage.toolCalls, 0); assert.equal(calls, 4);
  assert.equal(result.messages.some(message => message.toolCalls?.length), false);
});

for (const cancel of [false, true]) test(`response boundary: cold SQLite restore preserves the suffix contract, cancellation=${cancel}`, async t => {
  const run = setup(t, { sqlite: true, options: { outputRecoveryPolicy: 'response-boundary/v2' }, model: async () => limitedText('Persisted ') });
  const first = run.kernel({ onCheckpoint: async state => {
    if (state.messages.at(-1)?.continuationPolicy === 'response-boundary/v2' && state.phase === 'preparing_context')
      first.submit(scope, 'run', { commandId: 'pause-text', kind: 'pause', payload: {} });
  } });
  assert.equal((await first.runUntilIdle(scope, 'run')).phase, 'paused'); run.reopen();
  let resumedCalls = 0;
  run.ports.model.generate = async request => { resumedCalls++; assert.deepEqual(request.tools, []); return response('suffix.'); };
  run.kernel().submit(scope, 'run', { commandId: 'resume-text', kind: cancel ? 'cancel' : 'resume', payload: {} });
  const result = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(result.finalText, cancel ? '' : 'Persisted suffix.'); assert.equal(result.usage.toolCalls, 0);
  assert.equal(resumedCalls, cancel ? 0 : 1); assert.equal(result.phase, cancel ? 'canceled' : 'completed');
});

for (const boundary of ['tool-call/v1', undefined]) test(`response boundary: ${boundary ?? 'legacy unknown'} never seals partial tool work as an answer`, async t => {
  let calls = 0;
  const run = setup(t, { options: { outputRecoveryPolicy: 'response-boundary/v2' }, model: async request => {
    if (++calls === 1) return response('Incomplete action:', 'output_limit', { textCommitVersion: 'provider-finished-text/v1', ...(boundary ? { outputBoundary: boundary } : {}) });
    assert.ok(request.tools.some(tool => tool.name === 'read'));
    assert.equal(request.messages.at(-1).continuationMode, 'task_resume');
    return response('Fresh answer.');
  } });
  assert.equal((await run.kernel().runUntilIdle(scope, 'run')).finalText, 'Fresh answer.');
});

test('response boundary: exhausting text continuation never discards the committed report or restarts research', async t => {
  let calls = 0;
  const run = setup(t, { options: { outputRecoveryPolicy: 'response-boundary/v2', limits: { maxOutputRestarts: 3 },
    profile: { ...fixture().config.profile, maxContinuations: 1 } }, model: async () => { calls++; return limitedText('part '); } });
  const result = await run.kernel().runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'continuation_budget_exhausted'); assert.equal(result.outputRestarts, 0); assert.equal(calls, 2);
  assert.ok(result.messages.some(message => message.kind === 'continuation_fragment' && message.content === 'part '));
  assert.equal(result.finalText, '');
});

test('response boundary: compaction retains the authenticated unfinished answer in full', async () => {
  const { config, snapshot } = fixture({ outputRecoveryPolicy: 'response-boundary/v2', tools: [tool()],
    contextPolicy: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1', enabled: true, triggerRatio: .8,
      targetRatio: .5, summaryMaxTokens: 80, maxCompactions: null, maxCompactionsWithoutProgress: 3,
      minModelTurnsBetween: 0, maxSummaryRetries: 1 } });
  snapshot.messages.push({ role: 'assistant', content: 'Old research '.repeat(1000) },
    { role: 'assistant', kind: 'continuation_fragment', content: 'Report prefix ', continuationResponseId: 'sealed' },
    { role: 'user', kind: 'continuation_observation', continuationMode: 'suffix', continuationPolicy: 'response-boundary/v2',
      continuationResponseId: 'sealed', continuationFragmentDigest: digest('Report prefix '), content: 'Continue' });
  const planned = await planNativeContext(snapshot, config, [], { countRequest: async () => 10, countText: async () => 10 }, digest, true, true);
  assert.equal(planned.action, 'compact');
  for (const index of [2, 3]) assert.ok(planned.state.compaction.retainedRefs.includes(contextMessageRef(snapshot.messages[index], index, digest)));
  assert.ok(planned.state.compaction.removedRefs.includes(contextMessageRef(snapshot.messages[1], 1, digest)));
});

test('response boundary: only a full, bounded, exact unfinished-line replay is joined', () => {
  const chain = prefix => [{ role: 'assistant', kind: 'continuation_fragment', content: prefix, continuationResponseId: 'sealed' },
    { role: 'user', kind: 'continuation_observation', continuationMode: 'suffix', continuationPolicy: 'response-boundary/v2',
      continuationResponseId: 'sealed', continuationFragmentDigest: digest(prefix), content: 'Continue' }];
  assert.equal(completeContinuation(chain('first line\n019: This'), '019: This completes the line.', digest), 'first line\n019: This completes the line.');
  assert.equal(completeContinuation(chain('first line\n019: This'), ' completes the line.', digest), 'first line\n019: This completes the line.');
  for (const [prefix, suffix] of [['complete line\n', 'complete line\n'], ['short', 'short again'],
    ['first line\n019: This', 'This completes the line.'], ['long '.repeat(300), 'long '.repeat(300) + 'end']])
    assert.equal(completeContinuation(chain(prefix), suffix, digest), prefix + suffix);
  const tampered = chain('019: This'); tampered[1].continuationFragmentDigest = digest('foreign');
  assert.equal(completeContinuation(tampered, '019: This completes the line.', digest), '019: This completes the line.');
  const legacy = chain('019: This'); delete legacy[1].continuationPolicy;
  assert.equal(completeContinuation(legacy, '019: This completes the line.', digest), '019: This019: This completes the line.');
  assert.equal(completeContinuation([...chain('019: This'), { role: 'user', kind: 'steering', content: 'New task' }], 'new answer', digest), 'new answer');
});
function setup(t, { sqlite = false, options = {}, model, tools, verification } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-output-')), filename = join(root, 'run.sqlite');
  let store = sqlite ? new SqliteRunStore(filename) : new MemoryRunStore();
  const { config, snapshot } = fixture(configuration(options));
  const ports = { model: { generate: model }, tools: { execute: tools ?? (async () => assert.fail('No tool expected')) },
    ...(verification ? { verification: { verify: verification } } : {}) };
  const kernel = overrides => new NativeKernel({ store, ports, owner: 'output-owner', digest, ...overrides });
  kernel().start(snapshot, config);
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, snapshot, ports, kernel, get store() { return store; },
    reopen() { store.close(); store = new SqliteRunStore(filename); kernel().attach(scope, 'run', config); } };
}

for (const sqlite of [false, true]) {
  for (const outputRecoveryPolicy of ['task-or-delivery/v1', 'response-boundary/v3'])
  test(`${sqlite ? 'sqlite' : 'memory'} ${outputRecoveryPolicy}: interrupted work executes the real tool once and delivers a fresh verified answer`, async t => {
    let calls = 0, writes = 0;
    const run = setup(t, { sqlite, options: configuration({ outputRecoveryPolicy, tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })],
      contract: { objective: 'Write and verify', acceptance: [acceptance()] } }), model: async request => {
      calls++;
      if (calls === 1) return limitedText('Unfinished implementation plan: let me now write result.txt.');
      if (calls === 2) {
        assert.equal(request.messages.at(-1).continuationMode, 'task_resume');
        assert.doesNotMatch(request.messages.at(-1).content, /only the exact missing suffix/);
        assert.deepEqual(request.tools.map(tool => tool.name), ['write']);
        return response('', 'tool_calls', { toolCalls: [{ callId: 'write-result', name: 'write', arguments: {} }] });
      }
      assert.equal(readFileSync(join(run.root, 'result.txt'), 'utf8'), 'correct');
      return response('Actual file written and verified.');
    }, tools: async () => { writes++; writeFileSync(join(run.root, 'result.txt'), 'correct'); return { status: 'ok', content: 'written' }; },
    verification: async request => { assert.equal(readFileSync(join(run.root, 'result.txt'), 'utf8'), 'correct'); return verificationReport(request); } });
    const result = await run.kernel().runUntilIdle(scope, 'run');
    assert.equal(result.finalText, 'Actual file written and verified.'); assert.equal(result.outcome, 'verified');
    assert.equal(calls, 3); assert.equal(writes, 1); assert.equal(result.usage.toolCalls, 1);
  });
  for (const scenario of ['no_bound_tools', 'no_goal_tools', 'model_reserve', 'tool_exhausted', 'json', 'legacy']) {
    test(`${sqlite ? 'sqlite' : 'memory'}: ${scenario} preserves exact suffix delivery`, async t => {
      const options = scenario === 'no_bound_tools' ? { tools: [] }
        : scenario === 'no_goal_tools' ? { contract: { objective: 'Answer', allowedToolNames: [] } }
          : scenario === 'model_reserve' ? { limits: { maxModelCalls: 3, finalizationReserveModelCalls: 2 } }
            : scenario === 'tool_exhausted' ? { limits: { maxToolCalls: 0 } }
              : scenario === 'json' ? { contract: { objective: 'Answer', finalOutputFormat: 'json_object' } }
                : { outputRecoveryPolicy: undefined };
      let calls = 0;
      const run = setup(t, { sqlite, options, model: async request => {
        if (++calls === 1) return response(scenario === 'json' ? '{"answer":' : 'first ', 'output_limit');
        assert.equal(request.messages.at(-1).continuationMode, 'suffix');
        assert.match(request.messages.at(-1).content, /only the exact missing suffix/);
        return response(scenario === 'json' ? '42}' : 'second');
      } });
      const result = await run.kernel().runUntilIdle(scope, 'run');
      assert.equal(result.finalText, scenario === 'json' ? '{"answer":42}' : 'first second'); assert.equal(calls, 2);
    });
  }
  test(`${sqlite ? 'sqlite' : 'memory'}: unfinished planning never prefixes a fresh task answer`, async t => {
    let calls = 0;
    const run = setup(t, { sqlite, model: async () => ++calls === 1
      ? response('Unfinished plan:', 'output_limit') : response('Current answer.') });
    assert.equal((await run.kernel().runUntilIdle(scope, 'run')).finalText, 'Current answer.');
  });
  test(`${sqlite ? 'sqlite' : 'memory'}: empty limited output resumes work without executing partial tool JSON`, async t => {
    let calls = 0;
    const run = setup(t, { sqlite, model: async request => {
      if (++calls === 1) return response('', 'output_limit', { toolCalls: [{ callId: 'partial', name: 'read', arguments: {} }] });
      assert.equal(request.messages.at(-1).continuationMode, 'empty_output');
      assert.doesNotMatch(request.messages.at(-1).content, /only the exact missing suffix/);
      return response('Complete answer.');
    } });
    const result = await run.kernel().runUntilIdle(scope, 'run');
    assert.equal(result.finalText, 'Complete answer.'); assert.equal(result.usage.toolCalls, 0);
    assert.equal(result.messages.some(message => message.kind === 'continuation_fragment'), false);
  });
  test(`${sqlite ? 'sqlite' : 'memory'}: bounded restart discards unfinished text without certifying or executing it`, async t => {
    let calls = 0;
    const run = setup(t, { sqlite, options: { tools: [], limits: { maxOutputRestarts: 1 },
      profile: { ...fixture().config.profile, maxContinuations: 1 } }, model: async request => {
      if (++calls < 3) return response('{"unfinished":', 'output_limit');
      assert.equal(request.messages.at(-1).kind, 'output_limit_restart_observation');
      assert.equal(request.messages.some(message => message.kind === 'continuation_fragment'), false);
      return response('Smaller complete answer.');
    } });
    const result = await run.kernel().runUntilIdle(scope, 'run');
    assert.equal(result.finalText, 'Smaller complete answer.'); assert.equal(result.outputRestarts, 1); assert.equal(calls, 3);
  });
  test(`${sqlite ? 'sqlite' : 'memory'}: exhausted continuation and restart budgets stop further calls`, async t => {
    let calls = 0;
    const run = setup(t, { sqlite, options: { limits: { maxOutputRestarts: 1 }, profile: { ...fixture().config.profile, maxContinuations: 1 } },
      model: async () => { calls++; return response('unfinished', 'output_limit'); } });
    const result = await run.kernel().runUntilIdle(scope, 'run');
    assert.equal(result.reason, 'continuation_budget_exhausted'); assert.equal(calls, 4);
    assert.equal(result.finalText, ''); assert.equal(result.outputRestarts, 1);
  });
}

for (const mode of ['task_resume', 'suffix']) for (const cancel of [false, true]) {
  test(`SQLite cold reopen retains ${mode}; cancellation=${cancel} preempts effects`, async t => {
    let calls = 0, writes = 0;
    const run = setup(t, { sqlite: true, options: { tools: mode === 'suffix' ? [] : [tool()] }, model: async () => {
      calls++; return response('Original ', 'output_limit');
    } });
    const first = run.kernel({ onCheckpoint: async state => {
      if (state.messages.at(-1).kind === 'continuation_observation' && state.phase === 'preparing_context')
        first.submit(scope, 'run', { commandId: 'pause-at-output', kind: 'pause', payload: {} });
    } });
    assert.equal((await first.runUntilIdle(scope, 'run')).phase, 'paused');
    assert.equal(run.store.load(scope, 'run').snapshot.messages.at(-1).continuationMode, mode);
    run.reopen(); calls = 0;
    run.ports.model.generate = async () => { calls++; return mode === 'suffix' || calls > 1 ? response('answer.')
      : response('', 'tool_calls', { toolCalls: [{ callId: 'after-restore', name: 'read', arguments: {} }] }); };
    run.ports.tools.execute = async () => { writes++; writeFileSync(join(run.root, 'effect'), 'once'); return { status: 'ok', content: 'observed' }; };
    if (cancel) run.kernel().submit(scope, 'run', { commandId: 'cancel-recovery', kind: 'cancel', payload: {} });
    else run.kernel().submit(scope, 'run', { commandId: 'resume-output', kind: 'resume', payload: {} });
    const result = await run.kernel().runUntilIdle(scope, 'run');
    if (cancel) {
      assert.equal(result.phase, 'canceled'); assert.equal(calls, 0); assert.equal(writes, 0); assert.equal(existsSync(join(run.root, 'effect')), false);
    } else {
      assert.equal(result.finalText, mode === 'suffix' ? 'Original answer.' : 'answer.');
      assert.equal(writes, mode === 'suffix' ? 0 : 1); assert.equal(calls, mode === 'suffix' ? 1 : 2);
    }
  });
}

test('only contiguous matching Host identities/digests authorize suffix assembly; legacy mode defaults safely', () => {
  const fragment = { role: 'assistant', kind: 'continuation_fragment', content: 'prefix ', continuationResponseId: 'request:attempt' };
  const observation = { role: 'user', kind: 'continuation_observation', content: 'Continue',
    continuationResponseId: 'request:attempt', continuationFragmentDigest: digest('prefix ') };
  assert.equal(completeContinuation([fragment, observation], 'suffix', digest), 'prefix suffix');
  for (const changed of [{ continuationMode: 'task_resume' }, { continuationResponseId: 'foreign' },
    { continuationFragmentDigest: digest('changed') }, { role: 'assistant' }, { kind: 'model_feedback' }])
    assert.equal(completeContinuation([fragment, { ...observation, ...changed }], 'suffix', digest), 'suffix');
  assert.equal(completeContinuation([fragment, observation, { role: 'user', content: 'new input' }], 'suffix', digest), 'suffix');
  assert.equal(completeContinuation([{ ...fragment, content: 'tampered ' }, observation], 'suffix', digest), 'suffix');
});

test('existing suffix chain remains suffix even with newly available task tools', () => {
  const { config, snapshot } = fixture(configuration());
  snapshot.messages.push({ role: 'user', kind: 'continuation_observation', content: 'Legacy suffix contract' });
  const changes = reduceModel(snapshot, response('more ', 'output_limit'), config, 0, 0, digest);
  assert.equal(changes.messages.at(-1).continuationMode, 'suffix');
});

test('versioned policy is optional in old serialized configurations and changes the new digest', () => {
  const legacy = fixture().config, configured = fixture({ outputRecoveryPolicy: 'task-or-delivery/v1' }).config;
  assert.equal(Object.hasOwn(legacy, 'outputRecoveryPolicy'), false);
  assert.notEqual(digest(legacy), digest(configured));
  assert.throws(() => fixture({ outputRecoveryPolicy: 'unknown' }), { code: 'invalid_output_recovery_policy' });
});

for (const prefixCount of [1, 2, 3]) test(`restart authenticates and rebinds compacted prefix ${prefixCount}, preserving summary and counters`, async () => {
  const { config, snapshot } = fixture(configuration({ profile: { ...fixture().config.profile, maxContinuations: 0 },
    limits: { maxOutputRestarts: 1 }, contextPolicy: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1', enabled: true,
      triggerRatio: .8, targetRatio: .5, summaryMaxTokens: 80, maxCompactions: null, maxCompactionsWithoutProgress: 3,
      minModelTurnsBetween: 0, maxSummaryRetries: 1 } }));
  snapshot.messages = [{ role: 'user', content: 'Original goal' },
    { role: 'assistant', kind: 'continuation_fragment', content: 'unfinished', continuationResponseId: 'first' },
    { role: 'user', kind: 'continuation_observation', content: 'Continue', continuationResponseId: 'first', continuationFragmentDigest: digest('unfinished') }];
  snapshot.contextState = { history: { prefixCount, prefixDigest: digest(snapshot.messages.slice(0, prefixCount)),
    contractDigest: digest(config.contract), tokenizerDigest: 'counter/v1', summary: 'Observed source evidence; no committed delivery.',
    retainedRefs: snapshot.messages.slice(0, prefixCount).map((message, index) => contextMessageRef(message, index, digest)) },
    compaction: null, compactions: 3, compactionsWithoutProgress: 2, progressDigest: 'old', lastModelCall: 17 };
  const original = canonical(snapshot), changes = reduceModel(snapshot, response('still incomplete', 'output_limit'), config, 0, 0, digest);
  assert.equal(changes.phase, 'preparing_context'); assert.equal(changes.messages.length, 2);
  assert.equal(changes.contextState.history.prefixCount, 1); assert.equal(changes.contextState.compactions, 3);
  assert.equal(changes.contextState.lastModelCall, 17); assert.equal(changes.contextState.history.summary, snapshot.contextState.history.summary);
  assert.equal(canonical(snapshot), original);
  const planned = await planNativeContext({ ...snapshot, ...changes }, config, [], {
    countRequest: async () => 10, countText: async () => 10 }, digest, false, true);
  assert.equal(planned.action, 'ready'); assert.equal(planned.messages.at(-1).kind, 'output_limit_restart_observation');
  for (const damage of ['prefix', 'contract', 'refs', 'shape', 'tokenizer']) {
    const damaged = structuredClone(snapshot);
    if (damage === 'prefix') damaged.messages[0].content = 'forged';
    if (damage === 'contract') damaged.contextState.history.contractDigest = 'wrong';
    if (damage === 'refs') damaged.contextState.history.retainedRefs = ['foreign'];
    if (damage === 'shape') damaged.contextState.history.prefixCount = -1;
    if (damage === 'tokenizer') damaged.contextState.history.tokenizerDigest = 'wrong';
    const rejected = reduceModel(damaged, response('incomplete', 'output_limit'), config, 0, 0, digest);
    assert.equal(rejected.phase, 'finalizing'); assert.equal(rejected.outcome, 'blocked');
    assert.equal(rejected.messages, undefined); assert.equal(rejected.contextState, undefined);
  }
});

for (const sqlite of [false, true]) test(`${sqlite ? 'sqlite' : 'memory'}: retirement cannot rewrite a committed observation or bypass the original receipt`, t => {
  const root = mkdtempSync(join(tmpdir(), 'native-output-fence-'));
  const store = sqlite ? new SqliteRunStore(join(root, 'run.sqlite')) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ limits: { maxOutputRestarts: 1 }, profile: { ...fixture().config.profile, maxContinuations: 0 } });
  snapshot.messages = [{ role: 'user', content: 'Original goal' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'committed-tool', name: 'read', arguments: {} }] },
    { role: 'tool', callId: 'committed-tool', name: 'read', content: 'Original committed observation' },
    { role: 'assistant', kind: 'continuation_fragment', content: 'unfinished', continuationResponseId: 'response' },
    { role: 'user', kind: 'continuation_observation', content: 'Continue', continuationResponseId: 'response', continuationFragmentDigest: digest('unfinished') }];
  store.create(config, snapshot);
  const lease = store.acquire(scope, 'run', 'fence-worker', 1, 1000);
  const prepared = prepareEffect(snapshot, 'model', 'requesting_model', { purpose: 'task' });
  store.commit(scope, 'run', lease, 2, 0, prepared); store.claim(scope, 'run', lease, 3, prepared.snapshot.pendingIntent);
  const before = store.load(scope, 'run').snapshot, result = response('too large', 'output_limit');
  const changes = reduceModel(before, result, config, 4, 0, digest), after = { ...before, ...changes };
  const batch = transition(before, changes, [{ kind: 'output.restarted', payload: outputRestartPayload(before, after) }], {
    receipts: [{ operationKey: before.pendingIntent, status: 'committed', result }] });
  for (const damage of ['goal', 'tool', 'drop_tool', 'receipt', 'kind', 'counter', 'event']) {
    const invalid = structuredClone(batch);
    if (damage === 'goal') invalid.snapshot.messages[0].content = 'Changed goal';
    if (damage === 'tool') invalid.snapshot.messages[2].content = 'Forged observation';
    if (damage === 'drop_tool') invalid.snapshot.messages.splice(1, 2);
    if (damage === 'receipt') invalid.receipts = [];
    if (damage === 'kind') invalid.receipts[0].result.kind = 'final_candidate';
    if (damage === 'counter') invalid.snapshot.outputRestarts = 2;
    if (damage === 'event') invalid.events[0].payload.retiredMessages[0].content = 'Forged original output';
    assert.throws(() => store.commit(scope, 'run', lease, 4, before.revision, invalid), { code: 'transcript_is_append_only' });
    assert.equal(store.load(scope, 'run').snapshot.revision, before.revision);
  }
  const saved = store.commit(scope, 'run', lease, 4, before.revision, batch);
  assert.deepEqual(saved.messages.slice(0, 3), before.messages.slice(0, 3));
  assert.equal(store.load(scope, 'run').receipts.length, 1); assert.equal(saved.outputRestarts, 1);
});
