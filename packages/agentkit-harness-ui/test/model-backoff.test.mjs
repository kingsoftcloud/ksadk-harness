import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduceAll } from '../src/reducer.mjs';
import { engineEventsToTimeline } from '../src/engine-view/adapter.mjs';
import { buildViewModel } from '../src/view.mjs';
const frame = (seq, kind, extra = {}) => ({ schema: 'agentkit.engine-event/v1', seq, kind, ...extra });
const strings = node => typeof node === 'string' ? node : (node?.children ?? []).map(strings).join(' ');
test('provider backoff is announced as a wait and becomes retrying only on the next actual request', () => {
  let state = reduceAll(initialState(), engineEventsToTimeline([
    frame(1, 'run.started'), frame(2, 'effect.prepared', { category: 'model', title: 'request' }),
    frame(3, 'effect.settled', { category: 'model', title: 'request' }),
    frame(4, 'model.retry_scheduled', { retryAt: 10000, httpStatus: 429 }),
  ]));
  let text = strings(buildViewModel(state, { locale: 'zh-CN' }));
  assert.match(text, /网关限流，等待重试/);
  assert.doesNotMatch(text, /正在重试/);
  assert.equal(state.modelRequestActive, false);
  state = reduceAll(state, engineEventsToTimeline([
    frame(5, 'effect.prepared', { category: 'model', title: 'request', retry: true }),
  ]));
  text = strings(buildViewModel(state, { locale: 'zh-CN' }));
  assert.match(text, /正在重试/);
  assert.doesNotMatch(text, /等待重试/);
  assert.equal(state.modelWait, null);
  state = reduceAll(state, engineEventsToTimeline([frame(6, 'run.terminal', { title: 'completed', status: 'unverified', detail: 'Done' })]));
  assert.equal(state.modelWait, null);
  assert.equal(state.modelRequestActive, false);
});
