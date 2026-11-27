// Multi-turn integration tests: real NativeKernel + compiled core + local HTTP.
//
// These drive the full kernel loop (model -> tools -> verify) against a local
// HTTP server streaming controlled protocol bytes, not mocked fetch and not
// just adapter-internal shapes. They cover tool replay round-trip through the
// kernel, final submission via submit_final_output, and bad-argument
// non-execution (wireArgumentsInvalid). The core is imported read-only via the
// sibling package path (the same relative import the SQLite store uses); it is
// not modified and not committed.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configure, MemoryRunStore, NativeKernel, canonical, toolInputRejection,
} from '../../agentkit-harness-core/dist/index.mjs';
import { createNativeModelPort } from '../src/native/model-port.mjs';
import { createEngineRuntime } from '../src/native/engine-runtime.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (d) => `data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`;
const sseDone = () => 'data: [DONE]\n\n';
const ochunk = (delta = {}, finish = null) => ({ id: 'c1', choices: [{ index: 0, delta, finish_reason: finish }] });
const SSE_HEADERS = { 'content-type': 'text/event-stream' };

function startServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push(body);
    let spec;
    try { spec = await handler(req, body, requests.length - 1); }
    catch (e) { spec = { status: 500, body: String(e && e.message || e) }; }
    try { res.writeHead(spec.status || 200, spec.headers || {}); res.flushHeaders(); } catch { return; }
    const b = spec.body;
    if (b == null) { try { res.end(); } catch {} return; }
    if (typeof b === 'string' || Buffer.isBuffer(b)) { try { res.end(b); } catch {} return; }
    try { for await (const item of b) { if (res.writableEnded) break; res.write(item); } } catch {}
    try { if (!res.writableEnded) res.end(); } catch {}
  });
  server.keepAliveTimeout = 300;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

function makeConfig({ replayMode = 'reasoning_content' } = {}) {
  return configure({
    profile: {
      profileId: 'p1', profileVersion: '1', providerFamily: 'openai-compatible',
      compatibilityDigest: 'a'.repeat(64), providerReplayMode: replayMode,
      maxOutputTokens: 1024, contextWindow: 8000, requestTimeoutMs: 8000,
    },
    contract: {
      objective: 'Read the file and submit the answer',
      revision: '1',
      acceptance: [{ id: 'a1', required: true, verifierRef: 'v1', verifierVersion: '1', verificationMethod: 'deterministic', description: 'answer correct' }],
      finalSubmissionSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      finalSubmissionPayloadKey: 'answer',
      finalOutputFormat: 'text',
    },
    tools: [{
      name: 'read', description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      readOnly: true, concurrentSafe: false, permissions: [], timeoutMs: 5000,
      contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
    }],
    limits: { maxModelCalls: 10, finalizationReserveModelCalls: 1, maxToolCalls: 10, maxRepairs: 3 },
    hostBindingDigest: 'host-binding-1',
    instructions: 'Be concise.',
  });
}

function makeKernel({ store, modelPort, toolExecutor, verifier }) {
  return new NativeKernel({
    store,
    owner: 'test-worker',
    ports: {
      model: modelPort,
      tools: { execute: toolExecutor },
      verification: { verify: verifier },
    },
    digest: (v) => crypto.createHash('sha256').update(canonical(v)).digest('hex'),
  });
}

function identity() {
  return {
    scope: { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' },
    runId: 'run-1', sessionId: 'sess-1', turnId: 'turn-1', buildId: 'build-1',
    parentRunId: null, taskChainId: 'tc-1',
  };
}

function passingVerifier() {
  return async (req) => {
    const c = req.candidate;
    return {
      status: 'passed', reason: 'ok', candidateId: c.candidateId, contractRevision: '1',
      binding: c.binding, workspaceDependency: 'none', workspaceRevision: c.workspaceRevision,
      checks: [{ id: 'a1', status: 'passed', evidence: 'done', evidenceRefs: ['e1'], verifierId: 'v1', verifierVersion: '1', verificationMethod: 'deterministic' }],
    };
  };
}

test('integration: a workspace read past EOF with no end_line lets the model correct the range', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-read-range-'));
  const workspaceRoot = join(root, 'workspace');
  let server, runtime;
  t.after(async () => {
    await runtime?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, 'two.txt'), 'first\nsecond');
  const calls = [
    { id: 'past-eof', name: 'read_workspace_file', args: { path: 'two.txt', start_line: 5 } },
    { id: 'corrected', name: 'read_workspace_file', args: { path: 'two.txt', start_line: 1 } },
    { id: 'answer', name: 'submit_final_output', args: { answer: 'Read both lines.' } },
  ];
  server = await startServer((_req, _body, index) => {
    const { id, name, args } = calls[index];
    const toolCall = { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
    return { status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ tool_calls: [toolCall] }, 'tool_calls')), sseDone()] };
  });
  const { scope, runId, sessionId } = identity();
  runtime = await createEngineRuntime({ workspaceRoot, stateDir: join(root, 'state'), sessionId, scope,
    model: { name: 'fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: async () => 'fixture' },
    sourceEnv: {}, authorize: async () => 'deny' });
  runtime.start({ runId, objective: 'Read the two-line file and report what it contains.', preset: 'official', maxModelCalls: 4 });
  const result = await runtime.run(runId);
  assert.equal(result.phase, 'completed');
  assert.equal(server.requests.length, 3);
  const toolResult = (request, id) => JSON.parse(request).messages.find(message => message.role === 'tool' && message.tool_call_id === id)?.content;
  const error = JSON.parse(toolResult(server.requests[1], 'past-eof'));
  assert.equal(error.ok, false);
  assert.match(error.error_message, /start_line must be <= end_line/);
  assert.deepEqual(error.requested_range, { start: 5, end: null });
  assert.equal(error.total_lines, 2);
  const corrected = JSON.parse(toolResult(server.requests[2], 'corrected'));
  assert.equal(corrected.ok, true);
  assert.match(corrected.content, /1 \| first\n2 \| second/);
});

test('integration: tool replay round-trips through the kernel and the run completes verified', async () => {
  const server = await startServer((req, body, idx) => {
    if (idx === 0) {
      // Turn 1: private reasoning (replay) + a read tool call.
      return { status: 200, headers: SSE_HEADERS, body: [
        sse(ochunk({ reasoning_content: 'PRIVATE_THINKING' })),
        sse(ochunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }] }, 'tool_calls')),
        sseDone(),
      ] };
    }
    // Turn 2: the prior assistant message must carry the re-projected private
    // replay (reasoning_content) on the wire — proving the adapter re-projected
    // the sealed replay bound to this profile through the kernel.
    assert.ok(body.includes('reasoning_content'), 'turn 2 request must carry re-projected private replay');
    assert.ok(body.includes('PRIVATE_THINKING'));
    return { status: 200, headers: SSE_HEADERS, body: [
      sse(ochunk({ tool_calls: [{ index: 0, id: 'call-2', type: 'function', function: { name: 'submit_final_output', arguments: '{"answer":"42"}' } }] }, 'tool_calls')),
      sseDone(),
    ] };
  });
  try {
    const modelPort = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch, maxResponseBytes: 1024 * 1024, idleTimeoutMs: 8000,
    });
    let readCalls = 0;
    const kernel = makeKernel({
      store: new MemoryRunStore(),
      modelPort,
      toolExecutor: async (req) => {
        const rejection = toolInputRejection(req.definition, req.call);
        if (rejection) return { status: 'error', content: rejection };
        readCalls++;
        return { status: 'ok', content: 'file contents: 42' };
      },
      verifier: passingVerifier(),
    });
    const id = identity();
    kernel.start(id, makeConfig());
    const snapshot = await kernel.runUntilIdle(id.scope, id.runId, { waitForRetry: false });
    assert.equal(snapshot.phase, 'completed');
    assert.equal(snapshot.outcome, 'verified');
    assert.equal(readCalls, 1, 'read executed exactly once');
    assert.equal(snapshot.finalText, '42');
  } finally {
    await server.close();
  }
});

test('integration: bad-argument tool call is not executed and the run still completes', async () => {
  const server = await startServer((req, body, idx) => {
    if (idx === 0) {
      // Turn 1: read tool call with INVALID argument JSON -> wireArgumentsInvalid.
      return { status: 200, headers: SSE_HEADERS, body: [
        sse(ochunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }, 'tool_calls')),
        sseDone(),
      ] };
    }
    // Turn 2: submit the final answer (after the non-executed tool error).
    return { status: 200, headers: SSE_HEADERS, body: [
      sse(ochunk({ tool_calls: [{ index: 0, id: 'call-2', type: 'function', function: { name: 'submit_final_output', arguments: '{"answer":"ok"}' } }] }, 'tool_calls')),
      sseDone(),
    ] };
  });
  try {
    const modelPort = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch, maxResponseBytes: 1024 * 1024, idleTimeoutMs: 8000,
    });
    let readExecutions = 0;
    const kernel = makeKernel({
      store: new MemoryRunStore(),
      modelPort,
      toolExecutor: async (req) => {
        // The core's toolInputRejection rejects wireArgumentsInvalid without
        // executing the tool callback — the adapter must have preserved the flag.
        const rejection = toolInputRejection(req.definition, req.call);
        if (rejection) return { status: 'error', content: rejection };
        readExecutions++;
        return { status: 'ok', content: 'x' };
      },
      verifier: passingVerifier(),
    });
    const id = identity();
    kernel.start(id, makeConfig());
    const snapshot = await kernel.runUntilIdle(id.scope, id.runId, { waitForRetry: false });
    assert.equal(snapshot.phase, 'completed');
    assert.equal(readExecutions, 0, 'the invalid-argument read was never executed');
    assert.equal(snapshot.finalText, 'ok');
    // A tool error receipt for the invalid arguments is recorded in the ledger.
    assert.ok(snapshot.messages.some((m) => m.role === 'tool' && m.content.includes('wire_arguments_invalid')),
      'ledger must record the non-execution tool error');
  } finally {
    await server.close();
  }
});

test('integration: finalization-only turn keeps submit_final_output on the wire', async () => {
  // Force a finalization-only turn by exhausting the model budget to the
  // reserve: maxModelCalls=2, finalizationReserveModelCalls=2 -> the very first
  // model call is finalization-only, so only submit_final_output is advertised.
  const server = await startServer((req, body, idx) => {
    if (idx === 0) {
      assert.ok(body.includes('submit_final_output'), 'finalization-only turn must advertise submit_final_output');
      assert.ok(!body.includes('"name":"read"'), 'finalization-only turn must not advertise normal tools');
      return { status: 200, headers: SSE_HEADERS, body: [
        sse(ochunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'submit_final_output', arguments: '{"answer":"final"}' } }] }, 'tool_calls')),
        sseDone(),
      ] };
    }
    return { status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'final' }, 'stop')), sseDone()] };
  });
  try {
    const modelPort = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch, maxResponseBytes: 1024 * 1024, idleTimeoutMs: 8000,
    });
    const kernel = makeKernel({
      store: new MemoryRunStore(),
      modelPort,
      toolExecutor: async () => ({ status: 'ok', content: 'x' }),
      verifier: passingVerifier(),
    });
    const config = configure({
      profile: { profileId: 'p1', profileVersion: '1', providerFamily: 'openai-compatible',
        compatibilityDigest: 'a'.repeat(64), providerReplayMode: 'none', maxOutputTokens: 1024, contextWindow: 8000, requestTimeoutMs: 8000 },
      contract: { objective: 'Submit', revision: '1',
        acceptance: [{ id: 'a1', required: true, verifierRef: 'v1', verifierVersion: '1', verificationMethod: 'deterministic', description: 'ok' }],
        finalSubmissionSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
        finalSubmissionPayloadKey: 'answer', finalOutputFormat: 'text' },
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        readOnly: true, concurrentSafe: false, permissions: [], timeoutMs: 5000,
        contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' }],
      limits: { maxModelCalls: 2, finalizationReserveModelCalls: 2, maxToolCalls: 10, maxRepairs: 3 },
      hostBindingDigest: 'host-binding-1', instructions: '',
    });
    const id = identity();
    kernel.start(id, config);
    const snapshot = await kernel.runUntilIdle(id.scope, id.runId, { waitForRetry: false });
    assert.equal(snapshot.phase, 'completed');
    assert.equal(snapshot.finalText, 'final');
  } finally {
    await server.close();
  }
});
