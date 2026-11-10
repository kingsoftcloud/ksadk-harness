import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { admitProviderCompatibilityPolicy, applyProviderChatCompatibility } from '../src/native/model-provider-compat.mjs';
import { buildNativeModelRequest } from '../src/native/model-request.mjs';

const oracle = JSON.parse(await readFile(new URL('./fixtures/native-provider-compat.json', import.meta.url), 'utf8'));
for (const item of oracle.cases) test(`provider compatibility oracle: ${item.id}`, () => {
  const payload = structuredClone(item.payload);
  const result = applyProviderChatCompatibility(payload,
    // This oracle records the v2 wire contract. New admissions now use v4;
    // changing that default must not silently upgrade the restored v2 cases.
    { purpose: item.purpose, profile: { ...item.profile, providerCompatibilityPolicy: {
      ...admitProviderCompatibilityPolicy(item.rule), contract: 'provider-compat/v2' } } },
    { model: item.model });
  assert.deepEqual(result, item.expected);
  assert.deepEqual(payload, item.payload, 'projection cannot mutate a previous attempt');
});

test('provider compatibility admission: all wires retain explicit non-stream and parallel settings', () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
    const built = buildNativeModelRequest({ protocol, model: 'model', baseUrl: 'https://model.invalid/v1', apiKey: 'fake' }, {
      profile: { maxOutputTokens: 8192, streaming: false, parallelToolCalls: false, temperature: 0.2, topP: 0.8,
        providerReplayMode: 'none', providerCompatibilityPolicy: admitProviderCompatibilityPolicy() },
      messages: [{ role: 'user', content: 'task' }], tools: [{ name: 'read', parameters: { type: 'object' } }],
      finalizationOnly: false,
    });
    const payload = JSON.parse(built.body);
    assert.equal(payload.stream, false); assert.equal(built.headers.Accept, 'application/json');
    assert.equal(payload.temperature, 0.2); assert.equal(payload.top_p, 0.8);
    if (protocol === 'anthropic-messages') assert.equal(payload.tool_choice.disable_parallel_tool_use, true);
    else assert.equal(payload.parallel_tool_calls, false);
  }
});

test('provider compatibility admission: final submission is forced and Kimi projection retains its schema', () => {
  for (const model of ['glm-5.3-flash', 'kimi-k2.7-code']) {
    const built = buildNativeModelRequest({ protocol: 'openai-chat', model, baseUrl: 'https://kspmas.invalid/v1', apiKey: 'fake' }, {
      profile: { maxOutputTokens: 8192, providerReplayMode: 'none', providerCompatibilityPolicy: admitProviderCompatibilityPolicy() },
      messages: [{ role: 'user', content: 'task' }], finalizationOnly: true,
      tools: [{ name: 'forbidden' }, { name: 'submit_final_output', parameters: { type: 'object', required: ['answer'] } }],
    });
    const payload = JSON.parse(built.body);
    assert.deepEqual(payload.tools.map(tool => tool.function.name), ['submit_final_output']);
    assert.deepEqual(payload.tools[0].function.parameters.required, ['answer']);
    assert.deepEqual(payload.tool_choice, model.startsWith('kimi') ? 'auto'
      : { type: 'function', function: { name: 'submit_final_output' } });
  }
});

test('new gateway compaction requests retain a usable summary budget through the supported non-thinking mode', () => {
  const binding = { model: 'deepseek-v4.1-flash' };
  const payload = { model: binding.model, max_tokens: 8192, stream: true, messages: [] };
  const policy = admitProviderCompatibilityPolicy('kspmas-gateway');
  const request = profile => ({ purpose: 'compaction', profile: { providerCompatibilityPolicy: policy, ...profile } });
  const summary = applyProviderChatCompatibility(payload, request({}), binding);
  assert.deepEqual(summary.thinking, { type: 'disabled' });
  assert.equal(summary.max_tokens, 8192, 'do not override an explicit smaller request limit');
  assert.equal(applyProviderChatCompatibility(payload, { ...request({}), purpose: 'task' }, binding).thinking, undefined);
  assert.equal(applyProviderChatCompatibility(payload, request({ reasoningEffort: 'high' }), binding).thinking, undefined);
  assert.deepEqual(applyProviderChatCompatibility(payload, request({ thinkingMode: 'enabled' }), binding).thinking, { type: 'enabled' });
  assert.deepEqual(applyProviderChatCompatibility({ ...payload, thinking: { type: 'enabled' } }, request({}), binding).thinking, { type: 'enabled' });
  for (const contract of ['provider-compat/v1', 'provider-compat/v2', 'provider-compat/v3']) {
    const old = applyProviderChatCompatibility(payload, { purpose: 'compaction', profile: {
      providerCompatibilityPolicy: { contract, rule: 'kspmas-gateway' },
    } }, binding);
    assert.equal(old.thinking, undefined, `${contract} must keep its original frozen request behavior`);
  }
  for (const model of ['glm-5.3-flash', 'kimi-k2.7-code', 'claude-opus-5-5']) {
    const result = applyProviderChatCompatibility({ ...payload, model }, request({}), { model });
    assert.notEqual(result.thinking?.type, 'disabled', `${model} does not admit this non-thinking default`);
  }
  assert.deepEqual(payload, { model: binding.model, max_tokens: 8192, stream: true, messages: [] });
});
