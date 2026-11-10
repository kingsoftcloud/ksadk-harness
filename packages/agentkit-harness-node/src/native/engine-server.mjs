#!/usr/bin/env node
// agentkit.engine/v1 — the Native engine as its own process.
//
// JSON-RPC 2.0 over NDJSON on stdio. One process serves one workspace and one
// session; the host starts it, speaks the protocol and never imports engine
// code. Upgrading the engine is replacing this executable.
//
// Host -> engine: initialize, run/start, run/status, run/events (cursor
//   long-poll), run/resume, run/cancel, shutdown.
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
import { readFileSync } from 'node:fs';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isNativeError } from '@kingsoftcloud/agentkit-harness-core';
import { publicErrorMessage } from '@kingsoftcloud/agentkit-harness-core/error-presentation';
import { createEngineRuntime } from './engine-runtime.mjs';

export const ENGINE_PROTOCOL = 'agentkit.engine/v1';
export const ENGINE_EVENT_SCHEMA = 'agentkit.engine-event/v1';
const METHODS = ['initialize', 'run/start', 'run/status', 'run/events', 'run/resume', 'run/cancel', 'ui/view', 'shutdown'];
export const ENGINE_VIEW_CONTRACT = 'agentkit.engine-view/v1';
const ERRORS = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603,
  notInitialized: -32010, runNotFound: -32011, runBusy: -32012 };
const text = value => typeof value === 'string' && value.trim().length > 0;
const sleep = ms => new Promise(done => setTimeout(done, ms));

/** The engine's own task view, built by agentkit-harness-ui into this package's dist. */
let viewCache;
function engineView() {
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
export function projectEngineEvent(event) {
  const payload = event.payload ?? {}, base = { schema: ENGINE_EVENT_SCHEMA, seq: event.seq, kind: event.kind };
  switch (event.kind) {
    case 'model.completed': return { ...base, category: 'model', title: payload.kind ?? 'model',
      ...(text(payload.text) ? { detail: payload.text } : {}),
      ...(Array.isArray(payload.toolCalls) && payload.toolCalls.length ? { tools: payload.toolCalls.map(call => call.name),
        calls: payload.toolCalls.map(call => ({ callId: call.callId, name: call.name, arguments: bounded(call.arguments) })) } : {}),
      ...(payload.usage ? { usage: { inputTokens: payload.usage.inputTokens, outputTokens: payload.usage.outputTokens } } : {}) };
    case 'tool.completed': return { ...base, category: 'tool', title: payload.name, status: payload.status,
      ...(text(payload.callId) ? { callId: payload.callId } : {}), ...(payload.content === undefined ? {} : { result: bounded(payload.content) }) };
    case 'model.failure_observed': return { ...base, category: 'model', title: 'model_failure', status: 'retrying', detail: payload.code };
    case 'run.started': return { ...base, category: 'run', title: 'started' };
    case 'run.terminal': return { ...base, category: 'run', title: payload.phase, status: payload.outcome,
      ...(payload.reason ? { reason: payload.reason } : {}), ...(text(payload.finalText) ? { detail: payload.finalText } : {}) };
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

export async function serveEngine({ input, output, log = () => {}, startup, env = process.env, fetchImpl = fetch }) {
  const frames = readline.createInterface({ input, crlfDelay: Infinity });
  const send = frame => output.write(`${JSON.stringify(frame)}\n`);
  const pending = new Map(), active = new Map();
  let host = null, runtime = null, closing = false;

  const callHost = (method, params, timeoutMs) => new Promise((resolve, reject) => {
    const id = `engine-${randomUUID()}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('host request timed out')); }, timeoutMs);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const authorize = async request => {
    if (!host?.services?.approvals) return startup.approval === 'allow' ? 'allow' : 'deny';
    try {
      const reply = await callHost('host/approveTool', { tool: request.call?.name ?? null, arguments: request.call?.arguments ?? {},
        runId: request.runId ?? null }, startup.approvalTimeoutMs);
      return reply?.decision === 'allow' ? 'allow' : 'deny';
    } catch (error) { log(`approval unavailable: ${publicErrorMessage(error)}`); return 'deny'; }
  };
  const callHostTool = async ({ runId, callId, name, arguments: args, timeoutMs }) => {
    if (!host?.services?.tools) return { status: 'error', content: { code: 'host_tools_unavailable', message: 'The host did not declare tool execution.' } };
    return callHost('host/callTool', { runId, callId, name, arguments: args }, timeoutMs + 5000);
  };

  // Highest event seq seen per Run, so status never rescans the whole journal.
  const seen = new Map();
  const tail = runId => {
    const events = runtime.events(runId, seen.get(runId) ?? 0);
    if (events.length) seen.set(runId, events.at(-1).seq);
    return seen.get(runId) ?? 0;
  };
  const status = runId => {
    const snapshot = runtime.load(runId).snapshot;
    return { runId, phase: snapshot.phase, outcome: snapshot.outcome ?? null, reason: snapshot.reason ?? null,
      terminal: runtime.terminal(snapshot), running: active.has(runId), usage: snapshot.usage,
      finalText: snapshot.finalText ?? snapshot.candidate?.text ?? null, cursor: tail(runId) };
  };
  const drive = runId => {
    if (active.has(runId)) return;
    const controller = new AbortController();
    const done = runtime.run(runId, { signal: controller.signal })
      .catch(error => log(`run ${runId} stopped: ${isNativeError(error) ? error.code : publicErrorMessage(error)}`))
      .finally(() => active.delete(runId));
    active.set(runId, { controller, done });
  };
  const known = runId => { try { runtime.load(runId); return true; } catch { return false; } };

  const handlers = {
    async initialize(params) {
      const offered = Array.isArray(params?.protocolVersions) ? params.protocolVersions : [];
      if (!offered.includes(ENGINE_PROTOCOL)) throw rpcError(ERRORS.params, 'no common protocol version', { supported: [ENGINE_PROTOCOL] });
      host = { name: text(params.host?.name) ? params.host.name : 'unknown',
        services: { approvals: params.services?.approvals === true, tools: params.services?.tools === true } };
      runtime ??= await createEngineRuntime({ workspaceRoot: startup.workspace, stateDir: startup.stateDir, sessionId: startup.sessionId,
        scope: startup.scope, authorize, callHostTool, fetchImpl, sourceEnv: env,
        model: { ...startup.model, apiKey: async () => env[startup.model.apiKeyEnv] ?? '' } });
      return { protocolVersion: ENGINE_PROTOCOL, engine: { name: '@kingsoftcloud/agentkit-harness-node', version: packageVersion(), ...runtime.info() },
        capabilities: { methods: METHODS, eventSchema: ENGINE_EVENT_SCHEMA, hostServices: ['approvals', 'tools'], approvals: host.services.approvals ? 'host' : startup.approval,
          hostTools: host.services.tools, ...(engineView() ? { ui: { contract: ENGINE_VIEW_CONTRACT, sha256: engineView().sha256 } } : {}) } };
    },
    async 'run/start'(params) {
      if (!text(params?.objective)) throw rpcError(ERRORS.params, 'objective is required');
      if (params.hostTools?.length && !host.services.tools) throw rpcError(ERRORS.params, 'hostTools require the tools host service');
      const runId = text(params.runId) ? params.runId : `run-${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 24)}`;
      if (known(runId)) { drive(runId); return { ...status(runId), existing: true }; }
      const started = runtime.start({ runId, objective: params.objective, conversation: params.conversation, hostInstructions: params.hostInstructions ?? '', hostTools: params.hostTools,
        ...(params.preset === undefined ? {} : { preset: params.preset }), maxModelCalls: params.maxModelCalls ?? null });
      drive(runId);
      return { ...status(runId), preset: started.preset, hostTools: started.hostTools, existing: false };
    },
    async 'run/status'(params) { requireRun(params); return status(params.runId); },
    async 'run/events'(params) {
      requireRun(params);
      const cursor = Number.isSafeInteger(params.cursor) && params.cursor >= 0 ? params.cursor : 0;
      const deadline = Date.now() + Math.min(Math.max(Number(params.waitMs) || 0, 0), 30000);
      // The wait reads only the journal suffix; the Run record is loaded once, on return.
      for (;;) {
        const running = active.has(params.runId), events = runtime.events(params.runId, cursor);
        if (events.length || !running || Date.now() >= deadline) {
          const next = events.length ? events.at(-1).seq : cursor;
          if (next > (seen.get(params.runId) ?? 0)) seen.set(params.runId, next);
          return { events: events.map(projectEngineEvent), cursor: next,
            terminal: runtime.terminal(runtime.load(params.runId).snapshot), running: active.has(params.runId) };
        }
        await sleep(250);
      }
    },
    async 'run/resume'(params) {
      requireRun(params);
      if (active.has(params.runId)) throw rpcError(ERRORS.runBusy, 'run is already running');
      const before = status(params.runId);
      if (before.phase === 'paused') runtime.submit(params.runId, { commandId: `resume-${randomUUID()}`, kind: 'resume', payload: {} });
      if (!before.terminal) drive(params.runId);
      return status(params.runId);
    },
    async 'run/cancel'(params) {
      requireRun(params);
      runtime.submit(params.runId, { commandId: `cancel-${randomUUID()}`, kind: 'cancel', payload: {} });
      if (!active.has(params.runId) && !status(params.runId).terminal) drive(params.runId);
      return status(params.runId);
    },
    async 'ui/view'() {
      const view = engineView();
      if (!view) throw rpcError(ERRORS.method, 'this engine build ships no task view');
      return view;
    },
    async shutdown() { closing = true; return { ok: true }; },
  };
  function requireRun(params) {
    if (!text(params?.runId)) throw rpcError(ERRORS.params, 'runId is required');
    if (!known(params.runId)) throw rpcError(ERRORS.runNotFound, 'run not found');
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
  for (const { controller } of active.values()) controller.abort();
  await Promise.allSettled([...active.values()].map(item => item.done));
  for (const waiter of pending.values()) waiter.reject(new Error('engine closing'));
  runtime?.close();
}
function rpcError(code, message, data) { return Object.assign(new Error(message), { rpc: { code, message, ...(data ? { data } : {}) } }); }

export function engineStartupFromArgs(argv, env) {
  const { values } = parseArgs({ args: argv, options: { workspace: { type: 'string' }, 'state-dir': { type: 'string' },
    session: { type: 'string' }, approval: { type: 'string' }, tenant: { type: 'string' }, user: { type: 'string' }, agent: { type: 'string' } } });
  const need = (value, name) => { if (!text(value)) throw new Error(`${name} is required`); return value; };
  const number = name => env[name] === undefined ? undefined : Number(env[name]);
  const approval = values.approval ?? 'deny';
  if (!['allow', 'deny'].includes(approval)) throw new Error('--approval must be allow or deny');
  return { workspace: need(values.workspace, '--workspace'), stateDir: need(values['state-dir'], '--state-dir'),
    sessionId: values.session ?? 'engine-session', approval, approvalTimeoutMs: number('AGENTKIT_ENGINE_APPROVAL_TIMEOUT_MS') ?? 600000,
    scope: { tenantId: values.tenant ?? 'local', workspaceId: 'local', userId: values.user ?? 'local-user', agentId: values.agent ?? 'engine' },
    model: { protocol: env.AGENTKIT_ENGINE_MODEL_PROTOCOL ?? 'openai-chat', name: need(env.AGENTKIT_ENGINE_MODEL_NAME, 'AGENTKIT_ENGINE_MODEL_NAME'),
      baseUrl: need(env.AGENTKIT_ENGINE_MODEL_BASE_URL, 'AGENTKIT_ENGINE_MODEL_BASE_URL'),
      apiKeyEnv: env.AGENTKIT_ENGINE_MODEL_API_KEY_ENV ?? 'AGENTKIT_ENGINE_MODEL_API_KEY',
      contextWindow: number('AGENTKIT_ENGINE_MODEL_CONTEXT_WINDOW'), maxOutputTokens: number('AGENTKIT_ENGINE_MODEL_MAX_OUTPUT_TOKENS'),
      requestOutputTokens: number('AGENTKIT_ENGINE_MODEL_REQUEST_OUTPUT_TOKENS'), images: env.AGENTKIT_ENGINE_MODEL_IMAGES === '1' } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let startup;
  try { startup = engineStartupFromArgs(process.argv.slice(2), process.env); }
  catch (error) { process.stderr.write(`agentkit-engine: ${error.message}\n`); process.exit(2); }
  serveEngine({ input: process.stdin, output: process.stdout, startup, log: message => process.stderr.write(`agentkit-engine: ${message}\n`) })
    .then(() => process.exit(0), error => { process.stderr.write(`agentkit-engine: ${publicErrorMessage(error)}\n`); process.exit(1); });
}
