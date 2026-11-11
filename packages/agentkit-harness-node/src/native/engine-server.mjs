#!/usr/bin/env node
// agentkit.engine/v1 — the Native engine as its own process.
//
// JSON-RPC 2.0 over NDJSON on stdio. One process serves one workspace and one
// session; the host starts it, speaks the protocol and never imports engine
// code. Upgrading the engine is replacing this executable.
//
// Host -> engine: initialize, run/start, run/status, run/events (cursor
//   long-poll), run/resume, run/approve (durable service approval), run/cancel, shutdown.
// Engine -> host: host/approveTool, only when the host declared the
//   `approvals` service during initialize (otherwise the startup `--approval`
//   policy decides), and host/callTool for tools the host passed in
//   run/start `hostTools`, only when the host declared the `tools` service.
//
// The protocol is additive: new methods, fields and event kinds may appear in
// any release. A host must ignore what it does not understand and decide by
// the capabilities returned from initialize, never by the engine version.
//
// Trusted startup configuration (arguments and environment) fixes the
// workspace, the state directory and the model binding. The protocol cannot
// widen them. The model API key is read from the environment per request and
// never enters stdout, events or the Run store. stdout carries protocol frames
// only; diagnostics go to stderr.
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import * as readline from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isNativeError } from '@kingsoftcloud/agentkit-harness-core';
import { publicErrorMessage } from '@kingsoftcloud/agentkit-harness-core/error-presentation';
import { createEngineRuntime, engineApprovalSubject, ENGINE_APPROVAL_CONTRACT, ENGINE_EXECUTION_POLICY,
  ENGINE_INPUT_IMAGES } from './engine-runtime.mjs';
import { ENGINE_VIEW_CONTRACT } from './engine-view-store.mjs';
import { ENGINE_TOOL_POLICY } from './engine-tool-policy.mjs';
import { ENGINE_CONTEXT } from './engine-context.mjs';
import { ENGINE_HOOKS } from './engine-hooks.mjs';
import { ENGINE_HOST_EFFECT } from './engine-host-effects.mjs';
import { ENGINE_VERIFICATION } from './engine-verification.mjs';
export { ENGINE_VIEW_CONTRACT };

export const ENGINE_PROTOCOL = 'agentkit.engine/v1';
export const ENGINE_EVENT_SCHEMA = 'agentkit.engine-event/v1';
const METHODS = ['initialize', 'run/start', 'run/status', 'run/events', 'run/resume', 'run/cancel', 'ui/view', 'shutdown'];
const DURABLE_APPROVAL_METHOD = 'run/approve';
const HOST_OBSERVATIONS_METHOD = 'run/host-observations';
const ERRORS = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603,
  notInitialized: -32010, runNotFound: -32011, runBusy: -32012 };
const text = value => typeof value === 'string' && value.trim().length > 0;
const sleep = ms => new Promise(done => setTimeout(done, ms));

/** The engine's own task view, built by agentkit-harness-ui into this package's dist. */
let viewCache;
export function engineView() {
  if (viewCache !== undefined) return viewCache;
  try {
    const html = readFileSync(new URL('../../dist/engine-view.html', import.meta.url), 'utf8');
    viewCache = { contract: ENGINE_VIEW_CONTRACT, version: packageVersion(), contentType: 'text/html; charset=utf-8',
      sha256: createHash('sha256').update(html).digest('hex'), html };
  } catch { viewCache = null; }
  return viewCache;
}

function packageVersion() {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; }
}

/** Stable, host-renderable projection. Engine-internal payloads stay in the Run
 * store; a host renders `kind`, `title` and `detail` without knowing each kind. */
export function projectEngineEvent(event, requiredVerification = false) {
  const payload = event.payload ?? {}, base = { schema: ENGINE_EVENT_SCHEMA, seq: event.seq, kind: event.kind };
  switch (event.kind) {
    case 'model.completed': return { ...base, category: 'model', title: payload.kind ?? 'model',
      ...(text(payload.text) && !(requiredVerification && payload.kind === 'final_candidate') ? { detail: payload.text } : {}),
      ...(Array.isArray(payload.toolCalls) && payload.toolCalls.length ? { tools: payload.toolCalls.map(call => call.name),
        calls: payload.toolCalls.map(call => ({ callId: call.callId, name: call.name, arguments: bounded(call.arguments) })) } : {}),
      ...(payload.usage ? { usage: { inputTokens: payload.usage.inputTokens, outputTokens: payload.usage.outputTokens } } : {}) };
    case 'tool.completed': return { ...base, category: 'tool', title: payload.name, status: payload.status,
      ...(text(payload.callId) ? { callId: payload.callId } : {}), ...(payload.content === undefined ? {} : { result: bounded(payload.content) }) };
    case 'approval.requested': return { ...base, category: 'approval', title: payload.name, status: 'pending',
      callId: payload.callId, interactionId: payload.interactionId,
      ...(payload.source === 'child_tool' ? { approvalContract: ENGINE_APPROVAL_CONTRACT,
        childRunId: payload.childRunId, detail: engineApprovalSubject(payload) } : {}),
      ...(payload.content?.contract === ENGINE_APPROVAL_CONTRACT ? { approvalContract: ENGINE_APPROVAL_CONTRACT,
        ...(text(payload.content.subject) ? { detail: payload.content.subject } : {}) } : {}) };
    case 'approval.resolved': return { ...base, category: 'approval', status: payload.decision,
      callId: payload.callId, interactionId: payload.interactionId };
    case 'model.failure_observed': return { ...base, category: 'model', title: 'model_failure', status: 'retrying', detail: payload.code };
    case 'run.started': return { ...base, category: 'run', title: 'started' };
    case 'run.terminal': return { ...base, category: 'run', title: payload.phase, status: payload.outcome,
      ...(requiredVerification ? { requiredVerification: true } : {}),
      ...(payload.reason ? { reason: payload.reason } : {}),
      ...(text(payload.finalText) && (!requiredVerification || payload.outcome === 'verified') ? { detail: payload.finalText } : {}) };
    default: return { ...base, category: event.kind.split('.')[0] };
  }
}

/** Bound a value carried in a projected event: views show previews, never whole files. */
const PREVIEW_CHARS = 4000;
function bounded(value) {
  if (value === undefined || value === null) return value ?? null;
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  if (encoded.length <= PREVIEW_CHARS) return typeof value === 'string' ? value : JSON.parse(encoded);
  return { truncated: true, preview: encoded.slice(0, PREVIEW_CHARS), chars: encoded.length };
}

export async function serveEngine({ input, output, log = () => {}, startup, env = process.env, fetchImpl = fetch, detachOnShutdown = false, viewStore }) {
  const frames = readline.createInterface({ input, crlfDelay: Infinity });
  const send = frame => output.write(`${JSON.stringify(frame)}\n`);
  const pending = new Map(), active = new Map(), driven = new Set();
  let host = null, runtime = null, runtimePromise, closing = false;
  const viewRef = viewStore ? viewStore.archive(engineView()) : null;

  const callHost = (method, params, timeoutMs, signal) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const id = `engine-${randomUUID()}`;
    const finish = () => { pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = error => { finish(); reject(error); };
    const abort = () => fail(signal.reason);
    const timer = setTimeout(() => fail(new Error('host request timed out')), timeoutMs);
    pending.set(id, { resolve: value => { finish(); resolve(value); }, reject: fail });
    signal?.addEventListener('abort', abort, { once: true });
    send({ jsonrpc: '2.0', id, method, params, expiresAt: Date.now() + timeoutMs });
  });
  const authorize = async request => {
    if (!host?.services?.approvals) return startup.approval === 'allow' ? 'allow' : 'deny';
    try {
      const reply = await callHost('host/approveTool', { tool: request.call?.name ?? null, arguments: request.call?.arguments ?? {},
        runId: request.runId ?? null }, startup.approvalTimeoutMs);
      return reply?.decision === 'allow' ? 'allow' : 'deny';
    } catch (error) { log(`approval unavailable: ${publicErrorMessage(error)}`); return 'deny'; }
  };
  const callHostTool = async ({ runId, callId, name, arguments: args, timeoutMs, signal, effect }) => {
    if (!host?.services?.tools) return { status: 'error', content: { code: 'host_tools_unavailable', message: 'The host did not declare tool execution.' } };
    return callHost('host/callTool', { runId, callId, name, arguments: args, ...(effect ? { effect } : {}) },
      timeoutMs + 5000, effect ? signal : undefined);
  };
  const callHostContext = async (params, timeoutMs, signal) => {
    if (!host?.services?.context) throw new Error('host context service unavailable');
    return callHost('host/readContext', params, timeoutMs, signal);
  };
  const callHostHook = async (params, timeoutMs, signal) => {
    if (!host?.services?.hooks) throw new Error('host Hook service unavailable');
    return callHost('host/invokeHook', params, timeoutMs, signal);
  };
  const callHostVerification = async (params, timeoutMs, signal) => {
    if (!host?.services?.verification) throw new Error('host verification unavailable');
    return callHost('host/verifyGoal', params, timeoutMs, signal);
  };

  // Highest event seq seen per Run, so status never rescans the whole journal.
  const seen = new Map();
  const tail = runId => {
    const events = runtime.events(runId, seen.get(runId) ?? 0);
    if (events.length) seen.set(runId, events.at(-1).seq);
    return seen.get(runId) ?? 0;
  };
  const status = runId => {
    const { snapshot, configuration } = runtime.authority(runId);
    const pendingApproval = runtime.pendingApproval(snapshot, configuration);
    return { runId, phase: snapshot.phase, outcome: snapshot.outcome ?? null, reason: snapshot.reason ?? null,
      terminal: runtime.terminal(snapshot), running: active.has(runId), usage: snapshot.usage,
      finalText: configuration.hostVerification && snapshot.outcome !== 'verified' ? null
        : snapshot.finalText ?? snapshot.candidate?.text ?? null, cursor: tail(runId),
      ...(pendingApproval ? { pendingApproval } : {}),
      ...(viewStore ? { view: viewStore.reference(startup.stateDir, runId) } : {}) };
  };
  const drive = runId => {
    if (closing || active.has(runId)) return;
    driven.add(runId);
    const controller = new AbortController();
    const runOptions = detachOnShutdown ? { detachSignal: controller.signal } : { signal: controller.signal };
    const execute = async () => {
      let deadline;
      for (;;) {
        try { return await runtime.run(runId, runOptions); }
        catch (error) {
          if (!detachOnShutdown || !isNativeError(error) || error.code !== 'lease_busy') throw error;
          // After an unclean shutdown, let the previous lease expire. A
          // healthy owner that renews its lease still wins.
          deadline ??= Date.now() + runtime.authority(runId).configuration.limits.leaseMs + 500;
          if (Date.now() >= deadline) throw error;
          await wait(250, undefined, { signal: controller.signal });
        }
      }
    };
    const done = execute()
      .catch(error => {
        if (!detachOnShutdown || !controller.signal.aborted)
          log(`run ${runId} stopped: ${isNativeError(error) ? error.code : publicErrorMessage(error)}`);
      })
      .finally(() => active.delete(runId));
    active.set(runId, { controller, done });
  };
  const lookup = runId => {
    try { return runtime.authority(runId); }
    catch (error) {
      if (isNativeError(error) && error.code === 'run_not_found') return null;
      throw error;
    }
  };
  const hasScopedCallbacks = record => record.configuration.hooks.length > 0
    || !!record.configuration.hostVerification
    || record.configuration.contextSources.some(source => source.hostProjection)
    || record.configuration.tools.some(tool => tool.hostEffectProtocol === ENGINE_HOST_EFFECT);
  const continueOnSubscription = (runId, record) => {
    if (hasScopedCallbacks(record)) driven.delete(runId);
    else drive(runId);
  };

  const handlers = {
    async initialize(params) {
      const offered = Array.isArray(params?.protocolVersions) ? params.protocolVersions : [];
      if (!offered.includes(ENGINE_PROTOCOL)) throw rpcError(ERRORS.params, 'no common protocol version', { supported: [ENGINE_PROTOCOL] });
      host = { name: text(params.host?.name) ? params.host.name : 'unknown',
        services: { approvals: params.services?.approvals === true, tools: params.services?.tools === true,
          context: detachOnShutdown && params.services?.context === ENGINE_CONTEXT,
          hooks: detachOnShutdown && params.services?.hooks === ENGINE_HOOKS,
          verification: detachOnShutdown && params.services?.verification === ENGINE_VERIFICATION,
          toolEffects: detachOnShutdown && params.services?.toolEffects === ENGINE_HOST_EFFECT,
          durableApprovals: detachOnShutdown && params.services?.durableApprovals === true } };
      runtimePromise ??= createEngineRuntime({ workspaceRoot: startup.workspace, stateDir: startup.stateDir, sessionId: startup.sessionId,
        scope: startup.scope, authorize, callHostTool, callHostContext, callHostHook, callHostVerification, fetchImpl, sourceEnv: env,
        commandSandbox: startup.commandSandbox,
        subAgents: detachOnShutdown ? startup.subAgents : undefined,
        model: { ...startup.model, apiKey: async () => env[startup.model.apiKeyEnv] ?? '' } })
        .catch(error => { runtimePromise = null; throw error; });
      runtime = await runtimePromise;
      return { protocolVersion: ENGINE_PROTOCOL, engine: { name: '@kingsoftcloud/agentkit-harness-node', version: packageVersion(), ...runtime.info() },
        capabilities: { methods: detachOnShutdown ? [...METHODS, DURABLE_APPROVAL_METHOD,
          ...(host.services.toolEffects ? [HOST_OBSERVATIONS_METHOD] : [])] : METHODS,
          eventSchema: ENGINE_EVENT_SCHEMA, hostServices: ['approvals', 'tools'],
          approvals: host.services.durableApprovals ? 'durable' : host.services.approvals ? 'host' : startup.approval,
          hostTools: host.services.tools, toolPolicy: ENGINE_TOOL_POLICY, executionPolicy: ENGINE_EXECUTION_POLICY,
          ...(detachOnShutdown ? { scopedHostRequests: true } : {}),
          ...(host.services.context ? { hostContext: ENGINE_CONTEXT } : {}),
          ...(host.services.hooks ? { hostHooks: ENGINE_HOOKS } : {}),
          ...(host.services.verification ? { hostVerification: ENGINE_VERIFICATION } : {}),
          ...(host.services.toolEffects ? { hostToolEffects: ENGINE_HOST_EFFECT } : {}),
          ...(runtime.info().model.images ? { inputImages: ENGINE_INPUT_IMAGES } : {}),
          ...(engineView() ? { ui: { contract: ENGINE_VIEW_CONTRACT, sha256: engineView().sha256 } } : {}) } };
    },
    async 'run/start'(params) {
      if (!text(params?.objective)) throw rpcError(ERRORS.params, 'objective is required');
      if (params.hostTools?.length && !host.services.tools) throw rpcError(ERRORS.params, 'hostTools require the tools host service');
      if (params.hostContext !== undefined && !host.services.context)
        throw rpcError(ERRORS.params, 'hostContext requires a negotiated context host service');
      if (params.hostHooks !== undefined && !host.services.hooks)
        throw rpcError(ERRORS.params, 'hostHooks requires a negotiated Hook host service');
      if (params.hostVerification !== undefined && !host.services.verification)
        throw rpcError(ERRORS.params, 'hostVerification requires a negotiated verification service');
      const hostEffects = Array.isArray(params.hostTools) && params.hostTools.some(tool => tool?.effectProtocol !== undefined);
      if (hostEffects && !host.services.toolEffects)
        throw rpcError(ERRORS.params, 'host tool effects require a negotiated host service');
      const runId = text(params.runId) ? params.runId : `run-${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 24)}`;
      const existing = lookup(runId);
      if (existing) {
        if (!hasScopedCallbacks(existing)) drive(runId);
        return { ...status(runId), existing: true };
      }
      viewStore?.pin(startup.stateDir, runId, viewRef);
      const started = runtime.start({ runId, objective: params.objective, conversation: params.conversation, inputImages: params.inputImages, hostInstructions: params.hostInstructions ?? '', hostTools: params.hostTools, toolPolicy: params.toolPolicy,
        durableApprovals: host.services.durableApprovals, hostContext: params.hostContext, hostHooks: params.hostHooks,
        hostVerification: params.hostVerification,
        executionPolicy: params.executionPolicy,
        ...(params.preset === undefined ? {} : { preset: params.preset }), maxModelCalls: params.maxModelCalls ?? null });
      // A subscribed host is required to service budgeted context and Hook callbacks.
      if (!params.hostContext?.sources?.length && !params.hostHooks?.hooks?.length && !hostEffects && !params.hostVerification) drive(runId);
      return { ...status(runId), preset: started.preset, hostTools: started.hostTools, existing: false };
    },
    async 'run/status'(params) { requireRun(params); return status(params.runId); },
    async [HOST_OBSERVATIONS_METHOD](params) {
      if (!host.services.toolEffects) throw rpcError(ERRORS.method, 'host observations unavailable');
      requireRun(params);
      const result = runtime.completedHostObservations(runtime.load(params.runId));
      if (!result) throw rpcError(ERRORS.params, 'host observations unavailable for this Run');
      return result;
    },
    async 'run/events'(params) {
      const { runId } = params;
      const { snapshot, configuration } = requireRun(params);
      if (detachOnShutdown && params.follow === true && !driven.has(runId) && !runtime.terminal(snapshot)) {
        const idle = ['paused', 'awaiting_interaction', 'awaiting_reconciliation'].includes(snapshot.phase);
        if (!idle || runtime.pendingCommands(runId).length) drive(runId);
      }
      const cursor = Number.isSafeInteger(params.cursor) && params.cursor >= 0 ? params.cursor : 0;
      const deadline = Date.now() + Math.min(Math.max(Number(params.waitMs) || 0, 0), 30000);
      // The wait reads only the journal suffix; the Run record is loaded once, on return.
      for (;;) {
        const running = active.has(params.runId), events = runtime.events(params.runId, cursor);
        if (events.length || !running || Date.now() >= deadline) {
          const next = events.length ? events.at(-1).seq : cursor;
          if (next > (seen.get(params.runId) ?? 0)) seen.set(params.runId, next);
          return { events: events.map(event => projectEngineEvent(event, !!configuration.hostVerification)), cursor: next,
            terminal: runtime.terminal(runtime.authority(runId).snapshot), running: active.has(runId) };
        }
        await sleep(250);
      }
    },
    async 'run/resume'(params) {
      const record = requireRun(params);
      if (active.has(params.runId)) throw rpcError(ERRORS.runBusy, 'run is already running');
      const before = status(params.runId);
      if (before.phase === 'paused') runtime.submit(params.runId, { commandId: `resume-${randomUUID()}`, kind: 'resume', payload: {} });
      if (!before.terminal) continueOnSubscription(params.runId, record);
      return status(params.runId);
    },
    async [DURABLE_APPROVAL_METHOD](params) {
      requireRun(params);
      if (!detachOnShutdown || !text(params.interactionId) || !['allow', 'deny'].includes(params.decision))
        throw rpcError(ERRORS.params, 'interactionId and approval decision are required');
      const { runId, interactionId, decision } = params;
      const commandId = `approval-${createHash('sha256').update(interactionId).digest('hex')}`;
      const record = runtime.load(runId);
      if (!record.commands.some(row => row.command.commandId === commandId)
        && runtime.pendingApproval(record.snapshot, record.configuration)?.interactionId !== interactionId)
        throw rpcError(ERRORS.params, 'interaction_mismatch');
      const receipt = runtime.submit(runId, { commandId, kind: 'submit_interaction', payload: { interactionId, decision } });
      if (receipt.status !== 'rejected') {
        const continueRun = () => { if (!closing && !status(runId).terminal) continueOnSubscription(runId, record); };
        const running = active.get(runId);
        if (running) {
          if (receipt.status === 'accepted') void running.done.then(continueRun);
        } else continueRun();
      }
      return receipt;
    },
    async 'run/cancel'(params) {
      requireRun(params);
      runtime.submit(params.runId, { commandId: `cancel-${randomUUID()}`, kind: 'cancel', payload: {} });
      if (!active.has(params.runId) && !status(params.runId).terminal) drive(params.runId);
      return status(params.runId);
    },
    async 'ui/view'(params) {
      const view = params.sha256 === undefined ? engineView() : viewStore?.get(params.sha256);
      if (!view) throw rpcError(ERRORS.method, 'this engine build ships no task view');
      return view;
    },
    async shutdown() { closing = true; return { ok: true }; },
  };
  function requireRun(params) {
    if (!text(params?.runId)) throw rpcError(ERRORS.params, 'runId is required');
    const record = lookup(params.runId);
    if (!record) throw rpcError(ERRORS.runNotFound, 'run not found');
    return record;
  }

  for await (const line of frames) {
    if (!line.trim()) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: ERRORS.parse, message: 'Parse error' } }); continue; }
    if (frame && frame.method === undefined && pending.has(frame.id)) {
      const waiter = pending.get(frame.id); pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(String(frame.error.message ?? 'host error'))); else waiter.resolve(frame.result);
      continue;
    }
    if (!frame || frame.jsonrpc !== '2.0' || !text(frame.method)) {
      send({ jsonrpc: '2.0', id: frame?.id ?? null, error: { code: ERRORS.request, message: 'Invalid Request' } }); continue;
    }
    // Requests run concurrently so a long poll never blocks a cancel or an approval reply.
    void (async () => {
      const reply = body => { if (frame.id !== undefined) send({ jsonrpc: '2.0', id: frame.id, ...body }); };
      try {
        if (!Object.hasOwn(handlers, frame.method)) throw rpcError(ERRORS.method, 'Method not found');
        if (frame.method !== 'initialize' && !runtime) throw rpcError(ERRORS.notInitialized, 'initialize first');
        reply({ result: await handlers[frame.method](frame.params ?? {}) });
      } catch (error) {
        reply({ error: error.rpc ?? { code: isNativeError(error) ? ERRORS.params : ERRORS.internal,
          message: isNativeError(error) ? error.code : publicErrorMessage(error) } });
      }
      if (closing) frames.close();
    })();
  }
  closing = true;
  for (const { controller } of active.values()) controller.abort();
  for (const waiter of pending.values()) waiter.reject(new Error('engine closing'));
  await Promise.allSettled([...active.values()].map(item => item.done));
  await (await runtimePromise?.catch(() => null))?.close();
}
function rpcError(code, message, data) { return Object.assign(new Error(message), { rpc: { code, message, ...(data ? { data } : {}) } }); }

export function engineStartupFromArgs(argv, env) {
  const { values } = parseArgs({ args: argv, options: { workspace: { type: 'string' }, 'state-dir': { type: 'string' },
    session: { type: 'string' }, approval: { type: 'string' }, tenant: { type: 'string' }, user: { type: 'string' }, agent: { type: 'string' } } });
  const need = (value, name) => { if (!text(value)) throw new Error(`${name} is required`); return value; };
  const number = name => env[name] === undefined ? undefined : Number(env[name]);
  const approval = values.approval ?? 'deny';
  if (!['allow', 'deny'].includes(approval)) throw new Error('--approval must be allow or deny');
  let subAgents;
  if (env.AGENTKIT_ENGINE_CHILD_ROLES !== undefined) {
    try { subAgents = JSON.parse(env.AGENTKIT_ENGINE_CHILD_ROLES); }
    catch { throw new Error('AGENTKIT_ENGINE_CHILD_ROLES must be a JSON array'); }
    if (!Array.isArray(subAgents)) throw new Error('AGENTKIT_ENGINE_CHILD_ROLES must be a JSON array');
  }
  return { workspace: need(values.workspace, '--workspace'), stateDir: need(values['state-dir'], '--state-dir'),
    subAgents,
    sessionId: values.session ?? 'engine-session', approval, approvalTimeoutMs: number('AGENTKIT_ENGINE_APPROVAL_TIMEOUT_MS') ?? 600000,
    scope: { tenantId: values.tenant ?? 'local', workspaceId: 'local', userId: values.user ?? 'local-user', agentId: values.agent ?? 'engine' },
    model: { protocol: env.AGENTKIT_ENGINE_MODEL_PROTOCOL ?? 'openai-chat', name: need(env.AGENTKIT_ENGINE_MODEL_NAME, 'AGENTKIT_ENGINE_MODEL_NAME'),
      baseUrl: need(env.AGENTKIT_ENGINE_MODEL_BASE_URL, 'AGENTKIT_ENGINE_MODEL_BASE_URL'),
      apiKeyEnv: env.AGENTKIT_ENGINE_MODEL_API_KEY_ENV ?? 'AGENTKIT_ENGINE_MODEL_API_KEY',
      contextWindow: number('AGENTKIT_ENGINE_MODEL_CONTEXT_WINDOW'), maxOutputTokens: number('AGENTKIT_ENGINE_MODEL_MAX_OUTPUT_TOKENS'),
      requestOutputTokens: number('AGENTKIT_ENGINE_MODEL_REQUEST_OUTPUT_TOKENS'), images: env.AGENTKIT_ENGINE_MODEL_IMAGES === '1' } };
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); }
  catch { return false; }
}

if (isMain()) {
  let startup;
  try { startup = engineStartupFromArgs(process.argv.slice(2), process.env); }
  catch (error) { process.stderr.write(`agentkit-engine: ${error.message}\n`); process.exit(2); }
  serveEngine({ input: process.stdin, output: process.stdout, startup, log: message => process.stderr.write(`agentkit-engine: ${message}\n`) })
    .then(() => process.exit(0), error => { process.stderr.write(`agentkit-engine: ${publicErrorMessage(error)}\n`); process.exit(1); });
}
