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
  resolveEnginePreset, enginePresetToolDefinitions, presetRequestOutputTokens, FINAL_SUBMISSION_TOOL, REVIEW_SUBMISSION_TOOL } from '@kingsoftcloud/agentkit-harness-core';

/** Control tools the kernel adds while a Run executes, beyond those listed in its configuration. */
const KERNEL_TOOL_NAMES = [FINAL_SUBMISSION_TOOL, REVIEW_SUBMISSION_TOOL];
import { SqliteRunStore } from './sqlite-store.mjs';
import { createNativeModelPort, nativeModelRecoveryPolicy } from './model-port.mjs';
import { admitChatUsagePolicy } from './model-chat-usage.mjs';
import { validateMediaBlock } from './model-media.mjs';
import { admitProviderCompatibilityPolicy } from './model-provider-compat.mjs';
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
import { createNativeChildren, nativeChildRoles } from './children.mjs';
import { nativeChildToolDefinitions } from './child-tools.mjs';
import { nativeChildReaderDefinitions } from './child-readers.mjs';
import { nativeChildMergeDefinition } from './child-merge.mjs';
import { childCommandResource } from './child-command-resource.mjs';
import { createStudioNativeChildWorkspaces } from './child-workspace-binding.mjs';
import { NATIVE_ENGINE_INSTRUCTION_ASSEMBLY, engineBaseInstructions, renderEngineInstructions } from './instruction-assembly.mjs';
import { redactDiagnosticText } from '@kingsoftcloud/agentkit-harness-core/error-presentation';
import { admitEngineToolPolicy, restrictEngineTools } from './engine-tool-policy.mjs';
import { admitEngineContextSources, engineContextPort } from './engine-context.mjs';
import { admitEngineHooks, engineHookPort } from './engine-hooks.mjs';
import { ENGINE_HOST_EFFECT, completedHostObservations, engineUserObservations } from './engine-host-effects.mjs';
import { admitEngineVerification, engineVerificationPort } from './engine-verification.mjs';

export const ENGINE_RUNTIME_CONTRACT = 'agentkit.engine-runtime/v1';
export const ENGINE_EXECUTION_POLICY = 'agentkit.engine-execution-policy/v1';
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;
const DURABLE_APPROVAL = 'durable-preflight/v1';
export const ENGINE_APPROVAL_CONTRACT = 'agentkit.engine-approval/v1';
export const engineApprovalSubject = ({ arguments: args = {} }) => {
  const subject = [args.command, args.path, args.url, args.task_id].find(text);
  return subject ? redactDiagnosticText(subject, 500) : null;
};

function durableDecision(record, request) {
  const { call, operationKey } = request;
  const interactionId = `engine-permission-${digest({ runId: request.runId, call, definition: request.definition })}`;
  // Walk backward only within the lifetime of this call. A reused provider
  // call ID cannot inherit a grant after its previous invocation completed.
  for (let index = record.events.length - 1; index >= 0; index--) {
    const { kind, payload } = record.events[index];
    if (payload.callId !== call.callId) continue;
    if (kind === 'tool.completed') break;
    if (kind !== 'approval.resolved') continue;
    const intentKey = payload.interactionId?.slice(0, -':approval'.length);
    if (!intentKey || intentKey === operationKey) continue;
    const receipt = record.receipts.find(row => row.operationKey === intentKey && row.status === 'committed');
    if (receipt?.result.results?.some(result => result.status === 'approval_required' && result.interactionId === interactionId))
      return payload.decision === 'allow' ? 'allow' : 'deny';
  }
  return { status: 'approval_required', approvalPolicy: DURABLE_APPROVAL, interactionId,
    content: { contract: ENGINE_APPROVAL_CONTRACT, code: 'approval_required', argumentDigest: digest(call.arguments),
      subject: engineApprovalSubject(call) } };
}

function admitExecutionPolicy(policy, legacyMaxModelCalls) {
  if (policy === undefined) return { maxWallMs: null, maxModelCalls: legacyMaxModelCalls, maxToolCalls: null };
  const limit = (value, minimum) => value === null || Number.isSafeInteger(value) && value >= minimum;
  invariant(policy && typeof policy === 'object' && legacyMaxModelCalls === null
    && Object.keys(policy).every(key => ['contract', 'strategy', 'maxWallMs', 'maxModelCalls', 'maxToolCalls'].includes(key))
    && policy.contract === ENGINE_EXECUTION_POLICY && ['direct', 'plan-act-observe'].includes(policy.strategy)
    && limit(policy.maxWallMs, 1) && limit(policy.maxModelCalls, 1) && limit(policy.maxToolCalls, 0),
  'engine_execution_policy_invalid');
  return { maxWallMs: policy.maxWallMs, maxModelCalls: policy.maxModelCalls, maxToolCalls: policy.maxToolCalls };
}

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
  return { protocol: model.protocol ?? 'openai-chat', modelName: model.name, baseUrl: model.baseUrl, parameters: {},
    input: model.images ? ['text', 'image'] : ['text'], contextWindow,
    maxOutputTokens: presetRequestOutputTokens({ configured: model.requestOutputTokens ?? null,
      modelMaxOutputTokens: model.maxOutputTokens ?? null, contextWindow }),
    requestTimeoutMs: model.requestTimeoutMs ?? 180000 };
}

const CONVERSATION_TURNS = 64, CONVERSATION_CHARS = 60000;
export const ENGINE_INPUT_IMAGES = Object.freeze({ maxCount: 8, maxEncodedBytes: 6 * 1024 * 1024 });

function engineInputMedia(inputImages, supportsImages) {
  if (inputImages === undefined) return [];
  invariant(Array.isArray(inputImages) && inputImages.length <= ENGINE_INPUT_IMAGES.maxCount, 'engine_input_images_invalid');
  if (!inputImages.length) return [];
  invariant(supportsImages, 'engine_input_images_unsupported');
  let encodedBytes = 0;
  return inputImages.map(block => {
    const url = block?.image_url?.url;
    invariant(typeof url === 'string' && url.startsWith('data:image/'), 'engine_input_image_must_be_inline');
    encodedBytes += Buffer.byteLength(url, 'utf8');
    invariant(encodedBytes <= ENGINE_INPUT_IMAGES.maxEncodedBytes, 'engine_input_images_too_large');
    try { return validateMediaBlock(block, ENGINE_INPUT_IMAGES.maxEncodedBytes); }
    catch { invariant(false, 'engine_input_images_invalid'); }
  });
}

/** Earlier turns of the conversation a new Run continues. The engine decides how
 * they reach the model; the host only supplies role and text. Newest turns win
 * when the history exceeds the budget. */
function engineConversation(conversation) {
  invariant(conversation === undefined || Array.isArray(conversation) && conversation.every(turn => turn && typeof turn === 'object'
    && ['user', 'assistant'].includes(turn.role) && typeof turn.text === 'string'), 'engine_conversation_invalid');
  const turns = [];
  let used = 0;
  for (const turn of [...(conversation ?? [])].reverse()) {
    const body = turn.text.trim();
    if (!body) continue;
    if (turns.length >= CONVERSATION_TURNS || used + body.length > CONVERSATION_CHARS) break;
    turns.unshift(`${turn.role === 'user' ? 'User' : 'Assistant'}: ${body}`); used += body.length;
  }
  return turns;
}

export function renderEngineObjective(objective, conversation) {
  const turns = engineConversation(conversation);
  if (!turns.length) return objective;
  return ['This Run continues an existing conversation. Earlier turns, oldest first:', '', ...turns, '',
    'The current request, which is your task:', objective].join('\n');
}

const HOST_TOOL_LIMIT = 128;
const HOST_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Admit tools the host implements (MCP servers, knowledge bases, Skills).
 * The engine only advertises them and forwards calls; the host executes and
 * authorizes. A read-only tool may be re-run after a crash; any other tool is
 * never replayed by the engine. */
export function admitHostTools(tools, reserved, durableApprovals = false, hostReceipts = false) {
  invariant(tools === undefined || Array.isArray(tools) && tools.length <= HOST_TOOL_LIMIT, 'engine_host_tools_invalid');
  const seen = new Set();
  return (tools ?? []).map(tool => {
    invariant(tool && typeof tool === 'object' && !Array.isArray(tool)
      && Object.keys(tool).every(key => ['name', 'description', 'parameters', 'readOnly', 'timeoutMs', 'deferred', 'effectProtocol', 'receiptObservation'].includes(key))
      && typeof tool.name === 'string' && HOST_TOOL_NAME.test(tool.name) && !reserved.has(tool.name) && !seen.has(tool.name)
      && typeof tool.description === 'string' && tool.description.length <= 4000
      && tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters) && tool.parameters.type === 'object'
      && (tool.readOnly === undefined || typeof tool.readOnly === 'boolean')
      && (tool.deferred === undefined || typeof tool.deferred === 'boolean')
      && (tool.effectProtocol === undefined || tool.effectProtocol === ENGINE_HOST_EFFECT && tool.readOnly !== true)
      && (tool.receiptObservation === undefined || hostReceipts && tool.receiptObservation === true && tool.effectProtocol === ENGINE_HOST_EFFECT)
      && (tool.timeoutMs === undefined || Number.isSafeInteger(tool.timeoutMs) && tool.timeoutMs >= 1000 && tool.timeoutMs <= 600000),
    'engine_host_tools_invalid');
    seen.add(tool.name);
    const readOnly = tool.readOnly === true;
    return { name: tool.name, description: tool.description || `Host tool ${tool.name}`, parameters: structuredClone(tool.parameters),
      readOnly, concurrentSafe: readOnly, permissions: [], timeoutMs: tool.timeoutMs ?? 120000,
      contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
      recoveryPolicy: readOnly ? 'safe-read/v1' : tool.receiptObservation ? 'receipt-observation/v1' : 'manual',
      ...(tool.effectProtocol ? { hostEffectProtocol: tool.effectProtocol,
        ...(durableApprovals ? { approvalPolicy: DURABLE_APPROVAL } : {}) } : {}),
      ...(tool.deferred ? { discovery: { deferred: true } } : {}) };
  });
}

/** Build one engine bound to a workspace and a session. `authorize(request)`
 * resolves to 'allow' or 'deny' for every mutating or command tool call.
 * `callHostTool({ runId, callId, name, arguments, signal })` executes a host
 * tool and resolves to `{ status: 'ok' | 'error', content }`. */
export async function createEngineRuntime({ workspaceRoot, stateDir, sessionId, scope, model, authorize, callHostTool,
  callHostContext, callHostHook, callHostVerification, callHostReceipt, owner = `engine-${process.pid}`,
  fetchImpl = fetch, sourceEnv = process.env, commandSandbox, subAgents, runStore, onStream } = {}) {
  invariant(text(workspaceRoot) && text(stateDir) && text(sessionId) && typeof authorize === 'function'
    && scope && ['tenantId', 'workspaceId', 'userId', 'agentId'].every(key => text(scope[key])), 'engine_runtime_invalid');
  const root = realpathSync(resolve(workspaceRoot));
  mkdirSync(stateDir, { recursive: true });
  const description = admitEngineModel(model);
  const roles = nativeChildRoles({ subAgents });
  const supportsImages = description.input.includes('image');
  const store = runStore ?? new SqliteRunStore(join(stateDir, 'runs.sqlite'));
  const decide = async request => {
    if (request.definition?.approvalPolicy === DURABLE_APPROVAL) return durableDecision(store.load(request.scope, request.runId), request);
    return await authorize(request) === 'allow' ? 'allow' : 'deny';
  };
  const artifacts = await createNativeArtifactStore({ directory: join(stateDir, 'artifacts'), scope });
  const execution = nativeLocalExecutionMethods({ enabled: true, settings: {}, sourceEnv, workspaceRoot: root, commandBackend: 'local_process' });
  const executionOptions = { modern: true, resourceProfile: 'local-development/v2' };
  const local = execution.localExecution(executionOptions);
  const workspace = createNativeWorkspaceTools({ workspaceRoot: root, stateDir: join(stateDir, 'workspace'), sessionId, authorize: decide });
  const commands = createNativeLocalCommandTools({ workspaceRoot: root, stateRoot: join(stateDir, 'commands'), sessionId,
    settings: local.settings, sourceEnv: local.environment, outputPolicy: local.outputPolicy, environmentPolicy: local.environmentPolicy,
    shellPolicy: commandSandbox,
    artifacts, authorize: decide, captureWorkspace: request => workspace.capture(request),
    resolveOwnedCommand: createOwnedCommandResolver({ scope, store }) });
  const web = createNativeWebTools({ fetch: fetchImpl, providerConfig: { provider: '' }, authorize: decide, sessionId, inlineMaxChars: 6000 });
  const owners = [workspace, commands, web];
  const route = new Map(owners.flatMap(port => port.definitions.map(definition => [definition.name, port])));
  // Anything a Run advertises that the engine does not own was admitted as a host tool.
  const hostPort = {
    async execute(request) {
      if (typeof callHostTool !== 'function') return { status: 'error', content: { code: 'host_tools_unavailable', message: 'The host did not provide tool execution.' } };
      try {
        const effectBound = request.definition?.hostEffectProtocol === ENGINE_HOST_EFFECT;
        const record = effectBound ? store.load(request.scope, request.runId) : null;
        const decision = record && request.definition.approvalPolicy === DURABLE_APPROVAL
          ? durableDecision(record, request) : null;
        if (decision === 'deny') return { status: 'error', content: { code: 'policy_denied', executed: false } };
        const effect = record ? {
          contract: ENGINE_HOST_EFFECT, operationKey: request.operationKey,
          sourceEventId: record.events.at(-1)?.eventId ?? null,
          goal: record.snapshot.goal, goalRevision: record.snapshot.goalRevision,
          observations: engineUserObservations(store, request.scope, record.snapshot),
          approved: decision === 'allow', canRequestApproval: !!decision && typeof decision === 'object',
        } : undefined;
        const reply = await callHostTool({ runId: request.runId, callId: request.call.callId, name: request.call.name,
          arguments: request.call.arguments ?? {}, signal: request.signal, timeoutMs: request.definition?.timeoutMs ?? 120000, effect });
        if (effectBound && reply?.status === 'approval_required') {
          return decision && typeof decision === 'object' ? decision
            : { status: 'error', content: { code: 'host_tool_approval_unavailable', executed: false } };
        }
        if (effectBound && reply?.status === 'uncertain')
          return { status: 'uncertain', content: { code: 'host_tool_outcome_unknown' } };
        if (effectBound && !['ok', 'error'].includes(reply?.status))
          return { status: 'uncertain', content: { code: 'host_tool_outcome_unknown' } };
        const status = reply?.status === 'ok' ? 'ok' : 'error';
        return { status, content: reply?.content === undefined ? null : JSON.parse(JSON.stringify(reply.content)) };
      } catch (error) {
        if (request.definition?.hostEffectProtocol === ENGINE_HOST_EFFECT) {
          request.signal.throwIfAborted();
          return { status: 'uncertain', content: { code: 'host_tool_outcome_unknown' } };
        }
        return { status: 'error', content: { code: 'host_tool_failed', message: String(error?.message ?? error).slice(0, 2000) } };
      }
    },
  };
  const ownerOf = request => route.get(request?.call?.name ?? request?.name) ?? hostPort;
  const bound = owners.flatMap(port => port.definitions).map(definition => {
    const media = definition.name === 'read_workspace_file' && supportsImages ? { ...definition, workspaceMediaPolicy: 'bounded-image-read/v1' } : definition;
    const guidance = nativeToolModelGuidance(media, { commandBackend: 'local_process' });
    return guidance.length ? { ...media, modelGuidance: guidance } : media;
  });
  // Some owners do their own preflight, including validating the workspace
  // before requesting approval. Gate read-only workspace calls and externally
  // owned callbacks here when the Run's policy explicitly requires it.
  const preflight = async (request, dispatch) => {
    if (request.definition.approvalPolicy === DURABLE_APPROVAL
      && (!request.definition.hostEffectProtocol || request.definition.hostApprovalRequired)) {
      const decision = await decide(request);
      if (decision === 'deny') return { status: 'error', content: { code: 'policy_denied', executed: false } };
      if (decision !== 'allow') return decision;
    }
    return dispatch();
  };
  const tools = {
    approvalPolicy: DURABLE_APPROVAL,
    execute(request, lifecycle) {
      const owner = ownerOf(request);
      const dispatch = () => owner.execute(request, lifecycle);
      return owner === hostPort || owner === children || owner === workspace && request.definition.readOnly
        ? preflight(request, dispatch) : dispatch();
    },
    checkPlanMode: async request => (ownerOf(request).checkPlanMode ?? (async () => true))(request),
    observeReceipt(request) {
      if (ownerOf(request) === hostPort && request.definition?.hostEffectProtocol === ENGINE_HOST_EFFECT
        && request.definition.recoveryPolicy === 'receipt-observation/v1') return callHostReceipt?.(request);
      return (route.get(request?.call?.name) ?? workspace).observeReceipt?.(request);
    },
    repairWorkspace: request => workspace.repairWorkspace(request),
  };
  const context = bindNativeContext({ description, context: {}, ...nativeContextDefaults(undefined) });
  const chatUsage = admitChatUsagePolicy(description.protocol);
  const profile = { profileId: 'engine', profileVersion: digest(description), providerFamily: description.protocol,
    compatibilityDigest: digest(description), supportsImages, discoveredToolExposure: 'direct-after-search/v1', streamTimeoutPolicy: 'idle/v1',
    ...(chatUsage ? { chatUsagePolicy: chatUsage } : {}), maxRetries: 2, maxProviderRetries: 10, ...context.profile,
    maxOutputTokens: description.maxOutputTokens, contextWindow: description.contextWindow,
    requestTimeoutMs: description.requestTimeoutMs, providerReplayMode: 'reasoning_content',
    providerCompatibilityPolicy: admitProviderCompatibilityPolicy() };
  const modelSurface = bindNativeModelSurface({ environment: execution.executionEnvironment(executionOptions), description });
  const modelPort = createNativeModelPort({ fetchImpl, resolveProfile: async () => ({ protocol: description.protocol, baseUrl: description.baseUrl,
    apiKey: await model.apiKey(), model: description.modelName, parameters: description.parameters }) });
  const background = createBackgroundCommandPort({ scope, store, readers: { local_process: commands.reader } });
  const lifetime = new AbortController();
  const childDefinitions = [];
  let children;
  if (roles.length) {
    try {
      const childTools = [...workspace.definitions, ...commands.definitions].map(tool => tool.readOnly
        ? tool : { ...tool, approvalPolicy: DURABLE_APPROVAL });
      const fileWorkspaces = createStudioNativeChildWorkspaces({ workspaceRoot: root, stateDir });
      const commandResource = childCommandResource({ ...local.binding,
        controls: { ...local.binding.controls, shellPolicy: commandSandbox ?? local.binding.controls.shellPolicy } });
      children = await createNativeChildren({ roles, scope, sessionId, store, tools: childTools, fileWorkspaces,
        commandResource, isClosed: () => lifetime.signal.aborted, detachSignal: lifetime.signal,
        restrictTools: (tools, parent) => tools.flatMap(tool => {
          if (!childTools.some(definition => definition.name === tool.name)) return [tool];
          const parentTool = parent.tools.find(definition => definition.name === tool.name);
          return parentTool ? [parentTool.hostApprovalRequired
            ? { ...tool, approvalPolicy: DURABLE_APPROVAL, hostApprovalRequired: true } : tool] : [];
        }),
        artifactPolicy: 'runtime-artifacts/v1', artifactFactory: childScope =>
          createNativeArtifactStore({ directory: join(stateDir, 'artifacts'), scope: childScope }),
        resolveModel: async id => {
          invariant(id === null || id === 'engine', 'engine_child_model_unbound');
          return { profile, supportsImages, model: modelPort, context: context.port, contextPolicy: context.policy,
            modelRecoveryPolicy: nativeModelRecoveryPolicy(description) };
        },
        bindTools({ scope: childScope, sessionId: childSession, workspaceRoot: childRoot = root, executionResource }) {
          const childState = join(stateDir, 'children', digest({ childScope, childSession }));
          const files = createNativeWorkspaceTools({ workspaceRoot: childRoot, stateDir: join(childState, 'workspace'),
            sessionId: childSession, authorize: decide });
          const command = executionResource ? createNativeLocalCommandTools({ workspaceRoot: childRoot,
            stateRoot: join(childState, 'commands'), sessionId: childSession, settings: local.settings, sourceEnv: local.environment,
            outputPolicy: local.outputPolicy, environmentPolicy: local.environmentPolicy, shellPolicy: commandSandbox,
            authorize: decide, captureWorkspace: request => files.capture(request),
            resolveOwnedCommand: createOwnedCommandResolver({ scope: childScope, store }) }) : null;
          const names = new Set(command?.definitions.map(tool => tool.name));
          return { workspace: files, tools: { approvalPolicy: DURABLE_APPROVAL,
            execute(request, observations) {
              if (names.has(request.call.name)) return command.execute(request, observations);
              const dispatch = () => files.execute(request, observations);
              return request.definition.readOnly ? preflight(request, dispatch) : dispatch();
            },
            observeReceipt: request => files.observeReceipt(request) },
          ...(command ? { background: createBackgroundCommandPort({ scope: childScope, store, readers: { local_process: command.reader } }) } : {}) };
        },
        verificationFactory: async () => undefined });
      const timeout = Math.max(120000, ...roles.map(role => role.timeoutSeconds * 1000 + 5000));
      childDefinitions.push(...nativeChildToolDefinitions(roles.map(role => role.name), timeout), ...nativeChildReaderDefinitions());
      if (roles.some(role => role.tools.some(name => childTools.some(tool => tool.name === name && !tool.readOnly)))) {
        const definition = { ...nativeChildMergeDefinition(), approvalPolicy: DURABLE_APPROVAL };
        childDefinitions.push(definition);
        route.set(definition.name, { async execute(request) {
          const decision = await decide(request);
          return decision === 'allow' ? children.execute(request) : decision === 'deny'
            ? { status: 'error', content: { code: 'policy_denied', executed: false } } : decision;
        } });
      }
      for (const definition of childDefinitions) if (!route.has(definition.name)) route.set(definition.name, children);
    } catch (error) { if (!runStore) store.close(); throw error; }
  }
  const ports = { model: modelPort, tools, workspace,
    context: engineContextPort(context.port, callHostContext),
    verification: engineVerificationPort(store, callHostVerification, digest),
    hooks: engineHookPort(callHostHook, request => {
      const { snapshot } = store.authority(request.scope, request.runId);
      const indexes = new Set(request.input.compaction.messageRefs.map(ref => Number(ref.split(':', 3)[1])));
      return engineUserObservations(store, request.scope, snapshot, { indexes });
    }),
    artifacts, background, ...(children ? { children: children.owner } : {}) };
  const kernel = new NativeKernel({ store, owner, digest, ports, onStream });

  function prepareRun({ runId, objective, conversation, inputImages, hostInstructions = '', hostTools, toolPolicy,
    hostContext, hostHooks, hostVerification, executionPolicy, preset: presetName, maxModelCalls = null,
    durableApprovals = false, originalInput = false }) {
    invariant(text(runId) && text(objective) && typeof hostInstructions === 'string', 'engine_run_invalid');
    const limits = admitExecutionPolicy(executionPolicy, maxModelCalls);
    const preset = resolveEnginePreset({ ...(presetName === undefined ? {} : { preset: presetName }), maxModelCalls: limits.maxModelCalls });
    const presetTools = enginePresetToolDefinitions(preset);
    const kernelTools = [...presetTools, ...toolDiscoveryDefinitions(), ...todoToolDefinitions(true)].map(tool => tool.name);
    const internal = [...kernelTools, ...KERNEL_TOOL_NAMES];
    const reserved = new Set([...bound.map(tool => tool.name), ...childDefinitions.map(tool => tool.name), ...internal]);
    const policy = admitEngineToolPolicy(toolPolicy, durableApprovals);
    invariant(!policy || internal.every(name => !policy.rules.has(name) || policy.rules.get(name) === 'inherit'),
      'engine_tool_policy_internal_control_unsupported');
    const hosted = restrictEngineTools(admitHostTools(hostTools, reserved, durableApprovals, typeof callHostReceipt === 'function'), policy, DURABLE_APPROVAL);
    const builtins = restrictEngineTools(durableApprovals ? bound.map(tool => route.get(tool.name) === workspace && tool.readOnly
      ? tool : { ...tool, approvalPolicy: DURABLE_APPROVAL }) : bound, policy, DURABLE_APPROVAL);
    const childControls = durableApprovals ? restrictEngineTools(childDefinitions, policy, DURABLE_APPROVAL) : [];
    const searchable = builtins.some(tool => tool.discovery) || hosted.some(tool => tool.discovery);
    const runtimeTools = [...builtins, ...hosted, ...(searchable ? toolDiscoveryDefinitions() : []), ...todoToolDefinitions(searchable),
      ...presetTools, ...childControls];
    const instructions = renderEngineInstructions({ hostInstructions });
    // The engine already inherits its own journal for subsequent Runs.
    const importedConversation = store.sessionHead(scope, sessionId) ? undefined : conversation;
    const task = renderEngineObjective(objective, importedConversation);
    const media = engineInputMedia(inputImages, supportsImages);
    const contextSources = admitEngineContextSources(hostContext);
    const hooks = admitEngineHooks(hostHooks);
    const verification = admitEngineVerification(hostVerification);
    const effectBound = hosted.some(tool => tool.hostEffectProtocol === ENGINE_HOST_EFFECT);
    const scopedCallbacks = contextSources.length || hooks.definitions.length || effectBound || !!verification;
    const inputMessages = effectBound || originalInput ? [
      ...(task !== objective ? [{ role: 'user', kind: 'host_imported_history',
        content: canonical({ trust: 'untrusted', earlierTurns: engineConversation(importedConversation) }) }] : []),
      { role: 'user', kind: 'user_input', content: objective, ...(media.length ? { media } : {}) },
    ] : [{ role: 'user', content: task, ...(media.length ? { media } : {}) }];
    const configuration = configure({ profile, tools: runtimeTools, contextSources, hooks: hooks.definitions,
      ...hooks.configuration,
      ...(verification ? { hostVerification: verification } : {}),
      ...(executionPolicy?.strategy === 'plan-act-observe' ? { initialPlanPolicy: 'plan-act-observe/v1' } : {}),
      contract: { objective: scopedCallbacks ? objective : task,
        ...(verification ? { acceptance: [{ id: 'host_goal', required: true, verifierRef: verification.verifierRef,
          verifierVersion: verification.verifierVersion, verificationMethod: 'deterministic',
          description: 'Verify the requested result using the bound host owner.' }] } : {}) },
      ...(media.length || scopedCallbacks || originalInput ? { inputMessages } : {}), ...preset.policies,
      hostBindingDigest: digest({ contract: ENGINE_RUNTIME_CONTRACT, workspaceRoot: root, description, tools: runtimeTools, instructions,
        ...(commandSandbox ? { commandSandbox } : {}), ...(durableApprovals && roles.length ? { roles } : {}),
        ...(contextSources.length ? { contextSources } : {}),
        ...(hooks.definitions.length ? { hooks: hooks.definitions, ...hooks.configuration } : {}),
        ...(verification ? { verification } : {}),
        ...(executionPolicy === undefined ? {} : { executionPolicy }),
        preset: { preset: preset.preset, revision: preset.revision } }),
      limits: { ...preset.limits, ...limits,
        effectTimeoutMs: Math.max(120000, description.requestTimeoutMs + 10000, hooks.timeoutMs + 1000,
          ...runtimeTools.map(tool => (tool.timeoutMs ?? 0) + 10000)) },
      modelRecoveryPolicy: nativeModelRecoveryPolicy(description), contextPolicy: context.policy, modelSurface,
      backgroundNotificationPolicy: 'completed-before-model/v1', todoPolicy: 'session-todos/v1',
      ...(durableApprovals && children ? { childLifecyclePolicy: 'owned-background/v2', childApprovalPolicy: 'owned-child-approval/v1' } : {}),
      ...(searchable ? { toolDiscoveryPolicy: 'local-tool-search/v1' } : {}), instructions });
    const identity = { scope, runId, sessionId, turnId: scopedCallbacks ? runId : 'turn-1',
      buildId: `engine-preset-${preset.preset}-${preset.revision}`,
      parentRunId: null, taskChainId: runId };
    return { identity, configuration, preset: { preset: preset.preset, revision: preset.revision },
      hostTools: hosted.map(tool => tool.name) };
  }

  /** Admit a new Run. The Run freezes the preset and instructions it starts with. */
  function start(input) {
    const { identity, configuration, preset, hostTools } = prepareRun(input);
    kernel.start(initialSnapshot(identity, configuration, digest(configuration)), configuration);
    return { runId: input.runId, preset, hostTools };
  }

  return {
    scope, workspaceRoot: root,
    info: () => ({ contract: ENGINE_RUNTIME_CONTRACT, preset: (({ preset, revision }) => ({ preset, revision }))(resolveEnginePreset()),
      instructions: { policy: NATIVE_ENGINE_INSTRUCTION_ASSEMBLY, baseRevision: engineBaseInstructions().revision },
      model: { name: description.modelName, protocol: description.protocol, contextWindow: description.contextWindow,
        requestOutputTokens: description.maxOutputTokens, images: supportsImages },
      tools: bound.map(tool => tool.name),
      // Every name a host tool may not use: engine tools plus the control tools the preset or discovery can add.
      reservedToolNames: [...new Set([...[...bound, ...childDefinitions, ...enginePresetToolDefinitions(resolveEnginePreset()), ...toolDiscoveryDefinitions(),
        ...todoToolDefinitions(true), ...todoToolDefinitions(false)].map(tool => tool.name), ...KERNEL_TOOL_NAMES])].sort(),
      hostToolNamePattern: HOST_TOOL_NAME.source }),
    start, prepareRun, ports,
    async run(runId, options) {
      const snapshot = await kernel.runUntilIdle(scope, runId, options);
      if (children && terminal(snapshot.phase)) await children.owner.releaseRun({ scope, runId });
      return snapshot;
    },
    submit: (runId, command) => kernel.submit(scope, runId, command),
    pendingApproval(snapshot, configuration) {
      const pending = snapshot.pendingInteraction;
      if (!pending || pending.approvalPolicy !== DURABLE_APPROVAL && !snapshot.childApproval) return null;
      const call = snapshot.childApproval?.toolCall ?? snapshot.pendingTools.find(tool => tool.callId === pending.callId);
      if (!call) return null;
      const subject = engineApprovalSubject(call);
      const tools = snapshot.childApproval
        ? store.authority(snapshot.childApproval.childScope, snapshot.childApproval.childRunId).configuration.tools
        : configuration.tools;
      return { interactionId: pending.interactionId, callId: pending.callId, tool: call.name,
        ...(tools.some(tool => tool.name === call.name && (tool.hostApprovalRequired
          || tool.hostEffectProtocol === ENGINE_HOST_EFFECT)) ? { requiresUserApproval: true } : {}),
        ...(snapshot.childApproval ? { childRunId: snapshot.childApproval.childRunId } : {}),
        ...(subject ? { subject } : {}) };
    },
    load: runId => store.load(scope, runId),
    completedHostObservations: record => completedHostObservations(store, scope, record),
    authority: runId => store.authority(scope, runId),
    pendingCommands: runId => store.pendingCommands(scope, runId),
    events: (runId, cursor) => store.events(scope, runId, cursor),
    terminal: snapshot => terminal(snapshot.phase),
    async close() { lifetime.abort(); await children?.owner.drain(); if (!runStore) store.close(); },
  };
}
