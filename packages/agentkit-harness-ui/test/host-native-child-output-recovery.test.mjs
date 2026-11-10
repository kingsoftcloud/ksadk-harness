import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeChildrenState } from '../src/host/state/native-children.mjs';

const task = { childRunId: 'child', sessionId: 'child-session', parentRunId: 'parent', role: 'worker',
  phase: 'paused', reason: 'output_budget_exhausted', canResume: true, resultAvailable: false, goalPreview: 'Original task',
  usage: { modelCalls: 2, toolCalls: 1 } };
const page = tasks => ({ contract: 'agentkit.studio-native-child-history/v1', sessionId: 'session', runId: 'parent',
  tasks, inventoryDigest: 'a'.repeat(64), offset: 0, nextOffset: tasks.length, totalTasks: tasks.length, complete: true });

test('child resume uses one original control after a lost reply and never resumes through polling', async t => {
  const requests = []; let lost = true, current = page([task]);
  const state = createNativeChildrenState({ agentId: 'agent', sessionId: 'session', commandId: () => 'one-resume', hostRemote: {
    nativeChildHistory: async () => current,
    resumeNativeChild: async request => { requests.push(structuredClone(request)); if (lost) { lost = false; throw Error('lost reply'); }
      return { commandId: request.commandId, status: 'duplicate' }; },
  } }); t.after(() => state.dispose());
  await state.refresh(); assert.equal(requests.length, 0);
  await state.resume(task); assert.equal(requests.length, 1); assert.equal(state.getSnapshot().pendingAction, 'resume');
  current = page([{ ...task, canResume: false, phase: 'completed' }]);
  await state.refresh(); assert.equal(requests.length, 1);
  await state.retryControl(); assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[0].runId, 'parent'); assert.equal(requests[0].childRunId, 'child');
  assert.equal(state.getSnapshot().pending, null);
  await state.resume(current.tasks[0]); assert.equal(requests.length, 2);
});

test('a historical child or malformed resume capability cannot become an active recovery control', async t => {
  let current = page([task]), calls = 0;
  const state = createNativeChildrenState({ agentId: 'agent', sessionId: 'session', hostRemote: {
    nativeChildHistory: async () => current, resumeNativeChild: async () => { calls++; },
  } }); t.after(() => state.dispose());
  await state.refresh(); const accepted = state.getSnapshot().page;
  for (const change of [{ parentRunId: 'old-parent' }, { phase: 'executing_tools' }, { reason: 'effect_outcome_unknown' }, { canResume: 'true' }]) {
    current = page([{ ...task, ...change }]); await state.refresh();
    assert.equal(state.getSnapshot().page, accepted); assert.ok(state.getSnapshot().error);
  }
  await state.resume({ ...task, parentRunId: 'old-parent' });
  await state.resume({ ...task, canResume: false }); assert.equal(calls, 0);
});
