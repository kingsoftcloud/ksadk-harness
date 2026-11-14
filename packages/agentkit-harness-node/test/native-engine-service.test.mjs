import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createEngineService, parseEngineSessionFrame } from '../src/native/engine-service.mjs';
import { projectEngineEvent } from '../src/native/engine-server.mjs';
import { createEngineViewStore } from '../src/native/engine-view-store.mjs';
import { ENGINE_CONTEXT } from '../src/native/engine-context.mjs';
import { ENGINE_HOST_EFFECT, waitForHostReceipt } from '../src/native/engine-host-effects.mjs';
import { engineProviderCompatibilityRule, ENGINE_EXECUTION_POLICY } from '../src/native/engine-runtime.mjs';
import { admitProviderCompatibilityPolicy, applyProviderChatCompatibility } from '../src/native/model-provider-compat.mjs';
import { ENGINE_VERIFICATION } from '../src/native/engine-verification.mjs';
import { deliveryNetChanges, engineDeliveryEvidence } from '../src/native/engine-delivery-evidence.mjs';

test('the session frame boundary accepts RPC replies and host callbacks', () => {
  const result = { jsonrpc: '2.0', id: 'reply', result: null };
  const callback = { jsonrpc: '2.0', id: 'host', method: 'host/readToolReceipt', expiresAt: Date.now() + 1000 };
  assert.deepEqual(parseEngineSessionFrame(JSON.stringify(result)), result);
  assert.deepEqual(parseEngineSessionFrame(JSON.stringify(callback)), callback);
  for (const line of ['', '{', 'null', '{"jsonrpc":"2.0","id":"reply"}'])
    assert.equal(parseEngineSessionFrame(line), null);
});

test('unavailable host receipts yield a bounded idle wait without fabricating a result', async () => {
  const call = { name: 'call_remote', callId: 'call-1', arguments: {} };
  const operationKey = 'operation-1';
  const record = {
    snapshot: { runId: 'run-1', phase: 'awaiting_reconciliation', pendingTools: [call],
      toolReconciliation: { operationKey, callId: call.callId } },
    configuration: { tools: [{ name: call.name, hostEffectProtocol: ENGINE_HOST_EFFECT,
      recoveryPolicy: 'receipt-observation/v1' }] },
    intents: [{ operationKey, kind: 'tool', status: 'running', claimedFence: 1, payload: { calls: [call] } }],
    receipts: [{ operationKey, status: 'uncertain' }],
    commands: [],
  };
  const signal = new AbortController().signal;
  let calls = 0;
  const answer = await waitForHostReceipt(record, { signal, waitMs: 25, assertCurrent() {},
    async read() { calls++; throw new Error('host unavailable'); } });
  assert.equal(answer, null);
  assert.equal(calls, 1);
  assert.equal(record.snapshot.phase, 'awaiting_reconciliation');
  const recovered = await waitForHostReceipt(record, { signal, waitMs: 1000, assertCurrent() {},
    async read() { return { token: 'a'.repeat(64), settled: true }; } });
  assert.equal(recovered.kind, 'reconcile_tool');
  assert.deepEqual(recovered.payload, { originalOperationKey: operationKey });
});

test('session capacity reclaims an idle session and reopens its durable Run', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-session-capacity-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const token = 'session-capacity-fixture-token';
  const reached = Promise.withResolvers(), finish = Promise.withResolvers();
  const service = createEngineService({ token, maxSessions: 1,
    startup: { workspace, stateDir: join(root, 'state'), scope: { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' },
      approval: 'deny', model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_KEY' } },
    env: { FIXTURE_KEY: 'fixture-value' },
    async fetchImpl() {
      reached.resolve();
      await finish.promise;
      const frame = { id: 'fixture', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 } };
      return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(async () => { finish.resolve(); await service.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + service.server.address().port;
  let id = 0;
  const rpc = (session, method, params) => fetch(origin + '/v1/sessions/' + session + '/rpc', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: String(++id), method, params }),
  });
  const initialize = session => rpc(session, 'initialize', { protocolVersions: ['agentkit.engine/v1'] });
  assert.equal((await initialize('first')).status, 200);
  const run = { runId: 'durable-run' };
  assert.equal((await rpc('first', 'run/start', { ...run, objective: 'Complete the fixture.' })).status, 200);
  await reached.promise;
  assert.equal((await initialize('second')).status, 503);
  finish.resolve();
  for (let i = 0; i < 30; i++) {
    if (!(await (await rpc('first', 'run/status', run)).json()).result.running) break;
    await sleep(25);
  }
  assert.equal((await initialize('second')).status, 200);
  assert.equal((await rpc('first', 'run/status', run)).status, 404);
  assert.equal((await initialize('first')).status, 200);
  const { result } = await (await rpc('first', 'run/status', run)).json();
  assert.equal(result.phase, 'completed');
  assert.equal(result.finalText, 'Done.');
});

test('oversized workspace observations retain actual read ranges and bounded search locations', () => {
  const project = (name, content) => projectEngineEvent({ kind: 'tool.completed', seq: 1,
    payload: { name, callId: 'fixture', status: 'ok', content } }).result;
  const read = project('read_workspace_file', { ok: true, content: 'x'.repeat(10000),
    read_range: { start: 7, end: 24 }, line_count: 18 });
  assert.equal(read.truncated, true);
  assert.deepEqual([read.start_line, read.end_line, read.line_count], [7, 24, 18]);

  const search = project('search_workspace_files', { ok: true, searched_path: 'src', match_count: 50,
    results: Array.from({ length: 50 }, (_, index) => ({ path: 'src/a.ts', line: index + 1, text: 'x'.repeat(1000) })) });
  assert.equal(search.truncated, true);
  assert.equal(search.searched_path, 'src');
  assert.equal(search.match_count, 50);
  assert.equal(search.results.length, 12);
  assert.deepEqual(search.results[0], { path: 'src/a.ts', line: 1 });
});

test('delivery evidence uses committed effects from the current Run, not inherited paths', () => {
  const tools = ['write_workspace_file', 'run_command', 'browser_inspect_workspace'];
  const receipt = (operationKey, content) => ({ operationKey, status: 'committed', result: { results: [{ status: 'ok', ...content }] } });
  const record = {
    snapshot: { goalRevision: 1, workspaceModifiedPaths: ['previous.txt'],
      deliveryManifest: { goalRevision: 1, artifacts: [{ kind: 'file', path: 'declared.png' }] } },
    intents: tools.map((name, index) => ({ operationKey: String(index), kind: 'tool', payload: { calls: [{ name }] } })),
    receipts: [
      receipt('0', { workspaceChangedPaths: ['app.js'], content: { path: 'app.js', diff_additions: 10, diff_deletions: 0 } }),
      receipt('1', { workspaceChangedPaths: ['app.js', 'index.html', '../outside', '__pycache__/module.cpython-312.pyc',
        'nested/__pycache__/source.py', 'nested/__pycache__'] }),
      receipt('2', { content: { screenshot_path: '.artifacts/preview.png' } }),
    ],
  };
  assert.deepEqual(engineDeliveryEvidence(record), { files: [{ path: 'app.js' }, { path: 'index.html' },
    { path: 'nested/__pycache__/source.py' }, { path: 'nested/__pycache__' }],
    screenshots: ['declared.png', '.artifacts/preview.png'], truncated: false });
});

test('the engine binds GLM proxy compatibility without guessing Z.ai from the model name', () => {
  const model = 'glm-5.3-flash';
  for (const [baseUrl, compatibilityRule, expected, thinking, effort] of [
    ['https://proxy.example/kspmas/v1', undefined, 'permissive', undefined, undefined],
    ['https://proxy.example/v1', 'kspmas-gateway', 'kspmas-gateway', undefined, 'low'],
    ['https://kspmas.ksyun.com/v1', undefined, 'kspmas-gateway', undefined, 'low'],
    ['https://open.bigmodel.cn/api/paas/v4', undefined, 'zai', { type: 'disabled' }, undefined],
  ]) {
    const rule = engineProviderCompatibilityRule({ protocol: 'openai-chat', modelName: model, baseUrl, compatibilityRule });
    assert.equal(rule, expected);
    const payload = applyProviderChatCompatibility({ model, stream: true, max_tokens: 8192, messages: [],
      tools: [{ type: 'function', function: { name: 'read_workspace_file' } }] },
    { beforeFirstTool: true, profile: { providerCompatibilityPolicy: admitProviderCompatibilityPolicy(rule) } }, { model, baseUrl });
    assert.deepEqual(payload.thinking, thinking);
    assert.equal(payload.reasoning_effort, effort);
  }
});

test('delivery line counts compare the opening and final content and omit reverted paths', () => {
  const file = text => ({ text, digest: createHash('sha256').update(text).digest('hex') });
  const net = deliveryNetChanges({
    'a.txt': file('unchanged\nold\n'), 'reverted.txt': file('same\n'),
    'deleted.txt': file('gone\n'), 'binary.png': { digest: 'old' },
  }, {
    'a.txt': file('unchanged\nnew\n'), 'reverted.txt': file('same\n'),
    'binary.png': { digest: 'new' }, 'created.txt': file('one\ntwo'),
  });
  assert.deepEqual(net('a.txt'), { path: 'a.txt', added: 1, removed: 1 });
  assert.equal(net('reverted.txt'), null);
  assert.deepEqual(net('deleted.txt'), { path: 'deleted.txt', added: 0, removed: 1, deleted: true });
  assert.deepEqual(net('binary.png'), { path: 'binary.png' });
  assert.deepEqual(net('created.txt'), { path: 'created.txt', added: 2, removed: 0 });
});

test('a live cursor delivers reasoning and tool drafts, and accepts guidance for the next model step', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-engine-thinking-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const reasoning = 'first\n' + 'a'.repeat(10000) + '\nlast';
  const encoder = new TextEncoder();
  let stream, modelCalls = 0;
  const modelRequests = [];
  const frame = (delta, finish_reason = null) => encoder.encode(`data: ${JSON.stringify({
    id: 'thinking-fixture', choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  const token = 'fixture-thinking-service-token';
  const service = createEngineService({ token, startup: { workspace, stateDir: join(root, 'ledger'), approval: 'deny',
    scope: { tenantId: 'fixture', workspaceId: 'workspace', userId: 'user', agentId: 'agent' },
    model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_KEY' } },
    env: { FIXTURE_KEY: 'fixture-key' }, fetchImpl: async (_url, req) => {
      modelRequests.push(JSON.parse(req.body));
      return new Response(new ReadableStream({
      start(controller) {
        if (modelCalls++ === 0) {
          stream = controller;
          controller.enqueue(frame({ reasoning_content: reasoning }));
        } else {
          controller.enqueue(frame({ content: 'Finished.' }, 'stop'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
      }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + service.server.address().port + '/v1/sessions/thinking/rpc';
  let id = 0;
  async function rpc(method, params) {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: String(++id), method, params }) });
    const reply = await response.json();
    assert.ok(reply.result, JSON.stringify(reply.error));
    return reply.result;
  }
  await rpc('initialize', { protocolVersions: ['agentkit.engine/v1'] });
  const runId = 'thinking-run';
  await rpc('run/start', { runId, objective: 'Answer the fixture.' });
  let cursor = 0, thinkingCursor = '', toolDraftCursor = '', received = '', requestId;
  async function poll() {
    const page = await rpc('run/events', { runId, cursor, thinkingCursor, toolDraftCursor, waitMs: 500 });
    cursor = page.cursor;
    if (page.thinking) { thinkingCursor = page.thinking.cursor; received += page.thinking.text; }
    if (page.toolDraft) toolDraftCursor = page.toolDraft.cursor;
    requestId ??= page.events.find(event => event.kind === 'effect.prepared' && event.category === 'model')?.requestId;
    return page;
  }
  for (let n = 0; n < 10 && received.length < reasoning.length; n++) await poll();
  assert.equal(received, reasoning);
  const before = cursor;
  assert.equal((await poll()).thinking, undefined, 'an acknowledged live chunk is not repeated');
  assert.equal(cursor, before);
  stream.enqueue(frame({ tool_calls: [{ index: 0, id: 'call-fixture', type: 'function',
    function: { name: 'read_workspace_file', arguments: '{"path":"fixture.txt' } }] }));
  const { toolDraft } = await poll();
  assert.equal(cursor, before);
  assert.deepEqual(toolDraft, { cursor: toolDraftCursor, requestId, tools: [{ index: 0, name: 'read_workspace_file' }] });
  const guide = { runId, inputId: 'guide-' + 'a'.repeat(64), text: 'Confirm the file check before finishing.' };
  assert.equal((await rpc('run/guide', guide)).status, 'accepted');
  assert.equal((await rpc('run/guide', guide)).status, 'duplicate');
  assert.equal(modelRequests.length, 1, 'guidance does not interrupt the in-flight tool draft');
  stream.enqueue(frame({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }));
  stream.enqueue(frame({}, 'tool_calls'));
  stream.enqueue(encoder.encode('data: [DONE]\n\n'));
  stream.close();
  const events = [];
  for (let n = 0; n < 10 && !events.some(event => event.kind === 'run.terminal'); n++)
    events.push(...(await poll()).events);
  const completed = events.find(event => event.kind === 'model.completed');
  assert.match(requestId, /^[a-f0-9]{64}$/);
  assert.equal(completed?.requestId, requestId);
  assert.equal(completed?.thinking, reasoning);
  assert.deepEqual(events.filter(event => event.kind === 'input.guidance_applied').map(event => event.inputId), [guide.inputId]);
  assert.equal(modelRequests.length, 2);
  assert.ok(modelRequests[1].messages.some(message => message.content === guide.text));
});

test('required verification repairs an unsupported answer, survives restart and rejects an unbound reply', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-host-verification-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const token = 'fixture-required-verification-token', observed = [];
  const options = {
    token, startup: { workspace, stateDir: join(root, 'ledger'), approval: 'deny',
      scope: { tenantId: 'fixture', workspaceId: 'workspace', userId: 'user', agentId: 'agent' },
      model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_KEY' },
    },
    env: { FIXTURE_KEY: 'fixture-model-key' },
    fetchImpl: async (_url, req) => {
      observed.push(JSON.parse(req.body).messages);
      const frame = { id: 'fixture', choices: [{ index: 0, delta: { content: 'Claimed completion.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 } };
      return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  let service, base;
  async function startService() {
    service = createEngineService(options);
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + service.server.address().port + '/v1/sessions/verification/';
  }
  t.after(async () => { await service?.close(); await rm(root, { recursive: true, force: true }); });
  await startService();
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  let next = 0;
  const post = async (endpoint, frame) => (await fetch(base + endpoint, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'fixture-' + ++next, ...frame }) })).json();
  const rpc = (method, params) => post('rpc', { method, params });
  const runId = 'verification-run', objective = 'Verify a fixture.';
  const hostVerification = { contract: ENGINE_VERIFICATION, verifierRef: 'fixture.owner',
    verifierVersion: '1', bindingDigest: 'sha256:' + 'a'.repeat(64), contextSourceId: null, evidenceTools: [] };
  const protocolVersions = ['agentkit.engine/v1'];
  await rpc('initialize', { protocolVersions });
  assert((await rpc('run/start', { runId, objective, hostVerification })).error);
  const initialize = () => rpc('initialize', { protocolVersions, services: { verification: ENGINE_VERIFICATION } });
  const { result: hello } = await initialize();
  assert.equal(hello.capabilities.hostVerification, ENGINE_VERIFICATION);
  assert.equal((await rpc('run/start', { runId, objective, hostVerification })).result.running, false);
  await rpc('run/events', { runId, cursor: 0, follow: true });

  async function claim() {
    const { requests } = await (await fetch(base + 'host-requests?waitMs=3000&runId=' + runId, { headers })).json();
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.method, 'host/verifyGoal');
    assert.deepEqual(request.params.evidence, { calls: [], context: [] });
    return request;
  }
  async function reply(request, status, mismatch = false) {
    const { operationKey, inputDigest } = request.params;
    assert.deepEqual(await post('host-reply', { id: request.id, result: {
      contract: ENGINE_VERIFICATION, operationKey, inputDigest: mismatch ? 'other' : inputDigest,
      status, reason: 'fixture_result', safeSummary: 'The owner did not observe the requested effect.',
      evidenceRefs: ['fixture:observation'],
    } }), { accepted: true });
  }
  await reply(await claim(), 'failed');
  const interrupted = await claim();
  await service.close();
  await startService();
  await initialize();
  await rpc('run/events', { runId, cursor: 0, follow: true });
  const resumed = await claim();
  assert.equal(resumed.params.candidateId, interrupted.params.candidateId);
  assert.notEqual(resumed.params.operationKey, interrupted.params.operationKey);
  await reply(resumed, 'passed', true);
  let result;
  for (let i = 0; i < 80; i++) {
    ({ result } = await rpc('run/status', { runId }));
    if (result.terminal) break;
    await sleep(25);
  }
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.finalText, null);
  assert.equal(observed.length, 2);
  assert(JSON.stringify(observed[1]).includes('owner did not observe'));
  const { result: events } = await rpc('run/events', { runId, cursor: 0 });
  const terminal = events.events.at(-1);
  assert.equal(terminal.requiredVerification, true);
  assert.equal(terminal.detail, undefined);
  assert(!JSON.stringify(events).includes('Claimed completion.'));
});

test('a committed initial plan survives a service restart and remains distinct from the final answer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-plan-execute-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const token = 'fixture-execution-plan-token', taskStarted = Promise.withResolvers();
  const startup = { workspace, stateDir: join(root, 'ledger'), approval: 'deny',
    scope: { tenantId: 'fixture', workspaceId: 'workspace', userId: 'user', agentId: 'agent' },
    model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_KEY' } };
  let service, base, next = 0, calls = 0;
  t.after(async () => { await service?.close(); await rm(root, { recursive: true, force: true }); });
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const rpc = async (method, params) => (await fetch(base + 'rpc', { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'fixture-' + ++next, method, params }) })).json();
  async function start() {
    service = createEngineService({ token, startup, env: { FIXTURE_KEY: 'fixture-model-key' },
      fetchImpl: async (_url, request) => {
        const call = ++calls, body = JSON.parse(request.body);
        const text = JSON.stringify(body.messages);
        if (call <= 2) {
          assert(!body.tools?.length);
          assert(text.includes('Tools are unavailable in this step'));
        } else {
          assert(body.tools?.some(tool => tool.function.name === 'read_workspace_file'));
          assert(text.includes('First check the fixture.'));
          assert(!text.includes('Tools are unavailable in this step'));
        }
        if (call === 3) {
          taskStarted.resolve();
          return new Promise((_resolve, reject) => {
            const abort = () => reject(request.signal.reason);
            if (request.signal.aborted) abort();
            else request.signal.addEventListener('abort', abort, { once: true });
          });
        }
        const delta = call === 1 ? { tool_calls: [{ index: 0, id: 'forged-tool', type: 'function',
          function: { name: 'read_workspace_file', arguments: '{"path":"should-not-be-read.txt"}' } }] }
          : { content: call === 2 ? 'First check the fixture.' : 'Verified result.' };
        const frame = { id: 'fixture', choices: [{ index: 0, delta, finish_reason: call === 1 ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 } };
        return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + service.server.address().port + '/v1/sessions/plan/';
    const { result } = await rpc('initialize', { protocolVersions: ['agentkit.engine/v1'] });
    assert.equal(result.capabilities.executionPolicy, ENGINE_EXECUTION_POLICY);
  }
  await start();
  const runId = 'planned-run', objective = 'Inspect a fixture.';
  const policy = { contract: ENGINE_EXECUTION_POLICY, strategy: 'plan-act-observe',
    maxWallMs: 20000, maxModelCalls: 5, maxToolCalls: 1 };
  assert((await rpc('run/start', { runId, objective, executionPolicy: { ...policy, maxToolCalls: -1 } })).error);
  assert((await rpc('run/start', { runId, objective, executionPolicy: policy })).result);
  await Promise.race([taskStarted.promise, sleep(4000, 'timeout', { ref: false })]).then(value =>
    assert.notEqual(value, 'timeout'));
  const before = (await rpc('run/events', { runId, cursor: 0 })).result;
  assert.equal(before.events.filter(event => event.title === 'initial_plan').length, 1);
  assert.equal(before.events.some(event => event.kind === 'run.terminal'), false);
  assert.equal(before.events.some(event => event.kind === 'tool.completed' || event.calls?.length), false);
  await service.close();
  await start();
  assert((await rpc('run/events', { runId, cursor: before.cursor, follow: true })).result);
  let result;
  for (let i = 0; i < 160; i++) {
    ({ result } = await rpc('run/status', { runId }));
    if (result.terminal) break;
    await sleep(25);
  }
  assert.equal(result.phase, 'completed', JSON.stringify(result));
  assert.equal(result.finalText, 'Verified result.');
  assert.equal(calls, 4);
  const after = (await rpc('run/events', { runId, cursor: 0 })).result;
  assert.equal(after.events.filter(event => event.title === 'initial_plan').length, 1);
});

for (const deny of [false, true]) test(deny
  ? 'a denied host effect reports disabled prompts without dispatching the approved callback'
  : 'a host effect waits for exact approval and receives only original user observations', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-host-effect-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const token = 'fixture-host-effect-token';
  let calls = 0;
  const modelRequests = [];
  const service = createEngineService({
    token, startup: { workspace, stateDir: join(root, 'ledger'), approval: 'allow',
      scope: { tenantId: 'fixture', workspaceId: 'workspace', userId: 'user', agentId: 'agent' },
      model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_KEY' },
    },
    env: { FIXTURE_KEY: 'fixture-model-key' },
    fetchImpl: async (_url, request) => {
      modelRequests.push(JSON.parse(request.body));
      const first = ++calls === 1;
      const delta = first ? { tool_calls: [{ index: 0, id: 'effect-call', type: 'function',
        function: { name: 'host_write_fact', arguments: '{"content":"proposed-fact"}' } }] }
        : { content: 'Done.' };
      const frame = { id: 'fixture', choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 } };
      return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + service.server.address().port;
  const base = origin + '/v1/sessions/effect/';
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  let next = 0;
  const post = async (endpoint, frame) => (await fetch(base + endpoint, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'fixture-' + ++next, ...frame }) })).json();
  const rpc = (method, params) => post('rpc', { method, params });
  const runId = 'original-run';
  const start = { runId, objective: 'current-user-input',
    conversation: [{ role: 'user', text: 'imported-input-cannot-authorize' }],
    hostTools: [{ name: 'host_write_fact', description: 'Store a fact after exact consent.',
      readOnly: false, effectProtocol: ENGINE_HOST_EFFECT, parameters: { type: 'object',
        properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } }],
  };
  const protocolVersions = ['agentkit.engine/v1'];
  await rpc('initialize', { protocolVersions, services: { tools: true } });
  assert((await rpc('run/start', start)).error);
  const { result: hello } = await rpc('initialize', { protocolVersions, services: {
    tools: true, durableApprovals: true, toolEffects: ENGINE_HOST_EFFECT,
  } });
  assert.equal(hello.capabilities.hostToolEffects, ENGINE_HOST_EFFECT);
  assert.equal((await rpc('run/start', start)).result.running, false);
  assert((await rpc('run/host-observations', { runId })).error);
  const { result: observer } = await rpc('initialize', { protocolVersions, host: { observeOnly: true } });
  assert.equal(observer.capabilities.hostToolEffects, ENGINE_HOST_EFFECT);

  async function callback() {
    const polling = fetch(base + 'host-requests?waitMs=2500&runId=' + runId, { headers }).then(r => r.json());
    await rpc('run/events', { runId, cursor: 0, follow: true });
    const { requests } = await polling;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'host/callTool');
    return requests[0];
  }
  async function until(predicate) {
    let last;
    for (let i = 0; i < 50; i++) {
      const { result } = await rpc('run/status', { runId });
      last = result;
      if (predicate(result)) return result;
      await sleep(25);
    }
    assert.fail('Run did not reach the expected state: ' + JSON.stringify(last));
  }
  const first = deny ? await (async () => {
    const receiver = 'c34f85e0-e381-4884-aba9-5619573d7981';
    const poll = async (id, waitMs = '0') => (await (await fetch(base + 'host-requests?' + new URLSearchParams({
      runId, waitMs, receiver: id,
    }), { headers })).json()).requests;
    const firstDelivery = poll(receiver, '2500');
    await rpc('run/events', { runId, cursor: 0, follow: true });
    const [lost] = await firstDelivery;
    assert.equal(lost.method, 'host/callTool');
    await sleep(550);
    assert.deepEqual(await poll('57b94515-d068-49b0-9f1a-c1b9d2ebd6a2'), []);
    assert.deepEqual(await poll(receiver), [lost]);
    return lost;
  })() : await callback();
  const observations = first.params.effect.observations;
  assert.deepEqual(observations.map(item => [item.sourceRunId, item.content]), [[runId, 'current-user-input']]);
  assert.equal(first.params.effect.approved, false);
  assert.equal(first.params.effect.canRequestApproval, true);
  assert.deepEqual(await post('host-reply', { id: first.id, result: { status: 'approval_required' } }), { accepted: true });
  const { pendingApproval } = await until(state => state.pendingApproval);
  assert.equal(pendingApproval.requiresUserApproval, true);
  if (deny) {
    const exact = { runId, interactionId: pendingApproval.interactionId };
    for (const invalid of [{ decision: 'allow', denialReason: 'approval_prompts_disabled' },
      { decision: 'deny', denialReason: 'unrecognized' }]) {
      assert.equal((await rpc('run/approve', { ...exact, ...invalid })).error?.code, -32602);
    }
    const reply = { ...exact, decision: 'deny', denialReason: 'approval_prompts_disabled' };
    assert.equal((await rpc('run/approve', reply)).result.status, 'accepted');
    await rpc('run/events', { runId, cursor: 0, follow: true });
    assert.equal((await until(state => state.terminal)).phase, 'completed');
    assert.equal((await rpc('run/approve', reply)).result.status, 'duplicate');
    const projected = (await rpc('run/events', { runId, cursor: 0 })).result.events
      .find(event => event.kind === 'tool.completed' && event.callId === 'effect-call');
    assert.equal(projected.status, 'error');
    assert.equal(projected.result.code, 'approval_prompts_disabled');
    assert.equal(projected.result.executed, false);
    assert.equal(projected.result.retryable, false);
    assert.match(projected.result.message, /Do not retry/);
    assert.match(JSON.stringify(modelRequests[1].messages), /approval_prompts_disabled/);
    assert.match(JSON.stringify(modelRequests[1].messages), /Changing the arguments cannot grant permission/);
    assert.deepEqual((await (await fetch(base + 'host-requests?waitMs=0&runId=' + runId, { headers })).json()).requests, []);
    return;
  }
  assert.equal((await rpc('run/approve', { runId, interactionId: pendingApproval.interactionId, decision: 'allow' })).result.status, 'accepted');
  const approved = await callback();
  assert.equal(approved.params.effect.approved, true);
  assert.deepEqual(approved.params.effect.observations, observations);
  assert.deepEqual(await post('host-reply', { id: approved.id, result: { status: 'ok', content: { committed: true } } }), { accepted: true });
  assert.equal((await until(state => state.terminal)).phase, 'completed');
  const { result } = await rpc('run/host-observations', { runId });
  assert.deepEqual(result, { contract: ENGINE_HOST_EFFECT, runId, effectTools: ['host_write_fact'], observations });
  assert.equal(calls, 2);
});

test('the engine reads frozen host Context through Run-scoped callbacks', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-engine-context-'));
  const workspace = join(root, 'work');
  mkdirSync(workspace);
  const token = 'fixture-context-credential', observed = [];
  const service = createEngineService({
    token, startup: { workspace, stateDir: join(root, 'ledger'), approval: 'deny',
      scope: { tenantId: 'fixture', workspaceId: 'workspace', userId: 'user', agentId: 'agent' },
      model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_KEY' },
    },
    env: { FIXTURE_KEY: 'fixture-model-key' },
    fetchImpl: async (_url, req) => {
      observed.push(JSON.parse(req.body));
      const frame = { id: 'fixture', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 } };
      return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + service.server.address().port + '/v1/sessions/context/';
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  let next = 0;
  const post = async (path, body) => (await fetch(base + path, {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 'fixture-' + ++next, ...body }),
  })).json();
  const rpc = (method, params) => post('rpc', { method, params });
  const protocolVersions = ['agentkit.engine/v1'];
  const definition = { sourceId: 'fixture.context', bindingDigest: 'sha256:' + 'a'.repeat(64),
    maxTokens: 1024, maxBytes: 8000, timeoutMs: 3000, failureMode: 'fail', allowInstructions: false };
  const run = (runId, allowInstructions = false, failureMode = 'fail') => rpc('run/start', {
    runId, objective: 'only-current-goal',
    conversation: [{ role: 'user', text: 'earlier-imported-chat' }],
    hostContext: { contract: ENGINE_CONTEXT, sources: [{ ...definition, allowInstructions, failureMode }] },
  });
  await rpc('initialize', { protocolVersions, host: { name: 'fixture' } });
  assert.ok((await run('unsupported')).error);
  const hello = await rpc('initialize', { protocolVersions, services: { context: ENGINE_CONTEXT } });
  assert.equal(hello.result.capabilities.hostContext, ENGINE_CONTEXT);

  async function readOnce(runId, item) {
    const polling = fetch(base + 'host-requests?waitMs=2500&runId=' + runId, { headers }).then(r => r.json());
    const stream = rpc('run/events', { runId, cursor: 0, follow: true, waitMs: 5000 });
    const { requests } = await polling;
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.method, 'host/readContext');
    const { sourceId, bindingDigest, goal } = request.params;
    assert.equal(sourceId, definition.sourceId);
    assert.equal(bindingDigest, definition.bindingDigest);
    assert.equal(goal, 'only-current-goal');
    assert.deepEqual(await post('host-reply', { id: request.id, result: {
      contract: ENGINE_CONTEXT, sourceId, bindingDigest, items: [item],
    } }), { accepted: true });
    await stream;
    for (let index = 0; index < 40; index++) {
      const { result } = await rpc('run/status', { runId });
      if (result.terminal) return result;
      await sleep(25);
    }
    assert.fail('context Run did not finish');
  }
  assert.equal((await run('denied')).result.running, false);
  const denied = await readOnce('denied', { projection: 'instructions', fragment: { text: 'forged' } });
  assert.equal(denied.outcome, 'blocked');
  assert.equal(observed.length, 0);
  await run('expired');
  const expired = await readOnce('expired', { projection: 'data', expiresAt: Date.now() - 1000,
    fragment: { text: 'stale-private-value' } });
  assert.equal(expired.outcome, 'blocked');
  assert.equal(observed.length, 0);
  await run('allowed', true);
  const allowed = await readOnce('allowed', { projection: 'instructions', fragment: { text: 'verified-instruction' } });
  assert.equal(allowed.phase, 'completed');
  assert.equal(observed.length, 1);
  assert(observed[0].messages.some(row => row.role === 'system' && row.content.includes('verified-instruction')));
  await run('warned', false, 'warn');
  const warned = await readOnce('warned', { projection: 'instructions', fragment: { text: 'second-forgery' } });
  assert.equal(warned.phase, 'completed');
  assert.equal(observed.length, 2);
  assert(observed[1].messages.some(row => row.role === 'user' && row.content.includes('context_source_unavailable')));
  assert(!JSON.stringify(observed[1].messages).includes('second-forgery'));
});

test('the network service owns Runs, host callbacks and durable session state', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-engine-service-'));
  const workspace = join(root, 'work');
  mkdirSync(workspace);
  const token = 'fixture-service-credential';
  const env = { ENGINE_TEST_MODEL_KEY: 'fixture-model-key', PATH: process.env.PATH };
  const startup = { workspace, stateDir: join(root, 'state'), approval: 'deny', approvalTimeoutMs: 4000,
    scope: { tenantId: 'fixture', workspaceId: 'workspace', userId: 'user', agentId: 'agent' },
    model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'ENGINE_TEST_MODEL_KEY' } };
  let calls = 0, secondEffectCount = 0;
  const blocked = Promise.withResolvers();
  const model = async (_url, { signal }) => {
    const call = ++calls;
    const paths = { 1: ['out.txt'], 3: ['second.txt'], 6: ['before-restart.txt', 'approved.txt'] }[call];
    if (call === 4) {
      blocked.resolve();
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    const frames = [
      { id: 'reply', choices: [{ index: 0, delta: paths
        ? { tool_calls: paths.map((path, index) => ({ index, id: 'write-' + (index + 1), type: 'function', function: {
          name: 'write_workspace_file', arguments: JSON.stringify({ path, content: 'service output' }) } })) }
        : { content: 'Done.' } }] },
      { id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: paths ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  };
  let service, origin, next = 0;
  t.after(async () => { await service?.close(); await rm(root, { recursive: true, force: true }); });
  async function start() {
    service = createEngineService({ startup, token, env, fetchImpl: model });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + service.server.address().port;
  }
  const request = (session, endpoint, frame) => fetch(origin + '/v1/sessions/' + session + '/' + endpoint, {
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(frame ? { method: 'POST', body: JSON.stringify(frame) } : {}),
  });
  const rpc = async (session, method, params) => {
    const response = await request(session, 'rpc', { jsonrpc: '2.0', id: 'request-' + ++next, method, params });
    assert.equal(response.status, 200);
    return response.json();
  };
  const initialize = (session, services = { approvals: true }) => rpc(session, 'initialize', { protocolVersions: ['agentkit.engine/v1'],
    host: { name: 'fixture' }, services });

  await start();
  const health = await (await fetch(origin + '/healthz')).json();
  assert.equal(health.ready, true);
  assert.equal(health.capabilities.scopedHostRequests, true);
  const unauth = await fetch(origin + '/v1/sessions/first/host-requests');
  assert.equal(unauth.status, 401);
  const hello = (await initialize('first')).result;
  assert.equal(hello.protocolVersion, 'agentkit.engine/v1');
  assert.equal(health.capabilities.toolPolicy, hello.capabilities.toolPolicy);
  assert.equal(hello.capabilities.inputImages, undefined);
  const view = hello.capabilities.ui;
  assert.match(view.sha256, /^[a-f0-9]{64}$/);
  const viewUrl = () => origin + '/v1/views/' + view.sha256;
  const auth = { authorization: 'Bearer ' + token };
  assert.equal((await fetch(viewUrl())).status, 401);
  async function assertView() {
    const response = await fetch(viewUrl(), { headers: auth });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.equal(createHash('sha256').update(await response.text()).digest('hex'), view.sha256);
  }
  await assertView();
  const { result } = await rpc('first', 'run/start', { runId: 'run-1', objective: 'Write out.txt and confirm.' });
  assert.equal(result.runId, 'run-1');
  assert.deepEqual(result.view, view);
  async function approveNext(runId) {
    let approval;
    for (let attempt = 0; !approval && attempt < 40; ++attempt) {
      if (runId) {
        const wrong = await request('first', 'host-requests?runId=unrelated');
        assert.deepEqual(await wrong.json(), { requests: [] });
      }
      const { requests } = await (await request('first',
        runId ? `host-requests?runId=${runId}` : 'host-requests')).json();
      approval = requests[0];
      if (!approval) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(approval?.method, 'host/approveTool');
    if (runId) assert.equal(approval.params.runId, runId);
    if (approval.params.arguments.path === 'second.txt') secondEffectCount++;
    const reply = await request('first', 'host-reply', { jsonrpc: '2.0', id: approval.id, result: { decision: 'allow' } });
    assert.equal(reply.status, 200);
  }
  async function awaitTerminal(runId) {
    let state;
    for (let attempt = 0; attempt < 40; ++attempt) {
      state = (await rpc('first', 'run/status', { runId })).result;
      if (state.terminal) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return state;
  }
  await approveNext('run-1');
  const state = await awaitTerminal('run-1');
  assert.equal(state.phase, 'completed');
  assert.equal(readFileSync(join(workspace, 'out.txt'), 'utf8'), 'service output');
  await initialize('other');
  assert.equal((await rpc('other', 'run/status', { runId: 'run-1' })).error.code, -32011);

  await service.close();
  await start();
  await initialize('first');
  const restored = (await rpc('first', 'run/status', { runId: 'run-1', deliveryPresentation: true })).result;
  assert.deepEqual(restored.deliveryEvidence, { files: [{ path: 'out.txt', added: 1, removed: 0 }],
    screenshots: [], truncated: false, basis: 'run-net-diff/v1' });
  assert.equal(restored.finalText, 'Done.');
  assert.deepEqual(restored.view, view);
  await assertView();
  assert.equal(calls, 2);

  const nextRun = (await rpc('first', 'run/start', { runId: 'run-2', objective: 'Write second.txt and confirm.' })).result;
  assert.equal(nextRun.runId, 'run-2');
  await approveNext();
  await blocked.promise;
  assert.equal(readFileSync(join(workspace, 'second.txt'), 'utf8'), 'service output');
  await service.close();
  await start();
  await initialize('first');
  const interrupted = (await rpc('first', 'run/status', { runId: 'run-2' })).result;
  assert.equal(interrupted.terminal, false);
  const readOnly = (await rpc('first', 'run/events', { runId: 'run-2', cursor: interrupted.cursor })).result;
  assert.equal(readOnly.running, false);
  assert.equal(calls, 4);
  const following = (await rpc('first', 'run/events', { runId: 'run-2', cursor: interrupted.cursor, follow: true })).result;
  assert.equal(following.running, true);
  assert.equal((await awaitTerminal('run-2')).phase, 'completed');
  assert.equal(calls, 5);
  assert.equal(secondEffectCount, 1);
  assert.deepEqual((await (await request('first', 'host-requests')).json()).requests, []);

  const durable = { durableApprovals: true };
  assert.equal((await initialize('first', durable)).result.capabilities.approvals, 'durable');
  const runId = 'run-3';
  await rpc('first', 'run/start', { runId, objective: 'Write approved.txt and confirm.' });
  async function waitForApproval(path) {
    for (let attempt = 0; attempt < 80; ++attempt) {
      const pending = (await rpc('first', 'run/status', { runId })).result;
      if (pending.pendingApproval?.subject === path && !pending.running) return pending.pendingApproval;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`missing pending approval for ${path}`);
  }
  const firstFile = join(workspace, 'before-restart.txt');
  const firstApproval = await waitForApproval('before-restart.txt');
  assert.equal(existsSync(firstFile), false);
  const firstDecision = { runId, interactionId: firstApproval.interactionId, decision: 'allow' };
  assert.equal((await rpc('first', 'run/approve', firstDecision)).result.status, 'accepted');
  const approval = await waitForApproval('approved.txt');
  const firstStamp = statSync(firstFile, { bigint: true }).mtimeNs;
  assert.equal(approval?.tool, 'write_workspace_file');
  assert.equal(approval.subject, 'approved.txt');
  assert.equal(existsSync(join(workspace, 'approved.txt')), false);
  assert.deepEqual((await (await request('first', 'host-requests')).json()).requests, []);
  await service.close();
  await start();
  await initialize('first', durable);
  assert.deepEqual((await rpc('first', 'run/status', { runId })).result.pendingApproval, approval);
  assert.equal((await rpc('first', 'run/events', { runId, follow: true })).result.running, false);
  const decision = { runId, interactionId: approval.interactionId, decision: 'allow' };
  assert.equal((await rpc('first', 'run/approve', { ...decision, interactionId: 'wrong' })).error.message, 'interaction_mismatch');
  assert.equal((await rpc('first', 'run/approve', decision)).result.status, 'accepted');
  assert.equal((await awaitTerminal(runId)).phase, 'completed');
  assert.equal(readFileSync(join(workspace, 'approved.txt'), 'utf8'), 'service output');
  assert.equal(statSync(firstFile, { bigint: true }).mtimeNs, firstStamp);
  assert.equal((await rpc('first', 'run/approve', decision)).result.status, 'duplicate');
  assert.equal((await rpc('first', 'run/approve', { ...decision, decision: 'deny' })).error.message, 'command_replay_conflict');
  const { events } = (await rpc('first', 'run/events', { runId })).result;
  assert.equal(events.filter(event => event.kind === 'approval.resolved' && event.interactionId === approval.interactionId).length, 1);
  assert.equal(events.filter(event => event.kind === 'tool.completed' && event.callId === approval.callId).length, 1);
  assert.equal(events.filter(event => event.kind === 'tool.completed' && event.callId === firstApproval.callId).length, 1);
  assert.equal(calls, 7);
});

for (const restricted of [false, true]) test(`a child keeps its original approval and committed effects when the service restarts (${restricted ? 'custom policy' : 'original policy'})`, { timeout: 30000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-engine-child-')));
  const workspace = join(root, 'work');
  mkdirSync(workspace);
  const stateDir = join(root, 'state');
  const token = 'fixture-child-service-credential';
  const startup = { workspace, stateDir, approval: 'deny', approvalTimeoutMs: 4000,
    scope: { tenantId: 'fixture', workspaceId: 'workspace', userId: 'user', agentId: 'agent' },
    model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'ENGINE_TEST_MODEL_KEY' },
    subAgents: [{ name: 'writer', instructions: 'Perform the fixture child writes.', tools: ['write_workspace_file', 'read_workspace_file'], maxTurns: 4 }] };
  let service, origin, next = 0, parentCalls = 0, childCalls = 0;
  t.after(async () => { await service?.close(); await rm(root, { recursive: true, force: true }); });
  const call = (id, name, args) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const model = async (_url, options) => {
    const request = JSON.parse(options.body);
    const child = request.messages.some(message => typeof message.content === 'string' && message.content.includes('Perform the fixture child writes.'));
    if (child) assert.equal(request.tools.some(tool => tool.function.name === 'read_workspace_file'), !restricted);
    const step = child ? ++childCalls : ++parentCalls;
    let delta;
    if (child && step <= 2) delta = call('child-write-' + step, 'write_workspace_file', { path: `child-${step}.txt`, content: `saved ${step}` });
    else if (!child && step === 1) delta = call('delegate', 'native_delegate', { role: 'writer', task: 'Write the two files.' });
    else delta = { content: child ? 'Child finished.' : 'Parent finished.' };
    const frames = [{ id: 'reply', choices: [{ index: 0, delta }] },
      { id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }];
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const runId = 'parent-run';
  async function rpc(method, params) {
    const response = await fetch(origin + '/v1/sessions/child-proof/rpc', { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'request-' + ++next, method, params }) });
    assert.equal(response.status, 200);
    const frame = await response.json();
    assert.equal(frame.error, undefined, JSON.stringify(frame.error));
    return frame.result;
  }
  async function start() {
    service = createEngineService({ startup, token, env: { ENGINE_TEST_MODEL_KEY: 'fixture-key' }, fetchImpl: model });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + service.server.address().port;
    const hello = await rpc('initialize', { protocolVersions: ['agentkit.engine/v1'], services: { durableApprovals: true } });
    assert.equal(hello.capabilities.toolPolicy, 'agentkit.native-agent-policy/v1');
  }
  async function waitFor(predicate) {
    let status;
    for (let attempt = 0; attempt < 150; ++attempt) {
      status = await rpc('run/status', { runId });
      if (!status.running && predicate(status)) return status;
      if (status.terminal && !status.running) break;
      await sleep(20);
    }
    assert.fail(`unexpected Run state: ${JSON.stringify(status)}; parent calls ${parentCalls}, child calls ${childCalls}`);
  }
  const approve = interactionId => rpc('run/approve', { runId, interactionId, decision: 'allow' });
  await start();
  await rpc('run/start', { runId, objective: 'Delegate file writing to the child.', ...(restricted ? { toolPolicy: {
    contract: 'agentkit.native-agent-policy/v1', mode: 'custom',
    rules: { native_delegate: 'inherit', write_workspace_file: 'ask', read_workspace_file: 'deny' },
  } } : {}) });
  const first = (await waitFor(status => status.pendingApproval?.subject === 'child-1.txt')).pendingApproval;
  assert.ok(first.childRunId);
  assert.equal(first.requiresUserApproval, restricted ? true : undefined);
  assert.equal((await approve(first.interactionId)).status, 'accepted');
  const second = (await waitFor(status => status.pendingApproval?.subject === 'child-2.txt')).pendingApproval;
  assert.equal(second.childRunId, first.childRunId);
  const state = join(stateDir, createHash('sha256').update('child-proof').digest('hex'));
  const { SqliteRunStore } = await import('../src/native/sqlite-store.mjs');
  const inspectChild = () => {
    const ledger = new SqliteRunStore(join(state, 'runs.sqlite'));
    try { return ledger.load({ ...startup.scope, agentId: 'agent:child:writer' }, first.childRunId); }
    finally { ledger.close(); }
  };
  const firstChild = inspectChild();
  const childBinding = firstChild.configuration.hostRecoveryBinding.childWorkspace;
  const { createStudioNativeChildWorkspaces } = await import('../src/native/child-workspace-binding.mjs');
  const childRoot = createStudioNativeChildWorkspaces({ workspaceRoot: workspace, stateDir: state }).files.load(childBinding.isolationId).root;
  const firstFile = join(childRoot, 'child-1.txt');
  assert.equal(readFileSync(firstFile, 'utf8'), 'saved 1');
  const firstStamp = statSync(firstFile, { bigint: true }).mtimeNs;
  assert.equal(existsSync(join(childRoot, 'child-2.txt')), false);
  await service.close();
  await start();
  assert.deepEqual((await rpc('run/status', { runId })).pendingApproval, second);
  const { events } = await rpc('run/events', { runId, follow: true });
  assert.equal(events.find(event => event.interactionId === second.interactionId)?.approvalContract, 'agentkit.engine-approval/v1');
  assert.equal((await approve(second.interactionId)).status, 'accepted');
  assert.equal((await waitFor(status => status.terminal)).phase, 'completed');
  assert.equal((await approve(second.interactionId)).status, 'duplicate');
  assert.equal(readFileSync(join(childRoot, 'child-2.txt'), 'utf8'), 'saved 2');
  assert.equal(statSync(firstFile, { bigint: true }).mtimeNs, firstStamp);
  assert.equal(existsSync(join(workspace, 'child-1.txt')), false);
  const restoredChild = inspectChild();
  assert.equal(restoredChild.snapshot.phase, 'completed');
  assert.equal(restoredChild.snapshot.pendingInteraction, null);
  assert.deepEqual(restoredChild.events.filter(event => event.kind === 'tool.completed')
    .map(event => event.payload.callId), ['child-write-1', 'child-write-2']);
  assert.equal(childCalls, 3);
});

test('a newer view bundle does not replace a previous Run view', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-engine-view-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'session');
  const makeView = (html, version) => ({
    contract: 'agentkit.engine-view/v1', version, html, contentType: 'text/html; charset=utf-8',
    sha256: createHash('sha256').update(html).digest('hex'),
  });
  const first = makeView('<!doctype html><title>First</title>', '1');
  const second = makeView('<!doctype html><title>Second</title>', '2');
  const oldService = createEngineViewStore(join(root, 'archive'));
  oldService.pin(stateDir, 'old-run', oldService.archive(first));

  const newService = createEngineViewStore(join(root, 'archive'));
  newService.pin(stateDir, 'new-run', newService.archive(second));
  newService.pin(stateDir, 'old-run', newService.archive(second));

  assert.equal(newService.reference(stateDir, 'old-run').sha256, first.sha256);
  assert.equal(newService.get(first.sha256).html, first.html);
  assert.equal(newService.reference(stateDir, 'new-run').sha256, second.sha256);
  assert.equal(newService.get(second.sha256).html, second.html);
});

test('image-capable independent service admits bounded current-turn media and projects it only to the model', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-engine-input-'));
  const workspace = join(root, 'work');
  mkdirSync(workspace);
  const token = 'fixture-image-service-token';
  const startup = { workspace, stateDir: join(root, 'state'), approval: 'deny',
    scope: { tenantId: 'fixture', workspaceId: 'workspace', userId: 'user', agentId: 'agent' },
    model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'IMAGE_KEY', images: true } };
  const requests = [];
  const service = createEngineService({ token, startup, env: { IMAGE_KEY: 'fixture-model-key' }, fetchImpl: async (_url, request) => {
    requests.push(JSON.parse(request.body));
    const reply = { id: 'reply', choices: [{ index: 0, delta: { content: 'Image received.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } };
    return new Response(`data: ${JSON.stringify(reply)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  let id = 0;
  const rpc = async (method, params) => {
    const response = await fetch('http://127.0.0.1:' + service.server.address().port + '/v1/sessions/image/rpc', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: String(++id), method, params }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const hello = (await rpc('initialize', { protocolVersions: ['agentkit.engine/v1'] })).result;
  assert.equal(hello.capabilities.inputImages.maxCount, 8);
  const start = (runId, url) => rpc('run/start', {
    runId, objective: 'Describe the current image.', inputImages: [{ type: 'image_url', image_url: { url } }],
  });
  const invalid = await start('remote', 'https://example.test/file.png');
  assert.equal(invalid.error.message, 'engine_input_image_must_be_inline');
  assert.equal((await rpc('run/status', { runId: 'remote' })).error.code, -32011);
  const tooMany = await rpc('run/start', { runId: 'oversized', objective: 'Inspect images.',
    inputImages: Array.from({ length: 9 }, () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })) });
  assert.equal(tooMany.error.message, 'engine_input_images_invalid');
  assert.equal(requests.length, 0);

  const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
  assert.equal((await start('image-run', url)).result.runId, 'image-run');
  let cursor = 0, terminal = false;
  for (let attempt = 0; attempt < 30 && !terminal; attempt++) {
    const { result } = await rpc('run/events', { runId: 'image-run', cursor, waitMs: 1000, follow: true });
    assert.ok(result);
    assert.doesNotMatch(JSON.stringify(result), /data:image/);
    cursor = result.cursor;
    terminal = result.events.some(event => event.kind === 'run.terminal');
  }
  assert.equal(terminal, true);
  assert.equal(requests.length, 1);
  const user = requests[0].messages.findLast(message => message.role === 'user');
  assert.deepEqual(user.content, [{ type: 'text', text: 'Describe the current image.' },
    { type: 'image_url', image_url: { url, detail: 'auto' } }]);
});
