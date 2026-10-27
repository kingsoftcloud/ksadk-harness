// Standalone Native Harness host example.
//
// Uses ONLY the public npm names @kingsoftcloud/agentkit-harness-core and
// @kingsoftcloud/agentkit-harness-node (never Studio/src paths). It drives the
// real NativeKernel sole loop over a SQLite ledger, exposes actual read/write
// workspace tools guarded by permissions, observes committed ledger events,
// and supports cancellation plus process-restart continuation.
//
// Models come from the environment. A clearly-labeled FAKE controlled model is
// used for deterministic scenarios; a real provider can be selected with the
// NATIVE_MODEL_* env vars. Credentials travel only in request headers and are
// never written to the evidence JSON or the ledger.
//
// This is an example, not a product: it favors clarity over completeness.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, open, writeFile, appendFile } from 'node:fs/promises';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { NativeKernel, configure, initialSnapshot, canonical, emptyUsage, terminal }
  from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore, createNativeModelPort, nativeModelRecoveryPolicy }
  from '@kingsoftcloud/agentkit-harness-node';

const { values: args } = parseArgs({
  options: {
    db: { type: 'string' },
    workspace: { type: 'string' },
    'run-id': { type: 'string', default: 'run-1' },
    scenario: { type: 'string', default: 'happy' },        // happy | cancel | deny | budget | restart | symlink
    resume: { type: 'boolean', default: false },           // resume an existing run from the ledger
    'cancel-after': { type: 'string', default: '' },       // ms after which to submit a cancel command
    'crash-after-write': { type: 'boolean', default: false },
    permissions: { type: 'string', default: 'workspace:read,workspace:write' },
    evidence: { type: 'string', default: '' },
  },
});

if (!args.db || !args.workspace) {
  console.error('Usage: host.mjs --db <sqlite-path> --workspace <dir> [--scenario NAME] [--resume] [--cancel-after MS] [--crash-after-write] [--permissions LIST] [--evidence PATH]');
  process.exit(2);
}

const scope = { tenantId: 'demo', workspaceId: 'demo', userId: 'demo', agentId: 'demo' };
const runId = args['run-id'];
const owner = 'standalone-host';
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const workspaceDir = resolve(args.workspace);
const workspaceReal = realpathSync(workspaceDir);
const dbPath = resolve(args.db);
const granted = new Set(args.permissions.split(',').map(s => s.trim()).filter(Boolean));
const execLogPath = join(workspaceDir, '.native-exec.log');
const useFakeModel = Boolean(process.env.FAKE_SCENARIO) || !process.env.NATIVE_MODEL_PROTOCOL;
const scenario = useFakeModel ? (process.env.FAKE_SCENARIO || args.scenario) : 'real';
// A resume recovers an in-flight effect; it must never crash again, even if the
// crash env var leaks into the resume process.
const crashAfterWrite = !args.resume && (args['crash-after-write'] || process.env.NATIVE_CRASH_AFTER_WRITE === '1');
const toolExecutions = [];

// ---- Workspace tools: actual read/write, guarded by permissions -------------
// Reject symlink components, including dangling links that realpath cannot
// resolve. This sample assumes the workspace tree is not concurrently replaced
// by another process; a hostile shared filesystem needs an isolated executor.
function confine(path) {
  if (!path || typeof path !== 'string') return null;
  const target = resolve(workspaceDir, path);
  if (!target.startsWith(workspaceDir + sep)) return null;
  let current = workspaceReal;
  for (const part of relative(workspaceDir, target).split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return null;
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
    }
  }
  return current;
}

async function executeTool(request) {
  request.signal.throwIfAborted();
  const def = request.definition, call = request.call;
  const entry = { callId: call.callId, name: call.name, status: 'error' };
  // Permission guard: every required permission must be granted by this run.
  for (const perm of def.permissions) {
    if (!granted.has(perm)) {
      entry.code = 'permission_denied'; entry.required = perm; entry.granted = [...granted];
      await logExecution(entry);
      return { status: 'error', content: { code: 'permission_denied', required: perm, granted: [...granted] } };
    }
  }
  const argPath = String((call.arguments && call.arguments.path) || '');
  const resolved = confine(argPath);
  if (!resolved) {
    entry.code = 'invalid_path'; entry.path = argPath;
    await logExecution(entry);
    return { status: 'error', content: { code: 'invalid_path', path: argPath } };
  }
  if (def.name === 'read') {
    try {
      const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content;
      try { content = await file.readFile('utf8'); } finally { await file.close(); }
      entry.status = 'ok'; entry.path = argPath; entry.bytes = Buffer.byteLength(content);
      await logExecution(entry);
      return { status: 'ok', content };
    } catch (error) {
      entry.code = 'read_failed'; entry.errorCode = String(error.code);
      await logExecution(entry);
      return { status: 'error', content: { code: 'read_failed', errorCode: String(error.code) } };
    }
  }
  if (def.name === 'write') {
    const content = String((call.arguments && call.arguments.content) ?? '');
    await mkdir(dirname(resolved), { recursive: true });
    request.signal.throwIfAborted();
    const file = await open(resolved, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); }
    entry.status = 'ok'; entry.path = argPath; entry.bytes = Buffer.byteLength(content);
    await logExecution(entry);
    // Crash after the durable side effect but before the kernel commits the
    // tool receipt. The SQLite ledger keeps the 'running' tool intent; a
    // restart recovers it as unknown without replaying the write.
    if (crashAfterWrite) process.exit(7);
    return { status: 'ok', content: { path: argPath, bytes: Buffer.byteLength(content) }, workspaceChangedPaths: [argPath] };
  }
  entry.code = 'unknown_tool'; entry.name = def.name;
  await logExecution(entry);
  return { status: 'error', content: { code: 'unknown_tool', name: def.name } };
}

async function logExecution(entry) {
  toolExecutions.push({ ...entry });
  await appendFile(execLogPath, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
}

// ---- Controlled (fake) model, clearly labeled for deterministic tests -------
// NEVER used for a real provider (real needs NATIVE_MODEL_* env). It scripts a
// fixed sequence of ModelResults per scenario so the verifier can assert the
// kernel's authority decisions, not a model's prose.
let fakeCall = 0;
function fakeGenerate(request) {
  fakeCall += 1;
  if (scenario === 'cancel') {
    // Hang until the caller aborts; the kernel seals the attempt as canceled.
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
    });
  }
  const read = { callId: 'read-1', name: 'read', arguments: { path: 'note.txt' } };
  const write = { callId: 'write-1', name: 'write', arguments: { path: 'out.txt', content: 'written by standalone native host' } };
  const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
  const tools = calls => ({ kind: 'tool_calls', text: '', toolCalls: calls, usage: emptyUsage() });
  // Confinement probes: lexical '..' traversal, a parent-directory alias
  // symlink, and a direct symlink to an outside file. confine must reject all
  // three before any read reaches the filesystem.
  const escape = [
    { callId: 'read-dotdot', name: 'read', arguments: { path: 'subdir/../../outside-secret.txt' } },
    { callId: 'read-parent', name: 'read', arguments: { path: 'parent/outside-secret.txt' } },
    { callId: 'read-symlink', name: 'read', arguments: { path: 'escape' } },
    { callId: 'write-dangling', name: 'write', arguments: { path: 'dangling', content: 'must not escape' } },
    { callId: 'write-parent', name: 'write', arguments: { path: 'parent/escaped.txt', content: 'must not escape' } },
  ];
  const script = {
    happy: [tools([read]), tools([write]), final('Completed read and write')],
    deny: [tools([write]), final('Could not write; finished without it')],
    budget: [tools([read])],         // model asks for a tool the budget cannot afford
    restart: [tools([write])],        // one write, then the host crashes before the receipt commits
    symlink: [tools(escape), final('Done; all escapes rejected')],
  }[scenario] ?? [final('done')];
  return Promise.resolve(script[fakeCall - 1] ?? final('done'));
}

// ---- Real provider binding from the environment (never logged) ------------
function resolveRealProfile() {
  const protocol = process.env.NATIVE_MODEL_PROTOCOL;
  const baseUrl = process.env.NATIVE_MODEL_BASE_URL;
  const apiKey = process.env.NATIVE_MODEL_API_KEY;
  const model = process.env.NATIVE_MODEL_NAME;
  if (!protocol || !baseUrl || !apiKey || !model) {
    throw new Error('NATIVE_MODEL_PROTOCOL/BASE_URL/API_KEY/NAME are required for a real provider');
  }
  // Credentials are placed only in headers by createNativeModelPort and are
  // never persisted in request, messages, result, events or this evidence.
  return { protocol, baseUrl, apiKey, model, parameters: {} };
}

// ---- Run configuration ------------------------------------------------------
function buildConfig() {
  const isReal = !useFakeModel;
  const protocol = isReal ? process.env.NATIVE_MODEL_PROTOCOL : 'openai-chat';
  // Short lease for the restart scenario so a crashed process's lease expires
  // before the resume process acquires (the verifier waits past leaseMs).
  const leaseMs = scenario === 'restart' ? 2000 : 8000;
  // Budget scenario: maxModelCalls=1 with a finalization reserve leaves no room
  // for the requested tool, exercising the kernel's budget gate directly.
  const maxModelCalls = scenario === 'budget' ? 1 : 8;
  // configure() requires requestTimeoutMs < effectTimeoutMs.
  const effectTimeoutMs = isReal ? 120000 : 15000;
  const requestTimeoutMs = isReal ? Number(process.env.NATIVE_MODEL_REQUEST_TIMEOUT_MS || 45000) : 10000;
  const profile = isReal
    ? {
        profileId: process.env.NATIVE_MODEL_PROFILE_ID || 'real',
        profileVersion: '1', providerFamily: protocol,
        compatibilityDigest: process.env.NATIVE_MODEL_COMPAT || 'real-provider/v1',
        maxOutputTokens: Number(process.env.NATIVE_MODEL_MAX_TOKENS || 1024),
        requestTimeoutMs, maxRetries: 0, maxProviderRetries: 0, streaming: false,
      }
    : {
        profileId: 'fake', profileVersion: '1', providerFamily: 'fake',
        compatibilityDigest: 'fake/v1', maxOutputTokens: 256, requestTimeoutMs,
        maxRetries: 0, maxProviderRetries: 0, streaming: false,
      };
  const read = {
    name: 'read', description: 'Read a file from the workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    readOnly: true, concurrentSafe: true, permissions: ['workspace:read'], timeoutMs: 5000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
  };
  const write = {
    name: 'write', description: 'Write a file to the workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    readOnly: false, concurrentSafe: false, permissions: ['workspace:write'], timeoutMs: 5000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
  };
  const config = configure({
    profile,
    contract: {
      objective: 'Use the read and write tools to inspect and update the workspace, then finish.',
      acceptance: [{
        id: 'complete', required: true, verifierRef: 'standalone', verifierVersion: '1',
        verificationMethod: 'deterministic', description: 'Run reached a final answer.',
      }],
    },
    tools: [read, write],
    limits: {
      maxModelCalls, maxToolCalls: 20, maxParallelTools: 2, effectTimeoutMs,
      leaseMs, finalizationReserveModelCalls: 1, maxWallMs: null,
      // Deterministic recovery: a lost claim seals as unknown and finalizes
      // without retrying, so the restart scenario never re-runs the write.
      maxRecoveryRetries: 0,
    },
    hostBindingDigest: 'standalone-host/v1',
    modelRecoveryPolicy: nativeModelRecoveryPolicy({ protocol, parameters: {} }),
  });
  const identity = { scope, runId, sessionId: 'session-1', turnId: 'turn-1', buildId: 'build-1', parentRunId: null, taskChainId: 'chain-1' };
  const snapshot = initialSnapshot(identity, config, digest(config));
  return { config, snapshot };
}

// ---- Kernel assembly --------------------------------------------------------
function buildKernel() {
  const model = useFakeModel
    ? { generate: fakeGenerate }
    : createNativeModelPort({ resolveProfile: resolveRealProfile });
  const store = new SqliteRunStore(dbPath);
  // No task verifier is installed. Completion remains unverified; the external
  // acceptance driver checks actual file contents and operation counts.
  return { store, kernel: new NativeKernel({ store, ports: { model, tools: { execute: executeTool } }, owner, digest,
    onCheckpoint: async () => {
      for (const event of store.events(scope, runId, eventCursor)) {
        observedEvents.push({ seq: event.seq, kind: event.kind, eventId: event.eventId });
        eventCursor = event.seq;
      }
    },
  }) };
}

// ---- Drive -------------------------------------------------------------------
let eventCursor = 0;
const observedEvents = [];
const { store, kernel } = buildKernel();
let result;
let loaded;
try {
  const { config, snapshot } = buildConfig();
  if (args.resume) {
    // Resume an existing run from the durable ledger. attach validates the
    // rebuilt configuration matches the stored configDigest, then runUntilIdle
    // loads the record and recovers an in-flight tool intent as unknown without
    // replaying it.
    kernel.attach(scope, runId, config);
  } else {
    kernel.start(snapshot, config);
  }
  if (args['cancel-after']) {
    const ms = Number(args['cancel-after']);
    setTimeout(() => kernel.submit(scope, runId, { commandId: 'cancel-1', kind: 'cancel', payload: {} }), ms);
  }
  result = await kernel.runUntilIdle(scope, runId);
  // Observe the committed ledger while the store is still open.
  loaded = store.load(scope, runId);
} finally {
  store.close?.();
}

// ---- Evidence (no secrets; credentials never enter events or this JSON) ------
const events = (loaded && loaded.events) || [];
const evidence = {
  format: 'agentkit.native-standalone/v1',
  host: {
    node: process.version, owner, scope, runId, scenario, resumed: args.resume,
    model: useFakeModel ? 'fake-controlled' : 'real-provider',
    permissions: [...granted], workspace: workspaceDir,
  },
  result: {
    phase: result.phase, outcome: result.outcome, reason: result.reason,
    finalText: String(result.finalText || ''),
    usage: result.usage, activeElapsedMs: result.activeElapsedMs,
    terminal: terminal(result.phase),
  },
  toolExecutions,
  subscription: { cursor: eventCursor, events: observedEvents },
  ledger: loaded ? {
    events: events.map(e => ({ seq: e.seq, kind: e.kind, eventId: e.eventId })),
    eventsCount: events.length,
    intents: (loaded.intents || []).length,
    receipts: (loaded.receipts || []).map(r => ({
      operationKey: r.operationKey, status: r.status,
      kind: loaded.intents.find(intent => intent.operationKey === r.operationKey)?.kind,
      code: r.result && typeof r.result === 'object' ? r.result.code : undefined,
    })),
    commits: (loaded.commits || []).length,
    phase: loaded.snapshot && loaded.snapshot.phase,
  } : null,
};

const evidencePath = args.evidence || join(workspaceDir, '.native-evidence.json');
await mkdir(dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, phase: evidence.result.phase, outcome: evidence.result.outcome,
  reason: evidence.result.reason, toolExecutions: evidence.toolExecutions.length,
  events: evidence.ledger?.eventsCount, evidence: evidencePath }));
