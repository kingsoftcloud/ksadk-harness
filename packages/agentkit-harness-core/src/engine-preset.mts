import type { RunConfiguration, ToolDefinition } from './contracts.mjs';
import { artifactToolDefinitions } from './artifact-runtime.mjs';
import { deliveryToolDefinitions } from './deliverables.mjs';
import { invariant } from './values.mjs';

/** Engine-owned run defaults.
 *
 * A host names a preset; the engine decides which policy versions and budgets
 * that name means. Publishing a better recovery policy therefore needs an
 * engine release only: hosts that reference `official` pick it up for new
 * Runs, while existing Runs keep the configuration frozen at their creation.
 *
 * Hosts must not copy the returned literals into their own source. */
export const ENGINE_PRESET_CONTRACT = 'agentkit.engine-preset/v1';
export const OFFICIAL_ENGINE_PRESET = 'official';
const EXPERIMENTAL_REASONING_STALL_PRESET = 'experimental-reasoning-stall';

/** Bump when the meaning of `official` changes for new Runs. */
const OFFICIAL_REVISION = 3;
const EXPERIMENTAL_REASONING_STALL_REVISION = 1;

/** Largest single response the engine asks for by default. Long greenfield
 * edits need roughly 30k tokens in one response; smaller requests exhaust
 * themselves on reasoning before any tool call is emitted. */
const DEFAULT_REQUEST_OUTPUT_TOKENS = 32000;
const MINIMUM_REQUEST_OUTPUT_TOKENS = 1024;

export interface EnginePresetRequest {
  preset?: string;
  /** Host-declared model call budget. Accepted for host compatibility. */
  maxModelCalls?: number | null;
}

type PresetPolicyKey = 'providerRecoveryPolicy' | 'outputRecoveryPolicy' | 'outputRestartPolicy' | 'toolExecutionPolicy'
  | 'toolErrorRecoveryPolicy' | 'artifactPolicy' | 'workspaceCapturePolicy' | 'deliveryScopePolicy' | 'toolErrorRecoveryModelCalls';

export interface EnginePreset {
  contract: typeof ENGINE_PRESET_CONTRACT;
  preset: string;
  revision: number;
  /** Spread into the configuration input of a NEW Run. */
  policies: Required<Pick<RunConfiguration, PresetPolicyKey>>;
  limits: { maxOutputRestarts: number };
  /** Tool-surface options a Node host forwards to the engine tool binder. */
  toolOptions: { executionTimeoutPolicy: 'dispatch/v2'; workspaceEditPolicy: 'zcode-match/v2' };
}

export function listEnginePresets(): readonly string[] {
  return Object.freeze([OFFICIAL_ENGINE_PRESET, EXPERIMENTAL_REASONING_STALL_PRESET]);
}

export function resolveEnginePreset(request: EnginePresetRequest = {}): EnginePreset {
  invariant(request !== null && typeof request === 'object' && !Array.isArray(request)
    && Object.keys(request).every(key => ['preset', 'maxModelCalls'].includes(key)), 'invalid_engine_preset_request');
  const preset = request.preset ?? OFFICIAL_ENGINE_PRESET;
  const experimental = preset === EXPERIMENTAL_REASONING_STALL_PRESET;
  invariant(preset === OFFICIAL_ENGINE_PRESET || experimental, 'unknown_engine_preset');
  const maxModelCalls = request.maxModelCalls ?? null;
  invariant(maxModelCalls === null || Number.isSafeInteger(maxModelCalls) && maxModelCalls >= 1, 'invalid_engine_preset_request');
  return {
    contract: ENGINE_PRESET_CONTRACT, preset,
    revision: experimental ? EXPERIMENTAL_REASONING_STALL_REVISION : OFFICIAL_REVISION,
    policies: {
      providerRecoveryPolicy: 'provider-recovery/v2',
      outputRecoveryPolicy: experimental ? 'response-boundary/v4' : 'response-boundary/v5',
      // v2: an admitted tool step ends the truncation streak and exhaustion pauses.
      outputRestartPolicy: 'per-response/v2',
      toolExecutionPolicy: 'owner-execution/v1',
      toolErrorRecoveryPolicy: 'diagnose-before-repeat/v2',
      // Spelled out so a host digest over these policies is identical at admission and restore.
      toolErrorRecoveryModelCalls: 10,
      artifactPolicy: 'runtime-artifacts/v1',
      workspaceCapturePolicy: 'declared-subjects/v1',
      // Results are the answer plus the artifacts it names.
      deliveryScopePolicy: 'answer-artifacts/v2',
    },
    limits: { maxOutputRestarts: 0 },
    toolOptions: { executionTimeoutPolicy: 'dispatch/v2', workspaceEditPolicy: 'zcode-match/v2' },
  };
}

export interface PresetOutputBudgetRequest {
  /** An explicit user/operator choice always wins. */
  configured?: number | null;
  /** Largest response the bound model accepts, when known. */
  modelMaxOutputTokens?: number | null;
  contextWindow: number;
}

/** Per-request output budget for a new Run under the official preset.
 * Never exceeds the model limit and leaves at least half the window for input. */
export function presetRequestOutputTokens(request: PresetOutputBudgetRequest): number {
  const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
  invariant(request !== null && typeof request === 'object' && positive(request.contextWindow)
    && (request.configured == null || positive(request.configured))
    && (request.modelMaxOutputTokens == null || positive(request.modelMaxOutputTokens)), 'invalid_preset_output_budget');
  const ceiling = Math.min(request.modelMaxOutputTokens ?? Number.MAX_SAFE_INTEGER, Math.floor(request.contextWindow / 2));
  invariant(ceiling >= 1, 'invalid_preset_output_budget');
  if (request.configured != null) return Math.min(request.configured, ceiling);
  return Math.max(Math.min(DEFAULT_REQUEST_OUTPUT_TOKENS, ceiling), Math.min(MINIMUM_REQUEST_OUTPUT_TOKENS, ceiling));
}

/** Engine control tools the preset policies require. A host appends these to
 * its own tools instead of knowing which policy implies which control. */
export function enginePresetToolDefinitions(preset: Pick<EnginePreset, 'policies'>): ToolDefinition[] {
  return [
    ...(preset.policies.deliveryScopePolicy ? deliveryToolDefinitions(preset.policies.deliveryScopePolicy) : []),
    ...(preset.policies.artifactPolicy ? artifactToolDefinitions() : []),
  ];
}
