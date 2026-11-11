import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createEngineService } from '../src/native/engine-service.mjs';
import { MANAGED_NATIVE_KERNEL_PATH } from '../src/native/engine-managed-service.mjs';
import { nativeKernelPermitBytes } from '../src/native/native-kernel-permit.mjs';
import { AGENT_KERNEL_SUBMIT_PATH } from '../src/native/native-managed-kernel-http.mjs';
import { managedNativeRunId } from '../src/native/native-managed-kernel.mjs';
import { command, permitIssuer, scope, target } from './fixtures/native-managed-kernel.mjs';

async function checkManagedApprovalRecovery(t, approvalMode) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-managed-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const issuer = permitIssuer(), token = 'fixture-managed-command-token';
  const platformToken = 'fixture-kernel-transport-token';
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
  const decisions = [], paths = ['first.txt', 'second.txt'];
  const setup = {
    token, startup: { workspace, stateDir: join(root, 'ledger'), scope,
      model: { name: 'fixture-model', baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_KEY', images: approvalMode === 'platform' } },
    env: { FIXTURE_KEY: 'fixture-model-key', AGENTKIT_HARNESS_PLATFORM_TRANSPORT_TOKEN: platformToken },
    managed: { buildId: 'fixture-managed-build', controlPublicKeys: { server: issuer.publicKeyPem },
      ...(approvalMode === 'platform' ? { platformApprovals: true, platformKernel: { bundleDigest: 'a'.repeat(64) } } : { authorizeInteraction: async ({ authorization, command: input, pending }) => {
        if (authorization.subjectRef !== 'server-user' || input.payload.token_ref !== 'fixture-owner-consent') return false;
        decisions.push(pending.interactionId);
        return true;
      } }) },
    fetchImpl: async (_url, request) => {
      const call = ++modelCalls, body = JSON.parse(request.body), path = paths[call - 1];
      if (approvalMode === 'platform' && call === 1) {
        assert.equal(body.model, 'fixture-model');
        assert(body.messages.some(message => Array.isArray(message.content)
          && message.content.some(part => part.image_url?.url === png)));
      }
      if (call > 1) assert(JSON.stringify(body.messages).includes(paths[call - 2]));
      assert(call <= 3);
      const delta = path ? { tool_calls: [{ index: 0, id: 'write-' + call, type: 'function',
        function: { name: 'write_workspace_file', arguments: JSON.stringify({ path, content: 'verified ' + call }) } }] }
        : { content: 'Managed result.' };
      const frame = { id: 'fixture', choices: [{ index: 0, delta, finish_reason: path ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 } };
      return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  let service, origin, modelCalls = 0;
  t.after(async () => { await service?.close(); await rm(root, { recursive: true, force: true }); });
  async function start(options = setup) {
    service = createEngineService(options);
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + service.server.address().port;
  }
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const platformHeaders = { ...headers, authorization: 'Bearer ' + platformToken };
  const post = (endpoint, body, signal) => fetch(origin + MANAGED_NATIVE_KERNEL_PATH + '/' + endpoint,
    { method: 'POST', headers, body: JSON.stringify(body), signal });
  const enqueue = command({ session_id: 'managed-run-session', payload: approvalMode === 'platform'
    ? { content: [{ type: 'input_text', text: 'Write and verify two files.' }, { type: 'input_image', image_url: png }],
      runtime_options: { model: 'fixture-model', tool_approval_mode: 'ask' } }
    : { content: 'Write and verify two files.' } });
  const query = { tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId, session_id: enqueue.session_id,
    authorization_ref: 'fixture-status' };
  const send = (input, permit = issuer.issue(input)) => approvalMode === 'platform'
    ? fetch(origin + AGENT_KERNEL_SUBMIT_PATH, { method: 'POST', headers: platformHeaders, body: JSON.stringify({ command: input, permit }) })
    : post('commands', { command: input, permit });
  const runId = managedNativeRunId(enqueue);
  const platformQuery = { ...query, schema_version: 1 };
  const platformStatus = () => fetch(origin + '/agent-kernel/v1/GetAgentStatus', { method: 'POST', headers: platformHeaders,
    body: JSON.stringify({ query: platformQuery, permit: issuer.issue(platformQuery, 'get_status') }) }).then(result => result.json());
  const platformEvents = (after, permit = issuer.issue(platformQuery, 'subscribe_events')) => {
    const params = new URLSearchParams({ tenant_id: query.tenant_id, agent_instance_id: query.agent_instance_id,
      session_id: query.session_id, after_seq: String(after) });
    return fetch(origin + '/agent-kernel/v1/SubscribeSessionEvents?' + params, {
      headers: { ...platformHeaders, 'x-agent-control-permit': JSON.stringify(permit) }, signal: AbortSignal.timeout(6000) });
  };
  const approve = (interactionId, tokenRef) => {
    const input = command({ session_id: enqueue.session_id, command_type: 'submit_interaction',
      payload: { run_id: runId, interaction_id: interactionId, token_ref: tokenRef, response: 'approve' } });
    if (approvalMode === 'embedded') return send(input);
    const wire = { ...input, payload: { ...input.payload, token_ref: input.authorization_ref, expected_revision: 1,
      action: 'approve', response: { approved: true } } };
    const { claims_digest, ...claims } = issuer.issue(wire);
    const tool_approval = { contract: 'agentkit.tool-approval-command/v1', command_id: wire.command_id,
      idempotency_key: wire.idempotency_key, run_id: runId, interaction_id: interactionId, expected_revision: 1, action: 'approve' };
    const permit = issuer.signPermit({ ...claims,
      claims_digest: createHash('sha256').update(nativeKernelPermitBytes({ ...claims, tool_approval })).digest('hex') });
    if (tokenRef === 'wrong-owner') return send(wire); // Signed scope alone does not authorize a decision.
    if (tokenRef === 'wrong-decision') return send({ ...wire, payload: { ...wire.payload, action: 'reject' } }, permit);
    return send(wire, permit);
  };

  async function eventWhere(predicate, afterSeq = 0) {
    const subscription = { ...query, after_seq: afterSeq };
    const response = await post('events', { subscription, permit: issuer.issue(subscription, 'subscribe_events') },
      AbortSignal.timeout(6000));
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) assert.fail('Managed event stream ended before expected event');
        pending += decoder.decode(value, { stream: true });
        const frames = pending.split('\n\n');
        pending = frames.pop();
        for (const frame of frames) {
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          const event = data && JSON.parse(data.slice(6));
          if (event && predicate(event)) return event;
        }
      }
    } finally { await reader.cancel(); }
  }

  await start();
  const { capabilities } = await fetch(origin + '/healthz').then(r => r.json());
  assert.equal(capabilities.managedCommands, 'agentkit.managed-native-kernel/v1');
  assert.equal(capabilities.managedToolApprovals, approvalMode === 'platform');
  if (approvalMode === 'platform') {
    const probe = origin + '/agent-kernel/v1/health';
    assert.equal((await fetch(probe)).status, 401);
    assert.equal((await fetch(probe, { headers: platformHeaders })).status, 401);
    assert.equal((await fetch(origin + MANAGED_NATIVE_KERNEL_PATH + '/commands', { method: 'POST', headers: platformHeaders })).status, 401);
    const health = await fetch(probe, { headers });
    assert.equal(health.status, 200);
    const observed = await health.json();
    assert(observed.store_ok && observed.worker_running && observed.lease_healthy);
    assert.equal(observed.capability_digest, '131ac35c98dc1e8ac3f23ec5796feedae962df9ef588c8ad341f7ac1b0b8804b');
    assert.equal(observed.bundle_digest, 'a'.repeat(64));
    assert.throws(() => createEngineService(setup), { code: 'workspace_mutation_busy' });
  }
  assert.equal((await send(enqueue, { ...issuer.issue(enqueue), signature: 'invalid' })).status, 403);
  if (approvalMode === 'platform') {
    const wrongModel = command({ session_id: enqueue.session_id, payload: { ...enqueue.payload, runtime_options: { model: 'unavailable' } } });
    assert.equal((await send(wrongModel)).status, 400);
  }
  assert.equal(modelCalls, 0);
  const accepted = await send(enqueue);
  assert.equal(accepted.status, 202);
  if (approvalMode === 'platform') assert.equal(accepted.headers.get('x-ksadk-control-status'), 'accepted');
  assert.equal((await accepted.json()).run_id, runId);
  const first = await eventWhere(event => event.event_type === 'interaction.requested');
  assert.equal(first.run_id, runId);
  assert(!existsSync(join(workspace, paths[0])));
  assert.equal((await approve(first.payload.interaction_id, 'wrong-owner')).status, approvalMode === 'platform' ? 403 : 400);
  if (approvalMode === 'platform') {
    assert.equal((await approve(first.payload.interaction_id, 'wrong-decision')).status, 403);
    assert(!existsSync(join(workspace, paths[0])));
    const replies = await Promise.all(Array.from({ length: 2 }, () => approve(first.payload.interaction_id, 'fixture-owner-consent')));
    assert.deepEqual(replies.map(reply => reply.status).sort(), [202, 400]);
  } else {
    assert.equal((await approve(first.payload.interaction_id, 'fixture-owner-consent')).status, 202);
  }
  const second = await eventWhere(event => event.event_type === 'interaction.requested', first.seq);
  assert.notEqual(second.payload.interaction_id, first.payload.interaction_id);
  const original = statSync(join(workspace, paths[0]));
  assert.equal(readFileSync(join(workspace, paths[0]), 'utf8'), 'verified 1');
  assert(!existsSync(join(workspace, paths[1])));
  let platformEpoch;
  if (approvalMode === 'platform') {
    const snapshot = await platformStatus();
    assert.equal(snapshot.active_run_id, runId);
    assert.equal(snapshot.active_run_state, 'waiting');
    assert(snapshot.session_event_seq >= second.seq);
    assert.equal(snapshot.capability.interaction_mode, 'durable_resume');
    const subscription = await platformEvents(snapshot.session_event_seq);
    platformEpoch = subscription.headers.get('x-agentengine-history-epoch');
    assert.match(platformEpoch, /^[a-f0-9]{32}$/);
    await subscription.body.cancel();
  }
  await service.close();
  assert.throws(() => createEngineService({ ...setup, startup: {
    ...setup.startup, model: { ...setup.startup.model, name: 'different-binding' },
  } }), { code: 'NATIVE_KERNEL_TARGET_CHANGED' });
  await start();
  const duplicate = await send(enqueue);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).run_id, runId);
  const status = await post('status', { query, permit: issuer.issue(query, 'get_status') }).then(r => r.json());
  assert.deepEqual(status.runs, [{ runId, phase: 'awaiting_interaction' }]);
  if (approvalMode === 'platform') {
    const invalid = await platformEvents(second.seq, issuer.issue(platformQuery, 'subscribe_events', { session_id: null }));
    assert.equal(invalid.status, 403);
    await invalid.body.cancel();
    const expired = await platformEvents(second.seq, issuer.issue(platformQuery, 'subscribe_events', {
      expires_at: new Date(Date.now() - 100).toISOString() }));
    assert.equal(expired.status, 403);
    await expired.body.cancel();
    const subscription = await platformEvents(second.seq - 1);
    assert.equal(subscription.headers.get('x-agentengine-history-epoch'), platformEpoch);
    const reader = subscription.body.pipeThrough(new TextDecoderStream()).getReader();
    let frame = '';
    try {
      while (!frame.includes('\n\n')) {
        const { value, done } = await reader.read();
        assert(!done, 'Platform subscription closed before the first frame');
        frame += value;
      }
    } finally { await reader.cancel(); }
    const data = JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
    assert.equal(data.seq, second.seq);
    assert.equal(data.interaction_id, second.payload.interaction_id);
    assert.equal(data.event_type, 'interaction.requested');
    assert.equal(data.run_id, runId);
  }
  assert.equal(modelCalls, 2);
  assert.equal((await approve(second.payload.interaction_id, 'fixture-owner-consent')).status, 202);
  const completed = await eventWhere(event => event.event_type === 'run.completed', second.seq);
  assert.equal(completed.run_id, runId);
  if (approvalMode === 'embedded') assert.deepEqual(decisions, [first.payload.interaction_id, second.payload.interaction_id]);
  assert.equal(readFileSync(join(workspace, paths[1]), 'utf8'), 'verified 2');
  assert.equal(statSync(join(workspace, paths[0])).mtimeMs, original.mtimeMs);
  assert.equal(modelCalls, 3);
  if (approvalMode === 'platform') {
    const snapshot = await platformStatus();
    assert.equal(snapshot.active_run_id, null);
    assert(snapshot.session_event_seq >= completed.seq);
  }
}
test('embedded signed approvals resume the same durable engine Run after restart', t => checkManagedApprovalRecovery(t, 'embedded'));
test('platform signed approvals resume the same durable engine Run after restart', t => checkManagedApprovalRecovery(t, 'platform'));

test('a lost terminal delivery response retries the same payload without re-running the model', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-managed-delivery-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const issuer = permitIssuer();
  const token = 'fixture-managed-service-auth', callback = 'fixture-managed-session-callback-auth';
  const contract = 'agentkit.managed-host-resources/v1', attempts = [];
  let claim, claims = 0, modelCalls = 0, service;
  const host = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ' + callback);
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.contract, contract);
    let result;
    if (request.url.endsWith('/admit')) {
      result = { ref: 'fixture-host-ref', hostInstructions: '', hostTools: [], sessionDelivery: true };
    } else {
      assert.equal(input.ref, 'fixture-host-ref');
      assert.equal(input.deliveryContract, 'agentkit.managed-session-delivery/v1');
      if (request.url.endsWith('/claim')) {
        assert.equal(input.follow, true);
        claim = input;
        claims++;
      }
      else {
        assert(request.url.endsWith('/finish'));
        attempts.push(body);
        if (attempts.length === 1) { response.destroy(); return; }
      }
      result = { received: true };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ contract, ...result }));
  });
  t.after(async () => {
    await service?.close();
    await new Promise(resolve => host.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1',
    () => resolve('http://127.0.0.1:' + server.address().port)));
  const endpoint = await listen(host);
  service = createEngineService({
    token, startup: { workspace, stateDir: join(root, 'ledger'), scope,
      model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_KEY' } },
    env: { FIXTURE_KEY: 'fixture-key', CALLBACK_TOKEN: callback },
    managed: { buildId: 'fixture-delivery-build', controlPublicKeys: { server: issuer.publicKeyPem },
      host: { endpoint, tokenEnv: 'CALLBACK_TOKEN' } },
    fetchImpl: async () => {
      modelCalls++;
      const frame = { id: 'fixture', choices: [{ index: 0, delta: { content: 'One committed answer.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 3 } };
      return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const origin = await listen(service.server);
  const input = command({ session_id: 'delivery-session', payload: { content: 'Produce one answer.' } });
  const response = await fetch(origin + MANAGED_NATIVE_KERNEL_PATH + '/commands', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ command: input, permit: issuer.issue(input) }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 202);
  const receipt = await response.json();
  for (const deadline = Date.now() + 6000; attempts.length < 2 && Date.now() < deadline;) await delay(50);
  assert.equal(claims, 1);
  assert.equal(modelCalls, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  const delivered = JSON.parse(attempts[1]);
  assert.equal(delivered.runId, receipt.run_id);
  assert.equal(delivered.finalText, 'One committed answer.');
  assert.equal(delivered.phase, 'completed');
  const query = { contract: claim.deliveryContract, runId: claim.runId, sessionId: claim.sessionId,
    ref: claim.ref, configDigest: claim.configDigest, after: 0 };
  const frames = (input, supplied = token) => fetch(origin + MANAGED_NATIVE_KERNEL_PATH + '/session-frames', {
    method: 'POST', headers: { authorization: 'Bearer ' + supplied, 'content-type': 'application/json' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(5000),
  });
  assert.equal((await frames(query, 'wrong-token')).status, 401);
  assert.equal((await frames({ ...query, sessionId: 'different-session' })).status, 404);
  assert.equal((await frames({ ...query, ref: 'different-reference' })).status, 404);
  assert.equal((await frames({ ...query, after: -1 })).status, 400);
  const first = await frames(query);
  assert.equal(first.status, 200);
  const page = await first.json();
  assert.deepEqual(page.events, delivered.events);
  assert.equal(page.view, delivered.view);
  assert.equal(page.cursor, page.events.at(-1).seq);
  const after = page.events[0].seq;
  assert.deepEqual((await (await frames({ ...query, after })).json()).events, page.events.slice(1));
  assert.deepEqual((await (await frames({ ...query, after: page.cursor })).json()).events, []);
  const restore = configDigest => fetch(origin + MANAGED_NATIVE_KERNEL_PATH + '/session-restore', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ contract: query.contract, runId: query.runId, sessionId: query.sessionId, configDigest }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal((await restore('0'.repeat(64))).status, 404);
  assert.deepEqual(await (await restore(query.configDigest)).json(), {
    contract: query.contract, input: input.payload.content, ref: query.ref, hostCancel: true,
    source: { provider: 'agentkit-harness', model: 'fixture' },
  });
});

test('an authenticated Studio stop before the first model effect survives engine restart', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-managed-stop-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const issuer = permitIssuer(), token = 'fixture-service-control-bearer', callback = 'fixture-studio-stop-callback-bearer';
  const claim = Promise.withResolvers(), release = Promise.withResolvers();
  const completed = Promise.withResolvers();
  let service, modelCalls = 0;
  const host = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    assert.equal(request.headers.authorization, 'Bearer ' + callback);
    let body = { received: true };
    if (request.url.endsWith('/admit')) {
      body = { ref: 'fixture-stop-ref', hostInstructions: '', hostTools: [], sessionDelivery: true };
    } else if (request.url.endsWith('/claim')) {
      claim.resolve(input);
      await release.promise;
    } else {
      assert(request.url.endsWith('/finish'));
      completed.resolve(input);
    }
    if (!response.destroyed) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ contract: 'agentkit.managed-host-resources/v1', ...body }));
    }
  });
  t.after(async () => {
    release.resolve();
    await service?.close();
    await new Promise(resolve => host.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1',
    () => resolve('http://127.0.0.1:' + server.address().port)));
  const endpoint = await listen(host);
  const setup = {
    token, startup: { workspace, stateDir: join(root, 'ledger'), scope,
      model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_KEY' } },
    env: { FIXTURE_KEY: 'fixture-key', CALLBACK_TOKEN: callback },
    managed: { buildId: 'fixture-delivery-stop', controlPublicKeys: { server: issuer.publicKeyPem },
      host: { endpoint, tokenEnv: 'CALLBACK_TOKEN' } },
    fetchImpl: async () => { modelCalls++; throw Error('No model effect should dispatch'); },
  };
  let origin;
  async function start() { service = createEngineService(setup); origin = await listen(service.server); }
  await start();
  const post = (path, body, auth = token) => fetch(origin + MANAGED_NATIVE_KERNEL_PATH + '/' + path, {
    method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(6000),
  });
  const input = command({ session_id: 'session-stop', payload: { content: 'Do not start the model.' } });
  const admitted = await post('commands', { command: input, permit: issuer.issue(input) });
  assert.equal(admitted.status, 202);
  const receipt = await admitted.json();
  async function bounded(promise) {
    const timer = new AbortController();
    try { return await Promise.race([promise, delay(6000, undefined, { signal: timer.signal }).then(() => assert.fail('Timeout'))]); }
    finally { timer.abort(); }
  }
  const pending = await bounded(claim.promise);
  assert.equal(pending.hostCancel, true);
  const stop = { contract: pending.deliveryContract, sessionId: pending.sessionId, runId: pending.runId,
    configDigest: pending.configDigest, ref: pending.ref };
  assert.equal((await post('session-cancel', stop, callback)).status, 401);
  assert.equal((await post('session-cancel', { ...stop, sessionId: 'other-session' })).status, 404);
  assert.equal((await post('session-cancel', { ...stop, ref: 'forged-ref' })).status, 404);
  for (let attempt = 0; attempt < 2; attempt++)
    assert.equal((await (await post('session-cancel', stop)).json()).status, 'accepted');
  await service.close();
  service = null;
  release.resolve();
  await start();
  const terminal = await bounded(completed.promise);
  assert.equal(terminal.phase, 'canceled');
  assert.equal(terminal.runId, receipt.run_id);
  assert.equal(terminal.finalText, '');
  assert.equal(modelCalls, 0);
  assert.equal((await (await post('session-cancel', stop)).json()).status, 'terminal');
});
