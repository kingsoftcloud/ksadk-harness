import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSkillTools } from '../src/native/skill-tools.mjs';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scope = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const failure = () => Object.assign(new Error('upstream rejected Authorization: Bearer fixtureBearerValue; '
  + 'https://' + 'reader:' + 'fixturePassword@example.invalid/?access_token=fixtureQueryValue'), { code: 'NATIVE_SKILL_ERROR' });

for (const stage of ['authorization', 'service', 'workflow']) test(`Skill ${stage} diagnostics exclude credentials without changing effect evidence`, async () => {
  const tools = createNativeSkillTools({ authorize: async () => { if (stage === 'authorization') throw failure(); return 'allow'; },
    skillSpaceIds: ['space'], serviceClient: { listSkillsBySpaceId: async () => { throw failure(); } }, executeWorkflow: async () => { throw failure(); } });
  const name = stage === 'workflow' ? 'execute_skills' : stage === 'service' ? 'list_skills' : 'list_skill_spaces';
  const port = tools.forAgent({ session: { id: 'session' } }, { scope, sessionId: 'session', assertCurrent: () => true }).tools;
  const result = await port.execute({ call: { callId: 'call', name, arguments: stage === 'workflow' ? { workflow_prompt: 'run' } : {} },
    definition: structuredClone(tools.definitions.find(def => def.name === name)), signal: new AbortController().signal,
    scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain',
    operationKey: 'original-operation', executionFence: 1,
    budget: { maxToolCallsRemaining: 10, parentFinalizationReserved: true, depth: 0, maxDepth: 3 }, interaction: null });
  assert.doesNotMatch(JSON.stringify(result), /fixtureBearerValue|fixturePassword|fixtureQueryValue/);
  assert.equal(result.status, stage === 'workflow' ? 'uncertain' : 'error');
  if (stage === 'workflow') { assert.equal(result.content.operationKey, 'original-operation'); assert.equal(result.content.executed, undefined); }
  else assert.equal(result.content.executed, false);
});

function workspaceFixture(authorize = async () => 'allow') {
  const base = mkdtempSync(join(tmpdir(), 'workspace-diagnostic-'));
  const root = join(base, 'workspace'); mkdirSync(root);
  const tools = createNativeWorkspaceTools({ workspaceRoot: root, stateDir: join(base, 'state'), sessionId: 'session', authorize });
  return { root, close: () => rmSync(base, { recursive: true, force: true }),
    call: (name, args = {}, options) => tools.execute({ sessionId: 'session', operationKey: 'original-operation',
      signal: new AbortController().signal, call: { callId: 'call', name, arguments: args },
      definition: tools.definitions.find(def => def.name === name) }, options) };
}

for (const stage of ['authorization', 'authorization-result', 'execution']) test(`Workspace ${stage} diagnostics exclude credentials before returning to the Host`, async () => {
  const fixture = workspaceFixture(async () => {
    if (stage === 'authorization') throw failure();
    return stage === 'authorization-result' ? failure().message : 'allow';
  });
  try {
    const result = await fixture.call('write_workspace_file', { path: 'a.txt', content: 'data' },
      stage === 'execution' ? { assertCurrent: () => { throw failure(); } } : undefined);
    assert.equal(result.status, 'error');
    assert.doesNotMatch(JSON.stringify(result), /fixtureBearerValue|fixturePassword|fixtureQueryValue/);
    assert.equal(result.content.code ?? result.content.error_type,
      stage === 'authorization' ? 'authorize_failed' : stage === 'authorization-result' ? 'authorize_unexpected' : 'NATIVE_SKILL_ERROR');
    assert.equal(existsSync(join(fixture.root, 'a.txt')), false);
  } finally { fixture.close(); }
});

test('Workspace parser failure diagnostics are sanitized while successful file content stays exact', async () => {
  const fixture = workspaceFixture();
  try {
    const text = 'Authorization: Bearer fixtureBearerValue; password=fixturePassword';
    writeFileSync(join(fixture.root, 'a.json'), text);
    const lint = await fixture.call('lint_workspace_file', { path: 'a.json' });
    assert.equal(lint.status, 'error');
    assert.doesNotMatch(JSON.stringify(lint), /fixtureBearerValue|fixturePassword/);
    const read = await fixture.call('read_workspace_file', { path: 'a.json' });
    assert.equal(read.status, 'ok');
    assert.ok(JSON.stringify(read.content).includes('fixtureBearerValue'));
    assert.equal(readFileSync(join(fixture.root, 'a.json'), 'utf8'), text);
  } finally { fixture.close(); }
});
