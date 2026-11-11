#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { engineStartupFromArgs, engineView, serveEngine } from './engine-server.mjs';
import { ENGINE_EXECUTION_POLICY } from './engine-runtime.mjs';
import { createEngineViewStore } from './engine-view-store.mjs';
import { ENGINE_TOOL_POLICY } from './engine-tool-policy.mjs';
import { ENGINE_CONTEXT } from './engine-context.mjs';
import { ENGINE_HOOKS } from './engine-hooks.mjs';
import { ENGINE_HOST_EFFECT } from './engine-host-effects.mjs';
import { ENGINE_VERIFICATION } from './engine-verification.mjs';
import { createEngineManagedService, MANAGED_NATIVE_KERNEL_CONTRACT, MANAGED_NATIVE_KERNEL_PATH } from './engine-managed-service.mjs';
import { isAgentKernelPlatformPath } from './native-managed-kernel-http.mjs';
import { ISOLATED_COMMAND_SHELL, shellCommandArgv } from './command-shell.mjs';

export const ENGINE_SERVICE_CONTRACT = 'agentkit.engine-service/v1';
// Bound the authenticated frame separately from the current-turn media budget.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const hash = value => createHash('sha256').update(value).digest();

function respond(response, status, value) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readFrame(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('frame_too_large');
    chunks.push(chunk);
  }
  const frame = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.jsonrpc !== '2.0'
    || typeof frame.id !== 'string' || !frame.id || frame.id.length > 128) throw new Error('invalid_frame');
  return frame;
}

function openSession(sessionId, startup, env, fetchImpl, log, viewStore) {
  const input = new PassThrough(), output = new PassThrough();
  const frames = createInterface({ input: output, crlfDelay: Infinity });
  const pending = new Map(), hostRequests = new Map(), hostWaiters = new Set();
  const pruneHostRequests = now => {
    for (const [id, request] of hostRequests) {
      if (request.frame.expiresAt <= now) hostRequests.delete(id);
    }
  };
  const done = serveEngine({
    input, output, env, fetchImpl, log, viewStore, detachOnShutdown: true,
    startup: { ...startup, sessionId, stateDir: join(startup.stateDir, hash(sessionId).toString('hex')) },
  }).finally(() => {
    for (const resolve of pending.values()) resolve(null);
    for (const waiter of hostWaiters) waiter(true);
    pending.clear();
    output.end();
  });
  // The server owns the worker lifetime independently of HTTP request lifetime.
  done.catch(() => log('engine session stopped'));
  frames.on('line', line => {
    const frame = JSON.parse(line);
    if (typeof frame.method === 'string') {
      pruneHostRequests(Date.now());
      hostRequests.set(frame.id, { frame, claimed: false });
      for (const waiter of hostWaiters) waiter();
    } else if (pending.has(frame.id)) {
      const resolve = pending.get(frame.id);
      pending.delete(frame.id);
      resolve(frame);
    }
  });
  const takeHostRequests = runId => {
    pruneHostRequests(Date.now());
    const ready = [];
    for (const request of hostRequests.values()) {
      if (!request.claimed && (runId === undefined || request.frame.params?.runId === runId)) {
        request.claimed = true;
        ready.push(request.frame);
      }
    }
    return ready;
  };
  return {
    request(frame) {
      if (pending.has(frame.id)) return null;
      return new Promise(resolve => {
        pending.set(frame.id, resolve);
        input.write(JSON.stringify(frame) + '\n');
      });
    },
    async takeHostRequests(runId, waitMs, response) {
      const available = takeHostRequests(runId);
      if (available.length || !waitMs || response.destroyed) return available;
      return new Promise(resolve => {
        const finish = frames => {
          clearTimeout(timer);
          hostWaiters.delete(notify);
          response.off('close', cancel);
          resolve(frames);
        };
        const cancel = () => finish([]);
        const notify = stopped => {
          if (stopped || response.destroyed) return cancel();
          const ready = takeHostRequests(runId);
          if (ready.length) finish(ready);
        };
        const timer = setTimeout(cancel, waitMs);
        response.once('close', cancel);
        hostWaiters.add(notify);
      });
    },
    reply(frame) {
      const request = hostRequests.get(frame.id);
      if (!request?.claimed || !hostRequests.delete(frame.id) || request.frame.expiresAt <= Date.now()) return false;
      input.write(JSON.stringify(frame) + '\n');
      return true;
    },
    async close() {
      input.end();
      await done;
    },
  };
}

/** One service instance owns one configured workspace and trust boundary.
 * Cloud deployers allocate one instance per isolated runtime. The caller
 * chooses only the opaque session ID, never paths, model URLs or credentials. */
export function createEngineService({ startup, token, env = process.env, fetchImpl = fetch, log = () => {}, maxSessions = 128, tls, managed }) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('engine_service_token_required');
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new Error('invalid_session_limit');
  const auth = hash('Bearer ' + token), sessions = new Map();
  mkdirSync(startup.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = realpathSync(startup.stateDir);
  const workspace = realpathSync(startup.workspace);
  if (workspace === stateDir || workspace.startsWith(stateDir + '/') || stateDir.startsWith(workspace + '/'))
    throw new Error('engine_service_workspace_state_overlap');
  if (startup.commandSandbox !== undefined) {
    if (startup.commandSandbox !== ISOLATED_COMMAND_SHELL) throw new Error('engine_service_sandbox_invalid');
    const [command, ...args] = shellCommandArgv(':', startup.commandSandbox, { workspaceRoot: workspace, cwd: workspace });
    const probe = spawnSync(command, args, { cwd: workspace, env: { PATH: '/bin:/usr/bin' }, timeout: 5000, stdio: 'ignore' });
    if (probe.status !== 0) throw new Error('engine_service_sandbox_unavailable');
  }
  const viewStore = createEngineViewStore(join(stateDir, 'engine-views'));
  const viewRef = viewStore.archive(engineView());
  const managedRuntime = managed && createEngineManagedService({ startup, stateDir, workspace,
    config: managed, env, fetchImpl, log, serviceToken: token, viewStore, viewRef });
  let closing = false;
  const handleRequest = async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      return respond(response, closing ? 503 : 200, {
        contract: ENGINE_SERVICE_CONTRACT, ready: !closing,
        capabilities: { scopedHostRequests: true, toolPolicy: ENGINE_TOOL_POLICY,
          hostContext: ENGINE_CONTEXT, hostHooks: ENGINE_HOOKS, hostToolEffects: ENGINE_HOST_EFFECT,
          executionPolicy: ENGINE_EXECUTION_POLICY, hostVerification: ENGINE_VERIFICATION,
          ...(managedRuntime ? { managedCommands: MANAGED_NATIVE_KERNEL_CONTRACT,
            managedToolApprovals: managedRuntime.platformApprovals } : {}) },
      });
    }
    const platformRoute = isAgentKernelPlatformPath(request.url);
    if (!timingSafeEqual(hash(request.headers.authorization ?? ''), auth)
      && !(platformRoute && managedRuntime?.authorizesPlatformTransport(request.headers.authorization)))
      return respond(response, 401, { error: 'unauthorized' });
    if (closing) return respond(response, 503, { error: 'service_stopping' });
    if (request.method === 'GET' && request.url === '/agent-kernel/v1/health' && managedRuntime?.platformHealth) {
      const health = managedRuntime.platformHealth();
      return respond(response, health.ready ? 200 : 503, health);
    }
    if (managedRuntime && (request.url?.startsWith(MANAGED_NATIVE_KERNEL_PATH + '/') || platformRoute))
      return managedRuntime.handle(request, response);
    const viewMatch = /^\/v1\/views\/([a-f0-9]{64})$/.exec(request.url ?? '');
    if (viewMatch && ['GET', 'HEAD'].includes(request.method)) {
      try {
        const view = viewStore.get(viewMatch[1]);
        if (!view) return respond(response, 404, { error: 'view_not_found' });
        response.writeHead(200, {
          'content-type': view.contentType, 'cache-control': 'private, max-age=31536000, immutable',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; sandbox allow-scripts",
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        });
        return response.end(request.method === 'HEAD' ? undefined : view.html);
      } catch {
        return respond(response, 500, { error: 'view_unavailable' });
      }
    }
    const [pathname, query] = (request.url ?? '').split('?', 2);
    const match = /^\/v1\/sessions\/([^/]+)\/(rpc|host-requests|host-reply)$/.exec(pathname);
    if (!match || !SESSION_PATTERN.test(match[1])) return respond(response, 404, { error: 'not_found' });
    const [, id, action] = match;
    try {
      if (request.method === 'GET' && action === 'host-requests') {
        const session = sessions.get(id);
        if (!session) return respond(response, 404, { error: 'session_not_found' });
        const search = new URLSearchParams(query);
        const runId = search.get('runId') ?? undefined;
        const waitMs = Math.min(Math.max(Number(search.get('waitMs')) || 0, 0), 5000);
        const requests = await session.takeHostRequests(runId, waitMs, response);
        return respond(response, 200, { requests });
      }
      if (query !== undefined) return respond(response, 400, { error: 'invalid_query' });
      if (request.method !== 'POST' || action === 'host-requests')
        return respond(response, 405, { error: 'method_not_allowed' });
      const frame = await readFrame(request);
      let session = sessions.get(id);
      if (action === 'host-reply') {
        if (Object.hasOwn(frame, 'method') || Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error'))
          return respond(response, 400, { error: 'invalid_host_reply' });
        if (!session?.reply(frame)) return respond(response, 404, { error: 'host_request_not_found' });
        return respond(response, 200, { accepted: true });
      }
      if (typeof frame.method !== 'string' || frame.method === 'shutdown')
        return respond(response, 400, { error: 'invalid_method' });
      if (!session) {
        if (frame.method !== 'initialize') return respond(response, 404, { error: 'session_not_found' });
        if (sessions.size >= maxSessions) return respond(response, 503, { error: 'session_capacity' });
        session = openSession(id, { ...startup, stateDir }, env, fetchImpl, log, viewStore);
        sessions.set(id, session);
      }
      const result = await session.request(frame);
      if (closing) return respond(response, 503, { error: 'service_stopping' });
      if (!result) return respond(response, 409, { error: 'request_unavailable' });
      return respond(response, 200, result);
    } catch {
      return respond(response, 400, { error: 'invalid_request' });
    }
  };
  const server = tls ? createTlsServer(tls, handleRequest) : createServer(handleRequest);
  return {
    server,
    async close() {
      closing = true;
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.allSettled([...sessions.values()].map(session => session.close()).concat(managedRuntime?.close() ?? []));
      server.closeAllConnections();
      await stopped;
    },
  };
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); }
  catch { return false; }
}

if (isMain()) {
  try {
    const startup = engineStartupFromArgs(process.argv.slice(2), process.env);
    if (process.env.AGENTKIT_ENGINE_COMMAND_SANDBOX !== undefined)
      startup.commandSandbox = process.env.AGENTKIT_ENGINE_COMMAND_SANDBOX;
    const certFile = process.env.AGENTKIT_ENGINE_SERVICE_CERT_FILE;
    const keyFile = process.env.AGENTKIT_ENGINE_SERVICE_KEY_FILE;
    if (Boolean(certFile) !== Boolean(keyFile)) throw new Error('engine_service_tls_pair_required');
    const tls = certFile ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : undefined;
    const managedFile = process.env.AGENTKIT_ENGINE_MANAGED_CONFIG_FILE;
    const managed = managedFile ? JSON.parse(readFileSync(managedFile, 'utf8')) : undefined;
    const service = createEngineService({ startup, tls, managed, token: process.env.AGENTKIT_ENGINE_SERVICE_TOKEN,
      log: message => process.stderr.write('agentkit-engine-service: ' + message + '\n') });
    const port = Number(process.env.AGENTKIT_ENGINE_SERVICE_PORT ?? '8787');
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid_service_port');
    service.server.on('error', error => {
      process.stderr.write('agentkit-engine-service: ' + (error.code ?? 'listen_failed') + '\n');
      process.exitCode = 1;
    });
    service.server.listen(port, process.env.AGENTKIT_ENGINE_SERVICE_HOST ?? '127.0.0.1');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      service.close().catch(() => { process.exitCode = 1; });
    });
  } catch (error) {
    process.stderr.write('agentkit-engine-service: ' + error.message + '\n');
    process.exitCode = 2;
  }
}
