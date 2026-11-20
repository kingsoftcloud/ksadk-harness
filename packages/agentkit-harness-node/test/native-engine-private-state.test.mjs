import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createEngineService } from '../src/native/engine-service.mjs';
import { privateDirectory } from '../src/native/local-command-state.mjs';

test('engine persists its task view and an approved workspace write across restart', { timeout: 120000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-state-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const token = 'fixture-engine-storage-token';
  const startup = { workspace, stateDir: join(root, 'state'), approval: 'deny',
    scope: { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' },
    model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_KEY' } };
  let requests = 0;
  const model = async (_url, { body }) => {
    const request = JSON.parse(body);
    if (++requests === 2) assert.ok(request.messages.some(message => message.role === 'tool'));
    const tool = requests === 1;
    const delta = tool ? { tool_calls: [{ index: 0, id: 'write', type: 'function', function: {
      name: 'write_workspace_file', arguments: JSON.stringify({ path: 'proof.txt', content: 'Written once.\n' }),
    } }] } : { content: 'Done.' };
    assert.equal(request.tools.some(entry => entry.function.name === 'run_command'), process.platform !== 'win32');
    const frame = { id: 'fixture', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  };
  let service, origin;
  let next = 0;
  t.after(async () => {
    await service?.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function start() {
    service = createEngineService({ startup, token, env: { FIXTURE_KEY: 'fixture' }, fetchImpl: model });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + service.server.address().port;
  }
  const call = async (method, params) => {
    const response = await fetch(origin + '/v1/sessions/storage/rpc', { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: String(++next), method, params }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.error, undefined, JSON.stringify(payload));
    return payload.result;
  };
  const initialize = () => call('initialize', { protocolVersions: ['agentkit.engine/v1'], services: { durableApprovals: true } });
  const run = { runId: 'storage-run' };
  async function until(matches) {
    const end = Date.now() + 40000;
    while (Date.now() < end) {
      const result = await call('run/status', run);
      if (matches(result)) return result;
      await sleep(50);
    }
    assert.fail('Run did not reach the expected state');
  }

  await start();
  const hello = await initialize();
  const view = hello.capabilities.ui;
  assert.match(view.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual((await call('run/start', { ...run, objective: 'Write the fixture.' })).view, view);
  const { pendingApproval } = await until(status => status.pendingApproval && !status.running);
  await call('run/approve', { ...run, interactionId: pendingApproval.interactionId, decision: 'allow' });
  assert.equal((await until(status => status.terminal)).phase, 'completed');
  await service.close();

  await start();
  await initialize();
  const restored = await call('run/status', run);
  assert.equal(restored.finalText, 'Done.');
  assert.deepEqual(restored.view, view);
  assert.equal(readFileSync(join(workspace, 'proof.txt'), 'utf8'), 'Written once.\n');
  assert.equal(requests, 2);
});

test('Windows private state rejects an ACL that grants Everyone readable state', { skip: process.platform !== 'win32' }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-acl-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  privateDirectory(root);
  execFileSync(join(process.env.SystemRoot, 'System32', 'icacls.exe'), [root, '/grant:r', '*S-1-1-0:(OI)(CI)(RX)']);
  assert.throws(() => privateDirectory(root), { code: 'background_state_not_private' });
});
