import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSkillTools } from '../src/native/skill-tools.mjs';

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
