import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingInputStates } from '../src/host/pending-inputs.mjs';
import { buildViewModel } from '../src/view.mjs';
import { createSessionTaskProjector } from '../src/host/session-task-events.mjs';
const input = { requestId: 'original', placement: 'transcript', text: 'Continue this task.\nKeep the original files.' };
const event = { type: 'event', event: { seq: 1, type: 'user/message', time: 1,
  data: { turn: 1, source: { kind: 'user', rpcId: input.requestId }, content: [{ type: 'text', text: input.text }] } } };
const win = entries => ({ revision: 1, entries, change: { kind: 'replace', entries } });
function bubble(node) {
  if (node?.props?.className === 'harness-user-message') return node;
  return node?.children?.map(bubble).find(Boolean);
}
test('an optimistic input uses the same bubble as its committed message without invented activity', () => {
  const pending = pendingInputStates([input], win([]))[0].state;
  const committed = createSessionTaskProjector().project(win([event]))[0].state;
  const pendingBubble = bubble(buildViewModel(pending)), committedBubble = bubble(buildViewModel(committed));
  assert.equal(pending.taskState, 'idle');
  assert.equal(pendingBubble.props.className, committedBubble.props.className);
  assert.deepEqual(pendingBubble.children, committedBubble.children);
});
test('pending echoes are deduplicated by exact request receipt rather than content', () => {
  assert.equal(pendingInputStates([input, input], win([])).length, 1);
  assert.equal(pendingInputStates([input], win([event])).length, 0);
  assert.deepEqual(pendingInputStates([input, { ...input, requestId: 'another' }], win([event])).map(item => item.requestId), ['another']);
  assert.equal(pendingInputStates([{ ...input, placement: 'queued' }], win([])).length, 0);
});
