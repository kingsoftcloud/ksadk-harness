import test from 'node:test';
import assert from 'node:assert/strict';
import { publicToolExecution, publicToolResult } from '../src/native/public-tool-result.mjs';
import { createNativeSkillDisclosurePort } from '../src/native/skill-disclosure.mjs';
import { createNativeWebTools } from '../src/native/web-tools.mjs';
import { createNativeA2aToolPort } from '../src/native/a2a-tools.mjs';
import { createLocalCommandTransport } from '../src/native/local-command-tools.mjs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scope = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const diagnostic = () => ({ message: 'Authorization: Bearer fixtureDisclosureSecret', error: { password: 'fixtureBareSecret' },
  details: { headers: { Authorization: 'fixtureHeaderSecret' } } });
function request(port, name, args = {}) {
  return { scope, sessionId: 'session', runId: 'run', turnId: 'turn', buildId: 'build', parentRunId: null,
    taskChainId: 'chain', operationKey: 'original-operation', executionFence: 1, signal: new AbortController().signal,
    definition: structuredClone(port.definitions.find(item => item.name === name)), call: { name, callId: 'call', arguments: args } };
}
function disclosure(authorize) {
  return createNativeSkillDisclosurePort({ scope, sessionId: 'session', skillRefs: [], authorize, assertCurrent: () => true,
    store: { load() { throw Object.assign(new Error('not found'), { code: 'run_not_found' }); } },
    source: { manifest: async () => ({}), fullText: async () => '', resource: async () => Buffer.alloc(0) } });
}
for (const name of ['skill_catalog', 'skill_read_manifest', 'skill_read_instructions', 'skill_read_resource'])
for (const state of ['approval_required', 'denied', 'thrown', 'null']) test(`public Skill Disclosure ${name} ${state} boundary`, async () => {
  const port = disclosure(async () => {
    if (state === 'thrown') throw Object.assign(new Error(diagnostic().message), { code: 'Bearer fixtureDisclosureSecret' });
    return state === 'null' ? null : { status: state, interactionId: 'interaction', code: 'DENIED', ...diagnostic() };
  });
  const args = name === 'skill_catalog' ? {} : name === 'skill_read_resource' ? { skill_id: 'skill', resource_ref: 'resource.txt' } : { skill_id: 'skill' };
  const result = await port.execute(request(port, name, args));
  assert.doesNotMatch(JSON.stringify(result), /fixtureDisclosureSecret|fixtureBareSecret|fixtureHeaderSecret/);
  assert.equal(result.status, state === 'approval_required' ? state : 'error');
  if (state === 'approval_required') assert.equal(result.interactionId, 'interaction');
  port.close();
});
test('Disclosure refuses malformed approvals instead of publishing an unusable interaction', async () => {
  for (const interactionId of ['', null, {}, 1]) {
    const port = disclosure(() => ({ status: 'approval_required', interactionId, ...diagnostic() }));
    const result = await port.execute(request(port, 'skill_catalog'));
    assert.equal(result.status, 'error'); assert.equal(result.content.executed, false); port.close();
  }
});
for (const family of ['web', 'a2a', 'local']) test(`${family} approval diagnostics use the shared public boundary`, async t => {
  let effects = 0;
  const authorize = async () => ({ status: 'approval_required', interactionId: 'interaction', ...diagnostic() });
  let port, name, args;
  if (family === 'web') {
    port = createNativeWebTools({ sessionId: 'session', authorize, fetch: async () => { effects++; throw Error('must not fetch'); } });
    name = 'web_fetch'; args = { url: 'https://example.invalid/' };
  } else if (family === 'a2a') {
    port = createNativeA2aToolPort({ scope, sessionId: 'session', discovery: { list: async () => { effects++; return []; } },
      invocation: {}, exposurePlan: {}, authorize, assertCurrent: () => true,
      bindingDescription: { sourceRef: 'source', sourceDigest: 'digest', planDigest: 'plan', transport: 'test', version: 'v1' } });
    name = port.definitions[0].name; args = {};
  } else {
    const root = mkdtempSync(join(tmpdir(), 'public-local-diagnostic-')); t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'workspace'));
    port = createLocalCommandTransport({ workspaceRoot: join(root, 'workspace'), stateRoot: join(root, 'state'), sessionId: 'session', authorize,
      resolveOwnedCommand: () => { effects++; }, captureWorkspace: () => { effects++; } });
    name = 'sandbox_status'; args = {};
  }
  const result = await port.execute(request(port, name, args));
  assert.equal(result.status, 'approval_required'); assert.equal(result.interactionId, 'interaction');
  assert.equal(result.content, null);
  assert.doesNotMatch(JSON.stringify(result), /fixtureDisclosureSecret|fixtureBareSecret|fixtureHeaderSecret/);
  assert.equal(effects, 0);
});
test('shared projection retains success bytes, uncertain evidence, sync timing and cancellation errors', async () => {
  const success = { status: 'ok', content: { password: 'user-file-content', message: 'Authorization: Bearer user-file-content' } };
  assert.equal(publicToolResult(success), success);
  const uncertain = { status: 'uncertain', interactionId: 'interaction', content: { ...diagnostic(), operationKey: 'operation',
    executed: true, error_code: '', skill_events: [{ error_code: '', event_id: 'event' }] } };
  const projected = publicToolResult(uncertain);
  assert.equal(projected.status, 'uncertain'); assert.equal(projected.content.executed, true);
  assert.equal(projected.content.operationKey, 'operation'); assert.deepEqual(projected.content.skill_events, uncertain.content.skill_events);
  const object = { marker: 1, execute: publicToolExecution(function (value) { assert.equal(this.marker, 1); return value; }) };
  assert.equal(object.execute(success), success); assert.equal(await publicToolExecution(async () => success)(), success);
  const abort = new DOMException('cancelled', 'AbortError');
  assert.throws(() => publicToolExecution(() => { throw abort; })(), error => error === abort);
  await assert.rejects(publicToolExecution(async () => { throw abort; })(), error => error === abort);
});

test('failed text, text blocks and nested SDK envelopes use the diagnostic boundary', () => {
  const secret = 'Authorization: Bearer fixtureTextSecret';
  for (const content of [secret, [{ type: 'text', text: secret }], { text: secret },
    { content: [{ type: 'text', text: secret }], isError: true }]) {
    const result = publicToolResult({ status: 'error', content });
    assert.doesNotMatch(JSON.stringify(result), /fixtureTextSecret/);
  }
});
