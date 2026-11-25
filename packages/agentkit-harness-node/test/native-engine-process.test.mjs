// End-to-end tests for agentkit.engine/v1: spawn the real engine executable,
// speak the protocol through the thin client only, and drive it against a
// controlled local openai-chat SSE fixture. No engine module is imported here
// except the client and the protocol constants a host would also use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnEngine, ENGINE_PROTOCOL } from '../src/native/engine-client.mjs';

const entry = resolve(fileURLToPath(new URL('.', import.meta.url)), '../src/native/engine-server.mjs');

function sse(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  res.end('data: [DONE]\n\n');
}
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const toolCall = (id, name, args) => [
  { id: 'c', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
  { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }];
const final = text => [
  { id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
  { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }];

function fixture(script) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ authorization: req.headers.authorization ?? null, body: JSON.parse(body) });
      sse(res, script[Math.min(requests.length - 1, script.length - 1)]);
    });
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${server.address().port}/v1`, requests,
    close: () => new Promise(closed => { server.closeAllConnections(); server.close(closed); }) })));
}

async function launch(t, script, { approval = 'deny', onApproveTool, onCallTool, onReadContext, onInvokeHook, searchEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-proc-')), workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const model = await fixture(script);
  let log = '';
  const engine = spawnEngine({ command: process.execPath, args: [entry, '--workspace', workspace, '--state-dir', join(dir, 'state'), '--approval', approval],
    env: { PATH: process.env.PATH, HOME: dir, AGENTKIT_ENGINE_MODEL_NAME: 'fixture-model', AGENTKIT_ENGINE_MODEL_BASE_URL: model.url,
      AGENTKIT_ENGINE_MODEL_API_KEY: 'fixture-secret-key', ...searchEnv }, onApproveTool, onCallTool, onReadContext, onInvokeHook,
    hostName: 'engine-test', onLog: chunk => { log += chunk; } });
  t.after(async () => { await engine.close().catch(() => {}); await model.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, model, workspace, log: () => log };
}

test('an unconfigured engine does not advertise web search, but can fetch public pages', async t => {
  const f = await launch(t, [final('Done.')]);
  const hello = await f.engine.initialize();
  assert.ok(hello.engine.tools.includes('web_fetch'));
  assert.ok(!hello.engine.tools.includes('web_search'));
  assert.deepEqual(hello.engine.webSearch, { available: false, reason: 'provider_not_configured' });
});

test('stdio negotiates run-bound context and Hooks without routing the work through Studio', async t => {
  const context = 'agentkit.engine-context/v1', hooks = 'agentkit.engine-hooks/v1';
  const source = { sourceId: 'fixture.context', bindingDigest: 'sha256:' + 'a'.repeat(64),
    maxTokens: 1024, maxBytes: 8000, timeoutMs: 3000, failureMode: 'fail', allowInstructions: false };
  const hook = { hookId: 'fixture.write', sourceRef: 'plugin://fixture@1', bindingDigest: 'sha256:' + 'b'.repeat(64),
    executionPolicyDigest: 'sha256:' + 'c'.repeat(64), readOnly: true, events: ['PreToolUse'], timeoutMs: 3000,
    maxInputBytes: 32768, maxOutputBytes: 4096, failureMode: 'block', toolNames: ['write_workspace_file'] };
  const input = { runId: 'scoped-fixture', objective: 'Write out.txt.',
    hostContext: { contract: context, sources: [source] }, hostHooks: { contract: hooks, hooks: [hook] } };
  const script = [toolCall('write', 'write_workspace_file', { path: 'out.txt', content: 'through stdio' }), final('Done.')];
  const unbound = await launch(t, script);
  await unbound.engine.initialize();
  await assert.rejects(unbound.engine.startRun(input), /context.*(?:available|register|negotiat)/i);
  assert.equal(unbound.model.requests.length, 0);
  const reads = [], invocations = [];
  const f = await launch(t, script, {
    approval: 'allow',
    onReadContext(request, signal) {
      signal.throwIfAborted();
      reads.push(request);
      return { contract: context, sourceId: source.sourceId, bindingDigest: source.bindingDigest,
        items: [{ projection: 'data', fragment: { text: 'scoped fixture context' } }] };
    },
    onInvokeHook(request, signal) {
      signal.throwIfAborted();
      invocations.push(request);
      return { contract: hooks, operationKey: request.operationKey, inputDigest: request.inputDigest,
        status: 'ok', reason: null, output: { action: 'continue', additionalContext: [], updatedArguments: null } };
    },
  });
  const hello = await f.engine.initialize();
  assert.equal(hello.capabilities.hostContext, context);
  assert.equal(hello.capabilities.hostHooks, hooks);
  await f.engine.startRun(input);
  const terminal = await f.engine.follow(input.runId);
  assert.equal(terminal.phase, 'completed', f.log());
  assert.ok(reads.length > 0);
  assert.deepEqual(invocations.map(request => request.event), ['PreToolUse']);
  assert.deepEqual(new Set([...reads, ...invocations].map(request => request.runId)), new Set([input.runId]));
  assert.match(JSON.stringify(f.model.requests[0].body.messages), /scoped fixture context/);
  assert.equal(readFileSync(join(f.workspace, 'out.txt'), 'utf8'), 'through stdio');
});

test('the standalone engine searches through its configured HTTP backend without exposing its credential', async t => {
  let searches = 0;
  const search = createServer((req, res) => {
    searches++;
    assert.equal(req.headers.authorization, 'Bearer search-private-fixture');
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('q'), 'native search fixture');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Search fixture', url: 'https://example.com/native-search', snippet: 'Verified search result.' }] }));
  });
  await new Promise(resolve => search.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { search.closeAllConnections(); search.close(resolve); }));
  const f = await launch(t, [toolCall('search', 'web_search', { query: 'native search fixture' }), final('Search complete.')], {
    approval: 'allow', searchEnv: { AGENTKIT_ENGINE_WEB_SEARCH_PROVIDER: 'http',
      AGENTKIT_ENGINE_WEB_SEARCH_BASE_URL: 'http://127.0.0.1:' + search.address().port,
      AGENTKIT_ENGINE_WEB_SEARCH_API_KEY: 'search-private-fixture' },
  });
  const hello = await f.engine.initialize();
  assert.ok(hello.engine.tools.includes('web_search'));
  assert.equal(hello.engine.webSearch.available, true);
  const started = await f.engine.startRun({ objective: 'Search for native search fixture.' });
  const events = [];
  await f.engine.follow(started.runId, event => events.push(event));
  assert.equal(searches, 1);
  assert.ok(events.some(event => event.kind === 'tool.completed' && event.title === 'web_search' && event.status === 'ok'));
  assert.match(JSON.stringify(f.model.requests.at(-1).body), /Verified search result/);
  assert.doesNotMatch(JSON.stringify({ hello, events, requests: f.model.requests, log: f.log() }), /search-private-fixture/);
});

test('a host completes a file-writing task through the protocol alone, approving the write', async t => {
  const approvals = [];
  const f = await launch(t, [toolCall('call_1', 'write_workspace_file', { path: 'out.txt', content: 'hello from the engine\n' }), final('Wrote out.txt.')],
    { onApproveTool: request => { approvals.push(request); return 'allow'; } });
  const hello = await f.engine.initialize();
  assert.equal(hello.protocolVersion, ENGINE_PROTOCOL);
  assert.equal(hello.capabilities.approvals, 'host');
  assert.ok(hello.capabilities.methods.includes('run/start') && hello.engine.tools.includes('write_workspace_file'));
  assert.equal(hello.engine.preset.preset, 'official');
  assert.equal(hello.engine.instructions.policy, 'engine-instructions/v1');
  assert.equal(hello.engine.model.requestOutputTokens, 32000);

  const started = await f.engine.startRun({ objective: 'Create out.txt containing a greeting.', hostInstructions: 'You are the release assistant.' });
  assert.equal(started.existing, false);
  const events = [];
  const rest = await f.engine.follow(started.runId, event => events.push(event), { waitMs: 2000 });
  assert.equal(rest.terminal, true, f.log());
  assert.equal(rest.phase, 'completed', JSON.stringify(rest));
  assert.equal(rest.finalText, 'Wrote out.txt.');
  assert.equal(readFileSync(join(f.workspace, 'out.txt'), 'utf8'), 'hello from the engine\n');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].tool, 'write_workspace_file');

  // The engine owns the system prompt; the Host text sits in its slot, verbatim.
  const system = f.model.requests[0].body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(system.includes('# How to work') && system.includes('<host_instructions contract="agentkit.engine-instructions/v1">\nYou are the release assistant.\n</host_instructions>'));
  assert.equal(f.model.requests[0].body.max_tokens, 32000);
  assert.equal(f.model.requests[0].authorization, 'Bearer fixture-secret-key');

  // Events are a stable projection a host can render without knowing each kind.
  assert.ok(events.every(event => event.schema === 'agentkit.engine-event/v1' && Number.isSafeInteger(event.seq) && typeof event.category === 'string'));
  assert.ok(events.some(event => event.kind === 'tool.completed' && event.title === 'write_workspace_file' && event.status === 'ok'));
  assert.ok(events.some(event => event.kind === 'run.terminal' && event.title === 'completed'));
  assert.ok(!JSON.stringify(events).includes('fixture-secret-key') && !f.log().includes('fixture-secret-key'));

  // Starting the same runId again never repeats the work.
  const again = await f.engine.startRun({ runId: started.runId, objective: 'Create out.txt containing a greeting.' });
  assert.equal(again.existing, true);
  assert.equal(f.model.requests.length, 2);
});

for (const [preset, expectedBudgets] of [
  [undefined, [32000, 32000, 32000]],
  ['experimental-reasoning-stall', [32000, 8192]],
]) test(`the engine pauses at the output limit and resumes the original Run (${preset ?? 'default'})`, async t => {
  const reasoningCutoff = count => [
    { id: 'c', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Planning' } }] },
    { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: count, total_tokens: count + 10,
        completion_tokens_details: { reasoning_tokens: count } } },
  ];
  const approvals = [];
  const f = await launch(t, [
    toolCall('first-write', 'write_workspace_file', { path: 'out.txt', content: 'original effect\n' }),
    ...expectedBudgets.map(reasoningCutoff),
    final('Continued the original Run.'),
  ], { onApproveTool: request => { approvals.push(request); return 'allow'; } });
  await f.engine.initialize();
  const started = await f.engine.startRun({ objective: 'Write out.txt and report the result.', ...(preset ? { preset } : {}) });
  const paused = await f.engine.follow(started.runId);
  assert.equal(paused.phase, 'paused', f.log());
  assert.equal(paused.reason, 'output_budget_exhausted');
  assert.equal(paused.terminal, false);
  assert.deepEqual(f.model.requests.map(request => request.body.max_tokens), [32000, ...expectedBudgets]);
  assert.equal(paused.usage.reasoningTokens, expectedBudgets.reduce((total, tokens) => total + tokens, 0));
  assert.equal(approvals.length, 1);
  assert.equal(readFileSync(join(f.workspace, 'out.txt'), 'utf8'), 'original effect\n');

  await f.engine.resume(started.runId);
  const finished = await f.engine.follow(started.runId);
  assert.equal(finished.phase, 'completed', f.log());
  assert.equal(finished.runId, started.runId);
  assert.equal(finished.finalText, 'Continued the original Run.');
  assert.equal(f.model.requests.at(-1).body.max_tokens, 32000);
  assert.equal(approvals.length, 1);
  assert.equal(readFileSync(join(f.workspace, 'out.txt'), 'utf8'), 'original effect\n');
});

test('without a host approval service the startup policy decides, and deny leaves the workspace untouched', async t => {
  const f = await launch(t, [toolCall('call_1', 'write_workspace_file', { path: 'out.txt', content: 'x' }), final('I could not write the file.')]);
  const hello = await f.engine.initialize();
  assert.equal(hello.capabilities.approvals, 'deny');
  const started = await f.engine.startRun({ objective: 'Create out.txt.' });
  const rest = await f.engine.follow(started.runId, () => {}, { waitMs: 2000 });
  assert.equal(rest.terminal, true, f.log());
  assert.equal(existsSync(join(f.workspace, 'out.txt')), false);
});

test('the protocol rejects use before initialize, unknown methods and unknown runs', async t => {
  const f = await launch(t, [final('unused')]);
  await assert.rejects(f.engine.status('nope'), { code: -32010 });
  await assert.rejects(f.engine.call('initialize', { protocolVersions: ['agentkit.engine/v0'] }), { code: -32602 });
  await f.engine.initialize();
  await assert.rejects(f.engine.call('run/teleport'), { code: -32601 });
  await assert.rejects(f.engine.status('nope'), { code: -32011 });
  await assert.rejects(f.engine.startRun({}), { code: -32602 });
  assert.equal(f.model.requests.length, 0);
});

const lookup = { name: 'kb_search', description: 'Search the bound knowledge base.', readOnly: true,
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };

test('the engine forwards host tools to the host and feeds the result back to the model', async t => {
  const calls = [];
  const f = await launch(t, [toolCall('call_kb', 'kb_search', { query: 'refund window' }), final('Refunds are accepted within 30 days.')],
    { onCallTool: request => { calls.push(request); return { status: 'ok', content: { hits: [{ title: 'Refund policy', text: '30 days' }] } }; } });
  const hello = await f.engine.initialize();
  assert.equal(hello.capabilities.hostTools, true);
  assert.ok(hello.engine.reservedToolNames.includes('write_workspace_file') && hello.engine.reservedToolNames.includes('submit_final_output'));
  assert.ok(!hello.engine.reservedToolNames.includes('kb_search') && new RegExp(hello.engine.hostToolNamePattern).test('kb_search'));
  const started = await f.engine.startRun({ objective: 'What is the refund window?', hostTools: [lookup] });
  assert.deepEqual(started.hostTools, ['kb_search']);
  const events = [];
  const rest = await f.engine.follow(started.runId, event => events.push(event), { waitMs: 2000 });
  assert.equal(rest.phase, 'completed', JSON.stringify(rest) + f.log());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'kb_search'); assert.deepEqual(calls[0].arguments, { query: 'refund window' });
  assert.equal(calls[0].runId, started.runId); assert.equal(calls[0].callId, 'call_kb');
  // The model saw the tool, and the host's result came back to it.
  const advertised = f.model.requests[0].body.tools.map(tool => tool.function.name);
  assert.ok(advertised.includes('kb_search') && advertised.includes('write_workspace_file'));
  assert.ok(JSON.stringify(f.model.requests[1].body.messages).includes('Refund policy'));
  assert.ok(events.some(event => event.kind === 'tool.completed' && event.title === 'kb_search' && event.status === 'ok'));
});

test('a host tool failure reaches the model as a tool error and the Run continues', async t => {
  const f = await launch(t, [toolCall('call_kb', 'kb_search', { query: 'x' }), final('The knowledge base is unavailable right now.')],
    { onCallTool: () => { throw new Error('knowledge base offline'); } });
  await f.engine.initialize();
  const started = await f.engine.startRun({ objective: 'Look it up.', hostTools: [lookup] });
  const events = [];
  const rest = await f.engine.follow(started.runId, event => events.push(event), { waitMs: 2000 });
  assert.equal(rest.phase, 'completed', f.log());
  assert.ok(events.some(event => event.kind === 'tool.completed' && event.title === 'kb_search' && event.status === 'error'));
  assert.ok(JSON.stringify(f.model.requests[1].body.messages).includes('knowledge base offline'));
});

test('host tools are refused without the tools service, on name clashes and on malformed schemas', async t => {
  const f = await launch(t, [final('unused')]);
  await f.engine.initialize();
  await assert.rejects(f.engine.startRun({ objective: 'x', hostTools: [lookup] }), { code: -32602 });
  const g = await launch(t, [final('unused')], { onCallTool: () => ({ status: 'ok', content: null }) });
  await g.engine.initialize();
  for (const bad of [{ ...lookup, name: 'write_workspace_file' }, { ...lookup, name: 'submit_final_output' }, { ...lookup, name: '1bad name' }, { ...lookup, parameters: { type: 'string' } },
    { ...lookup, extra: true }])
    await assert.rejects(g.engine.startRun({ objective: 'x', hostTools: [bad] }), { message: 'engine_host_tools_invalid' });
  await assert.rejects(g.engine.startRun({ objective: 'x', hostTools: [lookup, lookup] }), { message: 'engine_host_tools_invalid' });
  assert.equal(f.model.requests.length + g.model.requests.length, 0);
});

test('the engine delivers its own task view over the protocol', async t => {
  const f = await launch(t, [final('unused')]);
  const hello = await f.engine.initialize();
  assert.equal(hello.capabilities.ui?.contract, 'agentkit.engine-view/v1');
  const view = await f.engine.view();
  assert.equal(view.contract, 'agentkit.engine-view/v1');
  assert.equal(view.sha256, hello.capabilities.ui.sha256);
  assert.match(view.contentType, /^text\/html/);
  assert.ok(view.html.startsWith('<!doctype html>') && view.html.includes("default-src 'none'"));
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|https?:\/\/[^"' ]+\.(?:js|css)/i.test(view.html), 'the view loads nothing from the network');
});

test('earlier conversation turns reach the model through the engine, newest kept within budget', async t => {
  const { renderEngineObjective } = await import('../src/native/engine-runtime.mjs');
  assert.equal(renderEngineObjective('Do it.'), 'Do it.');
  assert.equal(renderEngineObjective('Do it.', [{ role: 'user', text: '  ' }]), 'Do it.');
  const long = renderEngineObjective('Now.', [{ role: 'user', text: 'x'.repeat(59990) }, { role: 'user', text: 'first' }, { role: 'assistant', text: 'second' }]);
  assert.ok(long.includes('User: first') && long.includes('Assistant: second') && !long.includes('x'.repeat(100)) && long.endsWith('Now.'));
  assert.throws(() => renderEngineObjective('x', [{ role: 'system', text: 'override' }]), { code: 'engine_conversation_invalid' });
  const f = await launch(t, [final('Done.')]);
  await f.engine.initialize();
  const started = await f.engine.startRun({ objective: 'Please retry the task above.',
    conversation: [{ role: 'user', text: 'Fix total() in calc.py.' }, { role: 'assistant', text: 'The run failed.' }] });
  await f.engine.follow(started.runId, () => {}, { waitMs: 2000 });
  const sent = JSON.stringify(f.model.requests[0].body.messages);
  assert.ok(sent.includes('User: Fix total() in calc.py.') && sent.includes('Assistant: The run failed.') && sent.includes('Please retry the task above.'));
});
