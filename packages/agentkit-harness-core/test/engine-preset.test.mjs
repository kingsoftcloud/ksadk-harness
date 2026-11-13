import test from 'node:test';
import assert from 'node:assert/strict';
import { configure, resolveEnginePreset, presetRequestOutputTokens, listEnginePresets,
  ENGINE_PRESET_CONTRACT, OFFICIAL_ENGINE_PRESET, enginePresetToolDefinitions } from '../dist/index.mjs';
import { fixture, tool } from './fixtures.mjs';
import { outputRecoveryMode } from '../dist/output-recovery.mjs';

test('the official preset is the default and the reasoning experiment is explicit', () => {
  assert.deepEqual([...listEnginePresets()], [OFFICIAL_ENGINE_PRESET, 'experimental-reasoning-stall']);
  const preset = resolveEnginePreset();
  assert.equal(preset.contract, ENGINE_PRESET_CONTRACT);
  assert.equal(preset.preset, 'official');
  assert.ok(Number.isSafeInteger(preset.revision) && preset.revision >= 1);
  assert.deepEqual(resolveEnginePreset({ preset: 'official' }), preset);
  assert.throws(() => resolveEnginePreset({ preset: 'studio' }), { code: 'unknown_engine_preset' });
  assert.throws(() => resolveEnginePreset({ extra: 1 }), { code: 'invalid_engine_preset_request' });
  assert.throws(() => resolveEnginePreset({ maxModelCalls: 0 }), { code: 'invalid_engine_preset_request' });
});

test('preset policies form a configuration the kernel admits', () => {
  const preset = resolveEnginePreset();
  const { config } = fixture({ ...preset.policies, limits: preset.limits, tools: [tool(), ...enginePresetToolDefinitions(preset)] });
  assert.equal(config.outputRecoveryPolicy, 'response-boundary/v5');
  assert.equal(config.outputRestartPolicy, 'per-response/v2');
  assert.equal(config.toolErrorRecoveryPolicy, 'diagnose-before-repeat/v2');
  assert.equal(config.toolErrorRecoveryModelCalls, 10);
  // Every preset policy survives normalization unchanged, so a host may digest it before or after.
  for (const [key, value] of Object.entries(preset.policies)) assert.deepEqual(config[key], value, key);
  assert.equal(config.limits.maxOutputRestarts, 0);
});

test('a preset Run resumes the task after truncated commentary instead of sealing it', () => {
  const preset = resolveEnginePreset();
  const { config, snapshot } = fixture({ ...preset.policies, limits: preset.limits, tools: [tool(), ...enginePresetToolDefinitions(preset)] });
  const truncated = { kind: 'output_limit', text: 'Let me now fix core.py.', toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, cost: 0 },
    textCommitVersion: 'provider-finished-text/v1', outputBoundary: 'assistant-text/v1' };
  assert.equal(outputRecoveryMode(snapshot, config, true, truncated), 'task_resume');
});

test('neither preset resets the output allowance automatically', () => {
  for (const preset of listEnginePresets()) {
    for (const maxModelCalls of [19, 20, null]) {
      assert.equal(resolveEnginePreset({ preset, maxModelCalls }).limits.maxOutputRestarts, 0);
    }
  }
  assert.equal(resolveEnginePreset({ preset: 'experimental-reasoning-stall' }).policies.outputRecoveryPolicy, 'response-boundary/v4');
});

test('request output budget follows the model, the window and an explicit choice', () => {
  assert.equal(presetRequestOutputTokens({ contextWindow: 1048576 }), 32000);
  assert.equal(presetRequestOutputTokens({ contextWindow: 1048576, modelMaxOutputTokens: 16384 }), 16384);
  assert.equal(presetRequestOutputTokens({ contextWindow: 32000 }), 16000);
  assert.equal(presetRequestOutputTokens({ contextWindow: 1048576, configured: 8192 }), 8192);
  assert.equal(presetRequestOutputTokens({ contextWindow: 128000, configured: 200000, modelMaxOutputTokens: 65536 }), 64000);
  assert.equal(presetRequestOutputTokens({ contextWindow: 1024 }), 512);
  assert.throws(() => presetRequestOutputTokens({ contextWindow: 0 }), { code: 'invalid_preset_output_budget' });
  assert.throws(() => presetRequestOutputTokens({ contextWindow: 128000, configured: -1 }), { code: 'invalid_preset_output_budget' });
  const preset = resolveEnginePreset();
  const config = configure({ ...fixture().config, ...preset.policies, tools: [tool(), ...enginePresetToolDefinitions(preset)],
    profile: { ...fixture().config.profile, contextWindow: 128000, maxOutputTokens: presetRequestOutputTokens({ contextWindow: 128000 }) } });
  assert.equal(config.profile.maxOutputTokens, 32000);
});
