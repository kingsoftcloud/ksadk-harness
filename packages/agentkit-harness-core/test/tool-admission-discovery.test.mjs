import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { NativeKernel, MemoryRunStore, emptyUsage, toolDiscoveryDefinitions, discoverRejectedCalls,
  modelToolCatalog, configure, planModeToolDefinitions, todoToolDefinitions } from '../dist/index.mjs';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const policy = 'discover-before-retry/v1';
const definition = name => tool({ name, discovery: { deferred: true }, readOnly: false, concurrentSafe: false,
  parameters: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'integer' } } } });
const response = calls => ({ kind: calls.length ? 'tool_calls' : 'final_candidate', text: calls.length ? '' : 'Done',
  toolCalls: calls, usage: emptyUsage() });

for (const wrapped of [false, true]) test(`bound ${wrapped ? 'wrapped' : 'direct'} premature calls load schemas before resubmission, never execute the first batch`, async () => {
  const target = definition('bound_write');
  const { config, snapshot } = fixture({ toolDiscoveryPolicy: 'local-tool-search/v1', toolAdmissionPolicy: policy,
    tools: [...toolDiscoveryDefinitions(), target], profile: { ...fixture().config.profile, maxRetries: 0 } });
  let models = 0, executions = 0;
  const store = new MemoryRunStore();
  const kernel = new NativeKernel({ store, digest, owner: 'admission', ports: {
    model: { generate: async request => {
      models++;
      if (models === 1) {
        assert.equal(request.tools.some(tool => tool.name === target.name), false);
        return response([{ callId: 'premature', name: wrapped ? 'DeferredToolCall' : target.name,
          arguments: wrapped ? { name: target.name, input: { value: 1 } } : { value: 1 } }]);
      }
      if (models === 2) {
        assert.equal(executions, 0);
        assert.deepEqual(request.tools.find(tool => tool.name === target.name)?.parameters, target.parameters);
        const feedback = JSON.parse(request.messages.at(-1).content);
        assert.equal(feedback.executed, false);
        assert.deepEqual(feedback.loaded_tool_names, [target.name]);
        assert.equal(feedback.recovery, undefined, 'do not suggest another search for an already loaded schema');
        assert.equal(store.load(scope, 'run').snapshot.modelErrors, 0);
        return response([{ callId: 'resubmitted', name: target.name, arguments: { value: 1 } }]);
      }
      return response([]);
    } }, tools: { execute: async request => {
      assert.equal(request.call.callId, 'resubmitted'); executions++;
      return { status: 'ok', content: 'written' };
    } },
  } });
  kernel.start(snapshot, config);
  const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(models, 3); assert.equal(executions, 1);
  assert.deepEqual(done.toolDiscovery, { discovered: [target.name], promoted: [target.name] });
  assert.equal(store.load(scope, 'run').intents.some(intent => intent.kind === 'tool'
    && intent.payload.calls.some(call => call.callId === 'premature')), false);
  assert.deepEqual(store.load(scope, 'run').configuration, config);
});

test('recorded bash then incomplete TodoWrite sequence can recover without raising retry limits', async () => {
  const bash = definition('bash'), todos = todoToolDefinitions(true);
  const { config, snapshot } = fixture({ toolDiscoveryPolicy: 'local-tool-search/v1', toolAdmissionPolicy: policy,
    todoPolicy: 'session-todos/v1', tools: [...toolDiscoveryDefinitions(), bash, ...todos] });
  let models = 0, executions = 0;
  const kernel = new NativeKernel({ store: new MemoryRunStore(), digest, owner: 'recorded-sequence', ports: {
    model: { generate: async request => {
      models++;
      if (models === 1) return response([1, 2].map(n => ({ callId: 'bash-' + n, name: bash.name, arguments: { value: n } })));
      if (models === 2 || models === 3) return response([{ callId: 'todo-' + models, name: 'TodoWrite', arguments: {
        todos: [{ content: '实现流式扫描', status: 'in_progress' }] } }]);
      if (models === 4) {
        assert.match(request.messages.at(-1).content, /invalid_arguments/);
        assert.ok(request.tools.some(tool => tool.name === 'TodoWrite'));
        return response([{ callId: 'correct-todo', name: 'TodoWrite', arguments: {
          todos: [{ content: '实现流式扫描', status: 'in_progress', priority: 'high' }] } }]);
      }
      return response([]);
    } }, tools: { execute: async () => { executions++; return { status: 'ok', content: '' }; } },
  } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(models, 5); assert.equal(executions, 0);
  assert.equal(done.modelErrors, 0); assert.equal(done.todos.items[0].content, '实现流式扫描');
  assert.equal(done.todos.items[0].priority, 'high');
  assert.deepEqual(done.toolDiscovery.promoted, ['bash', 'TodoWrite']);
});

test('discovery is bounded by the current scoped catalog, wire validity, and schema budget', () => {
  const bound = ['small', 'forbidden', 'large'].map(definition);
  bound[2].description = '"'.repeat(3000);
  const controls = toolDiscoveryDefinitions();
  const { config, snapshot } = fixture({ toolDiscoveryPolicy: 'local-tool-search/v1', toolAdmissionPolicy: policy,
    tools: [...controls, ...bound], limits: { maxToolResultBytes: 1024 },
    contract: { objective: 'Scoped', allowedToolNames: [...controls.map(t => t.name), 'small', 'large'] } });
  const direct = name => ({ callId: name, name, arguments: {} });
  for (const calls of [[direct('forbidden')], [direct('unknown')], [direct('large')],
    [{ ...direct('small'), wireArgumentsInvalid: true }],
    [{ ...direct('DeferredToolCall'), arguments: { name: 'small', input: {}, forged: true } }]]) {
    assert.equal(discoverRejectedCalls(snapshot, config, calls, config.tools), null);
  }
  assert.equal(discoverRejectedCalls(snapshot, config, [direct('small')], controls), null,
    'a per-turn withheld tool cannot be loaded through the frozen catalog');
  const found = discoverRejectedCalls(snapshot, config, [direct('small'), direct('small')], config.tools);
  assert.deepEqual(found.names, ['small']);
  const updated = { ...snapshot, toolDiscovery: found.state };
  assert.equal(discoverRejectedCalls(updated, config, [direct('small')], config.tools), null);
  const many = Array.from({ length: 25 }, (_, n) => definition('tool_' + n));
  const setup = fixture({ toolDiscoveryPolicy: 'local-tool-search/v1', toolAdmissionPolicy: policy,
    tools: [...controls, ...many] });
  assert.equal(discoverRejectedCalls(setup.snapshot, setup.config, many.map(t => direct(t.name)), setup.config.tools).names.length, 20);
  assert.throws(() => fixture({ toolAdmissionPolicy: policy }), /invalid_tool_admission_policy/);
  assert.throws(() => fixture({ toolAdmissionPolicy: 'unknown' }), /invalid_tool_admission_policy/);
  const historical = fixture({ toolDiscoveryPolicy: 'local-tool-search/v1', tools: [...controls, definition('small')] });
  assert.equal(discoverRejectedCalls(historical.snapshot, historical.config, [direct('small')], historical.config.tools), null);
  assert.equal(Object.hasOwn(configure(historical.config), 'toolAdmissionPolicy'), false);
});

for (const provider of ['wrapper', 'direct', 'anthropic']) test(`${provider}: mixed unknown calls still exhaust protocol retries without dispatch`, async () => {
  const controls = toolDiscoveryDefinitions(), target = definition('bound_write');
  const { config, snapshot } = fixture({ toolDiscoveryPolicy: 'local-tool-search/v1', toolAdmissionPolicy: policy,
    tools: [...controls, target], profile: { ...fixture().config.profile, maxRetries: 0,
      ...(provider === 'direct' ? { discoveredToolExposure: 'direct-after-search/v1' } : {}),
      ...(provider === 'anthropic' ? { providerFamily: 'anthropic-messages', providerToolSearchPolicy: 'anthropic-deferred/v1' } : {}) } });
  const kernel = new NativeKernel({ store: new MemoryRunStore(), digest, owner: 'mixed', ports: {
    model: { generate: async () => response([{ callId: 'bound', name: target.name, arguments: { value: 1 } },
      { callId: 'unknown', name: 'unknown', arguments: {} }]) },
    tools: { execute: async () => assert.fail('The entire rejected batch must remain unexecuted') },
  } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.reason, 'tool_call_not_advertised_retry_exhausted');
  assert.equal(done.usage.toolCalls, 0); assert.equal(done.usage.modelCalls, 1);
});

for (const plan of [false, true]) test(`SQLite cold resume retains loaded metadata; ${plan ? 'Plan mode still denies writes' : 'approval and schema validation still apply'}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-admission-cold-')), filename = join(directory, 'run.sqlite');
  let store = new SqliteRunStore(filename), paused = false, executions = 0, models = 0, kernel;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = definition('bound_write');
  const { config, snapshot } = fixture({ toolDiscoveryPolicy: 'local-tool-search/v1', toolAdmissionPolicy: policy,
    tools: [...toolDiscoveryDefinitions(), target, ...(plan ? planModeToolDefinitions(true) : [])],
    ...(plan ? { planModePolicy: 'session-plan/v1', planModeInitialActive: true } : {}) });
  const ports = { model: { generate: async request => {
    models++;
    if (models === 1) return response([{ callId: 'premature', name: target.name, arguments: { value: 1 } }]);
    assert.deepEqual(request.tools.find(t => t.name === target.name)?.parameters, target.parameters);
    if (models === 2) return response([{ callId: 'bad-input', name: target.name, arguments: { value: 'invalid' } }]);
    if (models === 3) {
      assert.match(request.messages.at(-1).content, /invalid_arguments/);
      return response([{ callId: 'valid', name: target.name, arguments: { value: 1 } }]);
    }
    if (plan) assert.match(request.messages.at(-1).content, /plan_mode_write_denied/);
    return response([]);
  } }, tools: { execute: async request => {
    assert.equal(plan, false); assert.equal(request.call.callId, 'valid');
    if (!request.interaction) return { status: 'approval_required', content: {}, interactionId: 'approval' };
    executions++; return { status: 'ok', content: 'written' };
  } } };
  kernel = new NativeKernel({ store, digest, owner: 'before', ports, onCheckpoint: async snapshot => {
    if (!paused && snapshot.toolDiscovery.promoted.includes(target.name)) {
      paused = true; kernel.submit(scope, 'run', { commandId: 'pause', kind: 'pause', payload: {} });
    }
  } });
  kernel.start(snapshot, config);
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'paused'); assert.equal(executions, 0);
  store.close(); store = new SqliteRunStore(filename);
  kernel = new NativeKernel({ store, digest, owner: 'after', ports }); kernel.attach(scope, 'run');
  kernel.submit(scope, 'run', { commandId: 'resume', kind: 'resume', payload: {} });
  let done = await kernel.runUntilIdle(scope, 'run');
  if (!plan) {
    assert.equal(done.phase, 'awaiting_interaction'); assert.equal(executions, 0);
    kernel.submit(scope, 'run', { commandId: 'allow', kind: 'submit_interaction', payload: {
      interactionId: done.pendingInteraction.interactionId, decision: 'allow' } });
    done = await kernel.runUntilIdle(scope, 'run');
  }
  assert.equal(done.phase, 'completed'); assert.equal(executions, plan ? 0 : 1); assert.equal(models, 4);
  assert.deepEqual(store.load(scope, 'run').configuration, config);
  const next = kernel.start({ ...snapshot, runId: 'next', turnId: 'next' }, config);
  assert.equal(modelToolCatalog(next, config).some(tool => tool.name === target.name), true);
});
