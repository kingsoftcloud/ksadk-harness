import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { canonical, configure, invariant, parseNativeJson, TOOL_RECEIPT_OBSERVATION_CONTRACT } from '@kingsoftcloud/agentkit-harness-core';
import { createEngineRuntime } from './engine-runtime.mjs';
import { ENGINE_HOST_EFFECT, RECEIPT_WAIT_MS, waitForHostReceipt } from './engine-host-effects.mjs';
import { ENGINE_TOOL_POLICY } from './engine-tool-policy.mjs';
import { createManagedSessionDelivery, MANAGED_SESSION_DELIVERY, projectManagedSessionEvent } from './engine-managed-delivery.mjs';
import { createManagedEngineHost, MANAGED_HOST_RESOURCES } from './engine-managed-host.mjs';
import { createNativeKernelPermitVerifier } from './native-kernel-permit.mjs';
import { createManagedNativeKernel, MANAGED_NATIVE_KERNEL_CONTRACT } from './native-managed-kernel.mjs';
import { createManagedNativeKernelHttp, MANAGED_NATIVE_KERNEL_PATH } from './native-managed-kernel-http.mjs';
import { publicErrorMessage } from '@kingsoftcloud/agentkit-harness-core/error-presentation';
import { acquireWorkspaceMutationLock } from './workspace-mutation-lock.mjs';

export { MANAGED_NATIVE_KERNEL_CONTRACT, MANAGED_NATIVE_KERNEL_PATH };
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const platformContractDigest = 'b610a25aae957306b9f84a2cc2c948b30d1ce6218585cfd2a91f96736b92d102';
const harnessCancelPolicy = { schema: 'agent-kernel/required-capabilities/v1', name: 'harness-cancel', required: ['cancel'] };
const validDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

function managedInput(content) {
  if (typeof content === 'string' && content.trim()) return { objective: content };
  invariant(Array.isArray(content), 'NATIVE_MANAGED_STUDIO_INPUT_UNSUPPORTED');
  const text = [], inputImages = [];
  for (const part of content) {
    if (typeof part === 'string') { text.push(part); continue; }
    if (['text', 'input_text'].includes(part?.type) && typeof part.text === 'string') {
      text.push(part.text);
      continue;
    }
    invariant(['image_url', 'input_image'].includes(part?.type), 'NATIVE_MANAGED_STUDIO_INPUT_UNSUPPORTED');
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    invariant(typeof url === 'string' && url.startsWith('data:image/'), 'NATIVE_MANAGED_STUDIO_IMAGE_INVALID');
    inputImages.push({ type: 'image_url', image_url: { url } });
  }
  const objective = text.join('');
  invariant(objective.trim() || inputImages.length, 'NATIVE_MANAGED_STUDIO_INPUT_UNSUPPORTED');
  return { objective: objective.trim() ? objective : 'Inspect the attached image.', inputImages };
}

/** The service owns the managed command journal and its execution store. */
export function createEngineManagedService({ startup, stateDir, workspace, config, env, fetchImpl, log, serviceToken, viewStore, viewRef }) {
  const { buildId, controlPublicKeys, platformApprovals = false, platformKernel } = config;
  const host = config.host === undefined ? undefined : createManagedEngineHost(config.host, env);
  const transportEnv = platformKernel?.transportTokenEnv ?? (platformKernel && env.AGENTKIT_HARNESS_PLATFORM_TRANSPORT_TOKEN !== undefined
    ? 'AGENTKIT_HARNESS_PLATFORM_TRANSPORT_TOKEN' : undefined);
  const transportToken = transportEnv === undefined ? undefined : env[transportEnv];
  invariant(!host || env[config.host.tokenEnv] !== serviceToken
    && env[config.host.tokenEnv] !== env[startup.model.apiKeyEnv], 'engine_managed_host_config_invalid');
  invariant(typeof buildId === 'string' && buildId.trim() && buildId.length <= 256
    && controlPublicKeys && typeof controlPublicKeys === 'object' && !Array.isArray(controlPublicKeys)
    && typeof platformApprovals === 'boolean'
    && (platformKernel === undefined || platformKernel && typeof platformKernel === 'object'
      && Object.keys(platformKernel).every(key => ['bundleDigest', 'transportTokenEnv', 'agentInstanceId'].includes(key))
      && validDigest(platformKernel.bundleDigest)
      && (platformKernel.agentInstanceId === undefined || typeof platformKernel.agentInstanceId === 'string'
        && /^[a-zA-Z0-9._-]{1,64}$/u.test(platformKernel.agentInstanceId)))
    && (config.authorizeInteraction === undefined || !platformApprovals && typeof config.authorizeInteraction === 'function'),
  'engine_managed_config_invalid');
  invariant(transportEnv === undefined || typeof transportEnv === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(transportEnv)
    && typeof transportToken === 'string' && transportToken.length >= 24 && !/\s/u.test(transportToken)
    && ![serviceToken, env[startup.model.apiKeyEnv], host && env[config.host.tokenEnv]].includes(transportToken),
  'engine_managed_platform_transport_invalid');
  const transportDigest = transportToken === undefined ? null : createHash('sha256').update('Bearer ' + transportToken).digest();
  const authorizeInteraction = platformApprovals
    ? ({ command, pending }) => pending.interactionId === command.payload.interaction_id && typeof pending.operationKey === 'string'
    : config.authorizeInteraction;
  const entries = Object.entries(controlPublicKeys);
  invariant(entries.length > 0 && entries.length <= 32, 'engine_managed_config_invalid');
  for (const [id, pem] of entries) {
    invariant(/^[a-zA-Z0-9._-]{1,128}$/.test(id) && typeof pem === 'string'
      && pem.length <= 65536 && createPublicKey(pem).asymmetricKeyType === 'ed25519',
    'engine_managed_control_key_invalid');
  }
  const verificationKeys = new Map(entries);
  const scope = Object.freeze({ ...startup.scope });
  const agentInstanceId = platformKernel?.agentInstanceId ?? scope.agentId;
  const { name, protocol = 'openai-chat', baseUrl } = startup.model;
  const target = { tenantId: scope.tenantId, agentInstanceId,
    ...(agentInstanceId === scope.agentId ? {} : { runScopeAgentId: scope.agentId }),
    engineBinding: digest({ buildId, scope, workspace, model: { name, protocol, baseUrl },
      commandSandbox: startup.commandSandbox ?? null, subAgents: startup.subAgents ?? [] }) };
  const permitVerifier = createNativeKernelPermitVerifier({ target, verificationKeys: async () => verificationKeys,
    requireBoundApproval: platformApprovals });
  let current = true;
  const resolveBinding = Object.assign(async ({ command, runId, store, admission, signal }) => {
    signal.throwIfAborted();
    const { objective, inputImages } = managedInput(command.payload.content);
    const options = command.payload.runtime_options ?? {};
    invariant(typeof options === 'object' && !Array.isArray(options)
      && Object.keys(options).every(key => ['model', 'tool_approval_mode'].includes(key)), 'engine_managed_options_invalid');
    invariant(options.model === undefined || options.model === name, 'engine_managed_model_unavailable');
    invariant(options.tool_approval_mode === undefined || ['ask', 'risk'].includes(options.tool_approval_mode), 'engine_managed_options_invalid');
    const strictApproval = options.tool_approval_mode === 'ask';
    invariant(!strictApproval || authorizeInteraction, 'engine_tool_policy_requires_durable_approvals');
    const sessionId = command.session_id;
    const recovered = admission?.configuration.hostRecoveryBinding;
    invariant(recovered === undefined || host && recovered.contract === MANAGED_HOST_RESOURCES && typeof recovered.ref === 'string',
      'engine_managed_host_binding_unavailable');
    let bindingRef = recovered?.ref;
    const readReceipt = (call, originalOperationKey, receiptSignal, observationId) => {
      invariant(bindingRef, 'engine_managed_host_binding_unavailable');
      return host.receipt({ scope, sessionId, runId, ref: bindingRef, originalOperationKey, callId: call.callId,
        name: call.name, arguments: call.arguments, ...(observationId ? { observationId } : {}) }, receiptSignal);
    };
    const engine = await createEngineRuntime({
      workspaceRoot: workspace, stateDir: join(stateDir, 'managed-resources', digest(sessionId)),
      sessionId, scope, runStore: store, sourceEnv: env, fetchImpl,
      callHostTool: host && (request => {
        invariant(bindingRef && request.runId === runId, 'engine_managed_host_binding_unavailable');
        return host.callTool({ ...request, scope, sessionId, ref: bindingRef });
      }),
      callHostReceipt: host && (async request => {
        invariant(request.runId === runId, 'engine_managed_host_binding_unavailable');
        const result = await readReceipt(request.call, request.originalOperationKey, request.signal, request.operationKey);
        return { contract: request.contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId, result };
      }),
      authorize: async () => 'deny', commandSandbox: startup.commandSandbox, subAgents: startup.subAgents,
      model: { ...startup.model, apiKey: async () => env[startup.model.apiKeyEnv] ?? '' },
    });
    try {
      signal.throwIfAborted();
      let configuration = admission?.configuration;
      let deliverSession = recovered?.sessionDelivery === true;
      if (!configuration) {
        let resources;
        if (host) {
          const { reservedToolNames: reserved, hostToolNamePattern: pattern } = engine.info();
          resources = await host.admit({ scope, sessionId, runId,
            toolCatalog: { reserved, pattern, receiptObservation: TOOL_RECEIPT_OBSERVATION_CONTRACT }, signal });
          signal.throwIfAborted();
          bindingRef = resources.ref;
          deliverSession = resources.sessionDelivery;
          if (deliverSession) viewStore.pin(stateDir, runId, viewRef);
        }
        configuration = engine.prepareRun({ runId, objective, inputImages, originalInput: true, durableApprovals: !!authorizeInteraction,
          ...(strictApproval ? { toolPolicy: { contract: ENGINE_TOOL_POLICY, mode: 'strict', rules: {} } } : {}),
          ...(resources ? { hostInstructions: resources.hostInstructions, hostTools: resources.hostTools.map(tool =>
            tool.readOnly === true ? tool : { ...tool, readOnly: false, effectProtocol: ENGINE_HOST_EFFECT }) } : {}),
        }).configuration;
        if (resources) configuration = configure({ ...configuration,
          hostRecoveryBinding: { contract: MANAGED_HOST_RESOURCES, ref: bindingRef,
            ...(deliverSession ? { sessionDelivery: true } : {}) } });
      }
      const delivery = deliverSession ? createManagedSessionDelivery({
        directory: join(stateDir, 'managed-delivery'), host, ref: bindingRef, scope, sessionId, runId,
        input: objective, source: { provider: 'agentkit-harness', model: name },
        readTerminalFrames: run => runtime.terminalSessionFrames(run),
        view: viewStore.reference(stateDir, runId)?.sha256 ?? null,
      }) : {};
      const hasHostReceipts = configuration.tools.some(tool => tool.hostEffectProtocol === ENGINE_HOST_EFFECT
        && tool.recoveryPolicy === 'receipt-observation/v1');
      function executeWithReceipts({ execute }) {
        let deadline;
        return execute({ onIdle(_snapshot, { signal: idleSignal, assertCurrent }) {
          assertCurrent();
          deadline ??= Date.now() + RECEIPT_WAIT_MS;
          const waitMs = deadline - Date.now();
          return waitMs <= 0 ? null : waitForHostReceipt(store.load(scope, runId), {
            read: readReceipt, signal: idleSignal, assertCurrent, waitMs,
          });
        } });
      }
      return { scope, buildId, configuration, ports: engine.ports, ...delivery,
        ...(hasHostReceipts ? { withExecution: executeWithReceipts } : {}),
        release: () => engine.close() };
    } catch (error) {
      await engine.close();
      throw error;
    }
  }, {
    enqueueContentFormats: Object.freeze(['text/plain']),
    resolveInjectionScope: async ({ signal }) => { signal.throwIfAborted(); return scope; },
  });
  // The separate lock database is held for this process's lifetime. It is
  // released by SQLite on process death and never blocks a contender's loop.
  const releaseOwnership = acquireWorkspaceMutationLock(join(stateDir, 'managed-owner'), { timeoutMs: 0 });
  let runtime;
  try {
    runtime = createManagedNativeKernel({
      directory: join(stateDir, 'managed'), target, permitVerifier, resolveBinding, authorizeInteraction,
      platformApprovals,
      assertCurrent: () => current, projectSessionEvent: projectManagedSessionEvent,
      onWorkerError: ({ error }) => log('managed execution failed: ' + publicErrorMessage(error)),
    });
  } catch (error) { releaseOwnership(); throw error; }
  const transport = createManagedNativeKernelHttp(runtime);
  async function handleSession(request, response, action) {
    const json = (status, payload) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(canonical(payload));
    };
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 32768) {
          response.setHeader('connection', 'close');
          return json(400, { error: 'invalid_request' });
        }
        chunks.push(chunk);
      }
      const body = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      invariant(body?.contract === MANAGED_SESSION_DELIVERY
        && typeof body.runId === 'string' && body.runId.length <= 256
        && typeof body.sessionId === 'string' && body.sessionId.length <= 256
        && (action === 'restore' || typeof body.ref === 'string' && body.ref.length <= 8192)
        && typeof body.configDigest === 'string' && /^[a-f0-9]{64}$/.test(body.configDigest),
      'engine_managed_frame_request_invalid');
      const identity = { scope, sessionId: body.sessionId, runId: body.runId, configDigest: body.configDigest };
      if (action === 'restore') return json(200, { contract: MANAGED_SESSION_DELIVERY, hostCancel: true,
        ...runtime.restoreSessionDelivery(identity), source: { provider: 'agentkit-harness', model: name } });
      if (action === 'cancel') return json(200, { contract: MANAGED_SESSION_DELIVERY,
        ...runtime.cancelSessionDelivery({ ...identity, ref: body.ref }) });
      const events = runtime.readSessionFrames({ ...identity, ref: body.ref, after: body.after });
      return json(200, { contract: MANAGED_SESSION_DELIVERY, cursor: events.at(-1)?.seq ?? body.after,
        view: viewStore.reference(stateDir, body.runId)?.sha256 ?? null, events });
    } catch (error) {
      if (error.code === 'NATIVE_KERNEL_STATUS_IDENTITY_MISMATCH') return json(404, { error: 'run_not_found' });
      return json(400, { error: 'invalid_request' });
    }
  }

  return {
    platformApprovals,
    authorizesPlatformTransport(authorization) {
      return transportDigest !== null && typeof authorization === 'string'
        && timingSafeEqual(transportDigest, createHash('sha256').update(authorization).digest());
    },
    platformHealth: platformKernel && (() => {
      let check;
      try { check = runtime.probePlatform(); } catch { /* Both ledgers must be readable before accepting platform traffic. */ }
      const capabilities = check?.capabilities ?? {};
      const worker = check?.workerRunning === true;
      const capable = capabilities.cancel?.supported === true;
      return { ready: current && worker && capable, store_ok: !!check, worker_running: worker, lease_healthy: current,
        store_driver: 'sqlite-single-writer', agent_instance_id: agentInstanceId, contract_digest: platformContractDigest,
        capability_digest: capable ? digest(harnessCancelPolicy) : digest(capabilities), bundle_digest: platformKernel.bundleDigest,
        capabilities };
    }),
    handle(request, response) {
      if (request.url === MANAGED_NATIVE_KERNEL_PATH + '/session-frames') return handleSession(request, response, 'frames');
      if (request.url === MANAGED_NATIVE_KERNEL_PATH + '/session-restore') return handleSession(request, response, 'restore');
      if (request.url === MANAGED_NATIVE_KERNEL_PATH + '/session-cancel') return handleSession(request, response, 'cancel');
      return transport.handle(request, response);
    },
    async close() {
      current = false;
      transport.close();
      try { await runtime.close(); } finally { releaseOwnership(); }
    },
  };
}
