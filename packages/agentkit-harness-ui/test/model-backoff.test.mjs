import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduceAll } from '../src/reducer.mjs';
import { engineEventsToTimeline } from '../src/engine-view/adapter.mjs';
import { buildViewModel } from '../src/view.mjs';
const frame = (seq, kind, extra = {}) => ({ schema: 'agentkit.engine-event/v1', seq, kind, ...extra });
const strings = node => typeof node === 'string' ? node : (node?.children ?? []).map(strings).join(' ');
for (const purpose of [undefined, 'compaction']) test(`${purpose ?? 'tool-following model request'} displays a live backoff and then a started retry`, () => {
  let state = reduceAll(initialState(), engineEventsToTimeline([
    frame(1, 'run.started'), frame(2, 'tool.completed', { callId: 'read-source', status: 'ok', title: 'read' }),
    frame(3, 'effect.prepared', { category: 'model', title: 'request', purpose }),
    frame(4, 'effect.settled', { category: 'model', title: 'request' }),
    frame(5, 'model.retry_scheduled', { retryAt: 10000, httpStatus: 429, attempt: 1, purpose }),
  ]));
  const waiting = buildViewModel(state, { locale: 'zh-CN' });
  let text = strings(waiting);
  assert.match(text, /网关限流，等待重试/);
  assert.match(text, /第 1 次重试/);
  assert.equal(text.includes('上下文压缩'), purpose === 'compaction');
  assert.match(JSON.stringify(waiting), /harness-retry-caret/);
  assert.match(JSON.stringify(waiting), /model-retry-countdown/);
  assert.equal(state.modelWait.retryAt, 10000);
  assert.ok(state.items.some(item => item.callId === 'read-source'));
  assert.doesNotMatch(text, /正在重试/);
  assert.equal(state.modelRequestActive, false);
  state = reduceAll(state, engineEventsToTimeline([
    frame(6, 'effect.prepared', { category: 'model', title: 'request', retry: true, purpose }),
  ]));
  const retrying = buildViewModel(state, { locale: 'zh-CN' });
  text = strings(retrying);
  assert.match(text, /正在重试/);
  assert.match(text, /第 1 次重试/);
  assert.doesNotMatch(text, /等待重试/);
  assert.match(JSON.stringify(retrying), /harness-retry-caret/);
  assert.doesNotMatch(JSON.stringify(retrying), /model-retry-countdown/);
  assert.equal(state.modelWait, null);
  state = reduceAll(state, engineEventsToTimeline([frame(7, 'run.terminal', { title: 'completed', status: 'unverified', detail: 'Done' })]));
  assert.equal(state.modelWait, null);
  assert.equal(state.modelRequestActive, false);
});
