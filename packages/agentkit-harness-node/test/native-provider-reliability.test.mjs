import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIStreamTurn } from '../src/native/model-openai-chat.mjs';
import { admitProviderCompatibilityPolicy, applyProviderChatCompatibility, explicitLiteralTypes } from '../src/native/model-provider-compat.mjs';
import { bindNativeContext } from '../src/native/context-profile.mjs';
import { NATIVE_LOCAL_RESOURCE_PROFILES, validateModelSurface } from '@kingsoftcloud/agentkit-harness-core';
import { localResourceSettings, localResourceFacts, validLocalResourceProfile } from '../src/native/local-resource-profile.mjs';

const profile = contract => ({ providerReplayMode: 'none', providerCompatibilityPolicy: { contract, rule: 'kspmas-gateway' } });
const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };
function turn({ model = 'qwen3.8-flash', contract = 'provider-compat/v3', tailId = '', finish = 'tool_calls', done = true, complete = true } = {}) {
  const state = createOpenAIStreamTurn(profile(contract), { model });
  const emit = () => {};
  const chunk = (delta, finish_reason = null) => state.consume({ data: JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) }, emit);
  chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":' } }] });
  chunk({ tool_calls: [{ index: 0, id: tailId, type: '', function: { arguments: complete ? '"a.txt"}' : '"a.txt"' } }] });
  if (finish) chunk({}, finish);
  state.consume({ data: JSON.stringify({ choices: [], usage }) }, emit);
  if (done) state.consume({ data: '[DONE]' }, emit);
  return state;
}

test('v3 assembles empty identity deltas but never executes conflicting or unfinished calls', () => {
  const result = turn().finalize();
  assert.equal(result.kind, 'tool_calls'); assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].arguments.path, 'a.txt');
  for (const options of [{ tailId: 'other' }]) {
    const bad = turn(options).finalize(); assert.equal(bad.kind, 'malformed_tool_call'); assert.deepEqual(bad.toolCalls, []);
  }
  assert.equal(turn({ complete: false }).finalize().toolCalls[0].wireArgumentsInvalid, true);
  assert.equal(turn({ contract: 'provider-compat/v2' }).finalize().kind, 'malformed_tool_call');
});

test('v4 keeps the existing stream identity, complete-call and known EOF boundaries', () => {
  const result = turn({ contract: 'provider-compat/v4' }).finalize();
  assert.equal(result.kind, 'tool_calls'); assert.equal(result.toolCalls[0].arguments.path, 'a.txt');
  assert.equal(turn({ contract: 'provider-compat/v4', tailId: 'different' }).finalize().kind, 'malformed_tool_call');
  assert.equal(turn({ contract: 'provider-compat/v4', complete: false }).finalize().toolCalls[0].wireArgumentsInvalid, true);
  assert.equal(turn({ contract: 'provider-compat/v4', model: 'minimax-m3', done: false, tailId: 'call-1' }).finalize().kind, 'tool_calls');
  assert.equal(turn({ contract: 'provider-compat/v4', model: 'unknown', done: false, tailId: 'call-1' }).finalize().kind, 'provider_retryable_error');
});

test('known MiniMax clean EOF requires finish and usage; errors and unknown providers stay incomplete', () => {
  const options = { model: 'minimax-m3', done: false, tailId: 'call-1' };
  assert.equal(turn(options).finalize().kind, 'tool_calls');
  assert.equal(turn({ ...options, model: 'minimax-m2.5' }).finalize().kind, 'tool_calls');
  // A strict profile deliberately keeps the original protocol boundary.
  const strictState = createOpenAIStreamTurn({ providerReplayMode: 'none', providerCompatibilityPolicy: { contract: 'provider-compat/v3', rule: 'strict-openai' } }, { model: 'minimax-m3' });
  strictState.consume({ data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }], usage }) }, () => {});
  assert.equal(strictState.finalize().kind, 'provider_retryable_error');
  for (const override of [{ finish: null }, { model: 'unknown' }, { model: 'minimax-m2.7' }, { contract: 'provider-compat/v2' }]) {
    const result = turn({ ...options, ...override }).finalize();
    assert.equal(result.kind, 'provider_retryable_error'); assert.deepEqual(result.toolCalls, []);
  }
  assert.equal(turn(options).finalize({ errorKind: 'provider_retryable_error', failureKind: 'network_error' }).kind, 'provider_retryable_error');
  assert.equal(turn({ ...options, complete: false }).finalize().kind, 'malformed_tool_call');
});

test('v3 leaves mandatory GLM reasoning on for both task and summary, old requests stay frozen', () => {
  const binding = { model: 'glm-5.3-flash', baseUrl: 'https://kspmas.ksyun.com/v1' };
  const payload = { model: binding.model, max_tokens: 8192, tools: [{ type: 'function', function: { name: 'read' } }], messages: [] };
  assert.equal(admitProviderCompatibilityPolicy().contract, 'provider-compat/v5');
  for (const purpose of ['task', 'compaction']) {
    const modern = applyProviderChatCompatibility(payload, { purpose, profile: profile('provider-compat/v3') }, binding);
    assert.equal(modern.thinking, undefined);
    assert.equal(applyProviderChatCompatibility(payload, { purpose, profile: profile('provider-compat/v2') }, binding).thinking.type, 'disabled');
  }
  assert.throws(() => applyProviderChatCompatibility(payload, { profile: { ...profile('provider-compat/v3'), thinkingMode: 'disabled' } }, binding), /thinking_disable_unsupported/);
});

test('new gateway GLM runs default to low reasoning before the first tool, preserving explicit and frozen settings', () => {
  const binding = { model: 'glm-5.3-flash', baseUrl: 'https://kspmas.ksyun.com/v1' };
  const payload = { messages: [], max_tokens: 131072, tool_choice: 'auto',
    tools: [{ type: 'function', function: { name: 'read' } }] };
  const request = { beforeFirstTool: true, profile: profile('provider-compat/v5') };
  const apply = (body = {}, options = {}, route = {}) =>
    applyProviderChatCompatibility({ ...payload, ...body }, { ...request, ...options }, { ...binding, ...route });
  assert.equal(apply().reasoning_effort, 'low');
  assert.equal(apply().thinking, undefined);
  assert.equal(apply().max_tokens, 131072);
  assert.equal(apply({ reasoning_effort: 'high' }).reasoning_effort, 'high');
  assert.equal(apply({}, { profile: { ...request.profile, reasoningEffort: 'max' } }).reasoning_effort, 'max');
  assert.equal(apply({ thinking: { type: 'enabled' } }).reasoning_effort, undefined);
  assert.equal(apply({}, { beforeFirstTool: undefined }).reasoning_effort, undefined);
  assert.equal(apply({}, { finalizationOnly: true }).reasoning_effort, undefined);
  assert.equal(apply({ tool_choice: 'none' }).reasoning_effort, undefined);
  assert.equal(apply({ tools: [] }).reasoning_effort, undefined);
  assert.equal(apply({}, { profile: profile('provider-compat/v4') }).reasoning_effort, undefined);
  assert.equal(apply({}, {}, { model: 'glm-5.3-flashx' }).reasoning_effort, undefined);
});

test('dialect projection types enum/const through nested schemas without mutating source or data', () => {
  const schema = { type: 'object', properties: { kind: { enum: ['file', 'web'] }, mixed: { enum: [1, 'a'] },
    actions: { type: 'array', items: { oneOf: [{ type: 'object', properties: { type: { const: 'click' } } }] } } },
    default: { enum: ['not a schema'] } };
  const before = structuredClone(schema), typed = explicitLiteralTypes(schema);
  assert.equal(typed.properties.kind.type, 'string'); assert.equal(typed.properties.mixed.type, undefined);
  assert.equal(typed.properties.actions.items.oneOf[0].properties.type.type, 'string');
  assert.equal(typed.default.type, undefined); assert.deepEqual(schema, before);
  const payload = { messages: [], tools: [{ type: 'function', function: { name: 'deliver', parameters: schema } }] };
  const wire = applyProviderChatCompatibility(payload, { profile: profile('provider-compat/v3') }, { model: 'kimi-k2.7-code' });
  assert.equal(wire.tools[0].function.parameters.properties.kind.type, 'string'); assert.deepEqual(schema, before);
});

test('development v2 extends CPU allowance while old/restricted profiles and Host overrides stay intact', () => {
  assert.equal(localResourceSettings({ profile: 'local-development/v2' }).cpuSeconds, 900);
  for (const profile of ['bounded/v1', 'local-development/v1']) assert.equal(localResourceSettings({ profile }).cpuSeconds, 120);
  assert.equal(localResourceSettings({ profile: 'local-development/v2', settings: { cpuSeconds: 3 } }).cpuSeconds, 3);
});

test('request output budgets and explicit summary caps remain separate from model capacity', () => {
  const description = { protocol: 'openai-chat', modelName: 'fixture', parameters: {}, contextWindow: 1048576, maxOutputTokens: 134144, requestOutputTokens: 8192 };
  const current = bindNativeContext({ description, adaptiveSummaryDefaults: true });
  assert.equal(current.profile.maxOutputTokens, 8192);
  assert.equal(current.policy.summaryOutputCeiling, 8192);
  assert.equal(bindNativeContext({ description, maxTokens: 16384 }).profile.maxOutputTokens, 16384);
  const explicit = bindNativeContext({ description, context: { compaction: { summaryMaxTokens: 1000 } }, adaptiveSummaryDefaults: true });
  assert.equal(explicit.policy.summaryOutputCeiling, 1000);
});

test('resource profile vocabulary is shared by execution and Core model-surface validation', () => {
  for (const profile of NATIVE_LOCAL_RESOURCE_PROFILES) {
    assert.equal(validLocalResourceProfile(profile), true);
    assert.doesNotThrow(() => validateModelSurface({ contract: 'bound-model-surface/v1', environment: { workspaceRoot: '/tmp', cwd: '/tmp',
      platform: process.platform, date: '2026-11-03', commandBackend: 'local_process', supportsImages: false,
      commandResources: localResourceFacts(profile, localResourceSettings({ profile })) } }));
  }
  assert.equal(validLocalResourceProfile('local-development/v999'), false);
});
