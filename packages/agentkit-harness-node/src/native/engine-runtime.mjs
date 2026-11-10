// A complete Native engine composed only from this package and Core.
//
// A host that runs the engine out of process does not assemble tools, policy
// versions or prompts. It gives the engine a workspace, a model binding, its
// own instructions and an approval callback; everything else is engine-owned
// and can change with an engine release alone.
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NativeKernel, configure, initialSnapshot, canonical, terminal, invariant, todoToolDefinitions, toolDiscoveryDefinitions,
  resolveEnginePreset, enginePresetToolDefinitions, presetRequestOutputTokens } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from './sqlite-store.mjs';
import { createNativeModelPort, nativeModelRecoveryPolicy } from './model-port.mjs';
import { admitChatUsagePolicy } from './model-chat-usage.mjs';
import { bindNativeContext, nativeContextDefaults } from './context-profile.mjs';
import { createNativeWorkspaceTools } from './workspace-tools.mjs';
import { createNativeLocalCommandTools } from './local-command-tools.mjs';
import { createOwnedCommandResolver } from './owned-command.mjs';
import { createBackgroundCommandPort } from './background-command-port.mjs';
import { createNativeArtifactStore } from './artifact-store.mjs';
import { nativeLocalExecutionMethods } from './local-execution-profile.mjs';
import { bindNativeModelSurface } from './model-surface-host.mjs';
import { nativeToolModelGuidance } from './tool-guidance.mjs';
import { createNativeWebTools } from './web-tools.mjs';
import { NATIVE_ENGINE_INSTRUCTION_ASSEMBLY, engineBaseInstructions, renderEngineInstructions } from './instruction-assembly.mjs';

export const ENGINE_RUNTIME_CONTRACT = 'agentkit.engine-runtime/v1';
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Validate the model binding a host supplies. The API key never enters a Run. */
export function admitEngineModel(model) {
  invariant(model && typeof model === 'object' && text(model.name) && text(model.baseUrl)
    && ['openai-chat', 'anthropic-messages', 'openai-responses'].includes(model.protocol ?? 'openai-chat')
    && (model.contextWindow === undefined || Number.isSafeInteger(model.contextWindow) && model.contextWindow >= 2048)
    && (model.maxOutputTokens == null || Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0)
    && (model.requestOutputTokens == null || Number.isSafeInteger(model.requestOutputTokens) && model.requestOutputTokens > 0)
    && (model.images === undefined || typeof model.images === 'boolean')
    && typeof model.apiKey === 'function', 'engine_model_invalid');
  const contextWindow = model.contextWindow ?? 128000;
  return { protocol: model.protocol ?? 'openai-chat', modelName: model.name, baseUrl: model.baseUrl, parameters: { stream: true },
    input: model.images ? ['text', 'image'] : ['text'], contextWindow,
    maxOutputTokens: presetRequestOutputTokens({ configured: model.requestOutputTokens ?? null,
      modelMaxOutputTokens: model.maxOutputTokens ?? null, contextWindow }),
    requestTimeoutMs: model.requestTimeoutMs ?? 180000 };
}

/** Build one engine bound to a workspace and a session. `authorize(request)`
 * resolves to 'allow' or 'deny' for every mutating or command tool call. */
export async function createEngineRuntime({ workspaceRoot, stateDir, sessionId, scope, model, authorize, owner = `engine-${process.pid}`,
  fetchImpl = fetch, sourceEnv = process.env } = {}) {
  invariant(text(workspaceRoot) && text(stateDir) && text(sessionId) && typeof authorize === 'function'
    && scope && ['tenantId', 'workspaceId', 'userId', 'agentId'].every(key => text(scope[key])), 'engine_runtime_invalid');
  const root = realpathSync(resolve(workspaceRoot));
  mkdirSync(stateDir, { recursive: true });
  const description = admitEngineModel(model);
  const supportsImages = description.input.includes('image');
  const decide = async request => await authorize(request) === 'allow' ? 'allow' : 'deny';

  const store = new SqliteRunStore(join(stateDir, 'runs.sqlite'));
  const artifacts = await createNativeArtifactStore({ directory: join(stateDir, 'artifacts'), scope });
  const execution = nativeLocalExecutionMethods({ enabled: true, settings: {}, sourceEnv, workspaceRoot: root, commandBackend: 'local_process' });
  const executionOptions = { modern: true, resourceProfile: 'local-development/v2' };
  const local = execution.localExecution(executionOptions);
  const workspace = createNativeWorkspaceTools({ workspaceRoot: root, stateDir: join(stateDir, 'workspace'), sessionId, authorize: decide });
  const commands = createNativeLocalCommandTools({ workspaceRoot: root, stateRoot: join(stateDir, 'commands'), sessionId,
    settings: local.settings, sourceEnv: local.environment, outputPolicy: local.outputPolicy, environmentPolicy: local.environmentPolicy,
    artifacts, authorize: decide, captureWorkspace: request => workspace.capture(request),
    resolveOwnedCommand: createOwnedCommandResolver({ scope, store }) });
  const web = createNativeWebTools({ fetch: fetchImpl, providerConfig: { provider: '' }, authorize: decide, sessionId, inlineMaxChars: 6000 });
  const owners = [workspace, commands, web];
  const route = new Map(owners.flatMap(port => port.definitions.map(definition => [definition.name, port])));
  const ownerOf = request => {
    const found = route.get(request?.call?.name ?? request?.name);
    invariant(found, 'tool_not_advertised');
    return found;
  };
  const bound = owners.flatMap(port => port.definitions).map(definition => {
    const media = definition.name === 'read_workspace_file' && supportsImages ? { ...definition, workspaceMediaPolicy: 'bounded-image-read/v1' } : definition;
    const guidance = nativeToolModelGuidance(media, { commandBackend: 'local_process' });
    return guidance.length ? { ...media, modelGuidance: guidance } : media;
  });
  const discovery = bound.some(tool => tool.discovery);
  const tools = {
    execute: (request, lifecycle) => ownerOf(request).execute(request, lifecycle),
    checkPlanMode: async request => (ownerOf(request).checkPlanMode ?? (async () => true))(request),
    observeReceipt: request => (route.get(request?.call?.name) ?? workspace).observeReceipt(request),
    repairWorkspace: request => workspace.repairWorkspace(request),
  };
  const context = bindNativeContext({ description, context: {}, ...nativeContextDefaults(undefined) });
  const chatUsage = admitChatUsagePolicy(description.protocol);
  const profile = { profileId: 'engine', profileVersion: digest(description), providerFamily: description.protocol,
    compatibilityDigest: digest(description), supportsImages, discoveredToolExposure: 'direct-after-search/v1', streamTimeoutPolicy: 'idle/v1',
    ...(chatUsage ? { chatUsagePolicy: chatUsage } : {}), maxRetries: 2, maxProviderRetries: 10, ...context.profile,
    maxOutputTokens: description.maxOutputTokens, contextWindow: description.contextWindow,
    requestTimeoutMs: description.requestTimeoutMs, providerReplayMode: 'reasoning_content' };
  const modelSurface = bindNativeModelSurface({ environment: execution.executionEnvironment(executionOptions), description });
  const modelPort = createNativeModelPort({ fetchImpl, resolveProfile: async () => ({ protocol: description.protocol, baseUrl: description.baseUrl,
    apiKey: await model.apiKey(), model: description.modelName, parameters: description.parameters }) });
  const background = createBackgroundCommandPort({ scope, store, readers: { local_process: commands.reader } });
  const kernel = new NativeKernel({ store, owner, digest, ports: { model: modelPort, tools, workspace, context: context.port, artifacts, background } });

  /** Admit a new Run. The Run freezes the preset and instructions it starts with. */
  function start({ runId, objective, hostInstructions = '', preset: presetName, maxModelCalls = null }) {
    invariant(text(runId) && text(objective) && typeof hostInstructions === 'string', 'engine_run_invalid');
    const preset = resolveEnginePreset({ ...(presetName === undefined ? {} : { preset: presetName }), maxModelCalls });
    const runtimeTools = [...bound, ...(discovery ? toolDiscoveryDefinitions() : []), ...todoToolDefinitions(discovery),
      ...enginePresetToolDefinitions(preset)];
    const instructions = renderEngineInstructions({ hostInstructions });
    const configuration = configure({ profile, tools: runtimeTools, contract: { objective }, ...preset.policies,
      hostBindingDigest: digest({ contract: ENGINE_RUNTIME_CONTRACT, workspaceRoot: root, description, tools: runtimeTools, instructions,
        preset: { preset: preset.preset, revision: preset.revision } }),
      limits: { ...preset.limits, maxWallMs: null, maxModelCalls,
        effectTimeoutMs: Math.max(120000, description.requestTimeoutMs + 10000, ...runtimeTools.map(tool => (tool.timeoutMs ?? 0) + 10000)) },
      modelRecoveryPolicy: nativeModelRecoveryPolicy(description), contextPolicy: context.policy, modelSurface,
      backgroundNotificationPolicy: 'completed-before-model/v1', todoPolicy: 'session-todos/v1',
      ...(discovery ? { toolDiscoveryPolicy: 'local-tool-search/v1' } : {}), instructions });
    const identity = { scope, runId, sessionId, turnId: 'turn-1', buildId: `engine-preset-${preset.preset}-${preset.revision}`,
      parentRunId: null, taskChainId: runId };
    kernel.start(initialSnapshot(identity, configuration, digest(configuration)), configuration);
    return { runId, preset: { preset: preset.preset, revision: preset.revision } };
  }

  return {
    scope, workspaceRoot: root,
    info: () => ({ contract: ENGINE_RUNTIME_CONTRACT, preset: (({ preset, revision }) => ({ preset, revision }))(resolveEnginePreset()),
      instructions: { policy: NATIVE_ENGINE_INSTRUCTION_ASSEMBLY, baseRevision: engineBaseInstructions().revision },
      model: { name: description.modelName, protocol: description.protocol, contextWindow: description.contextWindow,
        requestOutputTokens: description.maxOutputTokens, images: supportsImages },
      tools: bound.map(tool => tool.name) }),
    start,
    run: (runId, options) => kernel.runUntilIdle(scope, runId, options),
    submit: (runId, command) => kernel.submit(scope, runId, command),
    load: runId => store.load(scope, runId),
    events: (runId, cursor) => store.events(scope, runId, cursor),
    terminal: snapshot => terminal(snapshot.phase),
    close: () => { store.close(); },
  };
}
