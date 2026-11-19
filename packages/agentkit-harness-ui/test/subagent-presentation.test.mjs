import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialState, reduceAll } from '../src/reducer.mjs';
import { createHarnessComponents } from '../src/react-binding.mjs';
const { HarnessTimeline, SubagentPane } = createHarnessComponents(React);
const call = { type: 'tool.scheduled', callId: 'parent-call', name: 'native_start_child', input: { role: 'reader', task: 'Read the source' } };
const child = { type: 'subagent.bound', callId: 'parent-call', child: { runId: 'child', sessionId: 'child-session', parentRunId: 'parent', role: 'reader', title: 'Read the source', phase: 'requesting_model' } };
const state = events => reduceAll(initialState(), events.map((e, i) => ({ v: 1, id: String(i), ...e })));
test('a child tool is one row and opens its authenticated child session without a detail button', () => {
  const value = state([{ type: 'task.started', taskId: 'parent' }, child, call]);
  const html = renderToStaticMarkup(React.createElement(HarnessTimeline, { state: value, onOpenSubagent() {}, styleSheet: null }));
  assert.match(html, /data-action="open-subagent"/); assert.match(html, /reader/); assert.match(html, /Read the source/);
  assert.match(html, /class="harness-agent-name" data-role-color="[a-z]+">reader<\/span>/);
  assert.doesNotMatch(html, /<summary|查看详情|Inspect|harness-tool-status-scheduled/);
  assert.equal(value.items[0].child.runId, 'child');
  const unbound = state([call]);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(HarnessTimeline, { state: unbound, onOpenSubagent() {}, styleSheet: null })), /data-action="open-subagent"/);
});
test('parent completion is not reopened by a child still running in the background', () => {
  const value = state([call, { type: 'tool.result', callId: 'parent-call', result: 'started' }, child]);
  assert.equal(value.items[0].status, 'completed');
  const html = renderToStaticMarkup(React.createElement(HarnessTimeline, { state: value, styleSheet: null }));
  assert.doesNotMatch(html, /harness-tool-title-streaming|data-status="running"/);
});
test('different roles get distinct non-error colors and repeat calls keep the role color', () => {
  const roles = ['extract', 'structure', 'summarize', 'extract'];
  const value = state(roles.map((role, index) => ({ ...call, callId: `child-${index}`, input: { role } })));
  const html = renderToStaticMarkup(React.createElement(HarnessTimeline, { state: value, styleSheet: null }));
  const colors = [...html.matchAll(/data-role-color="([a-z]+)"/g)].map(match => match[1]);
  assert.equal(colors.length, roles.length);
  assert.equal(new Set(colors.slice(0, 3)).size, 3);
  assert.equal(colors[0], colors[3]);
  assert.ok(colors.every(color => !['red', 'pink'].includes(color)));
  const isolated = role => renderToStaticMarkup(React.createElement(HarnessTimeline, {
    state: state([{ ...call, input: { role } }]), styleSheet: null,
  })).match(/data-role-color="([a-z]+)"/)?.[1];
  assert.notEqual(isolated('extract'), isolated('structure'));
});
test('a failed delegation keeps diagnostics in its disclosure while a completed child keeps its outcome off the card', () => {
  const first = { ...call, callId: 'first-call', name: 'native_delegate' };
  const error = 'studio_native_child_parent_output_invalid';
  const value = state([first, { type: 'tool.error', callId: first.callId, error },
    call, { type: 'tool.result', callId: call.callId, result: 'Extraction result' },
    { ...child, child: { ...child.child, phase: 'completed', outcome: 'unverified' } }]);
  const options = { state: value, onOpenSubagent() {}, styleSheet: null,
    labels: { toolFailed: '执行失败' } };
  const collapsed = renderToStaticMarkup(React.createElement(HarnessTimeline, options));
  assert.match(collapsed, /<summary[^>]*>.*执行失败.*<\/summary>/);
  assert.doesNotMatch(collapsed, new RegExp(error));
  assert.doesNotMatch(collapsed, /data-status="unverified"|已完成，未验证|已完成，已验证/);
  assert.match(collapsed, /data-action="open-subagent" data-call-id="parent-call"/);
  const opened = renderToStaticMarkup(React.createElement(HarnessTimeline, { ...options, initiallyExpandedTools: [first.callId] }));
  assert.match(opened, new RegExp(`</summary><div[^>]*data-testid="tool-error">${error}</div>`));
});
test('only a completed, matching delegation folds the earlier rejection into retry history', () => {
  const retry = { ...call, name: 'native_delegate', input: { ...call.input, background: false } };
  const first = { ...retry, callId: 'first-call', input: { ...retry.input, output_contract: 'parent', output_format: 'text' } };
  const error = 'Error: studio_native_child_parent_output_invalid';
  const failed = { type: 'tool.error', callId: first.callId, error };
  const result = { type: 'tool.result', callId: retry.callId, result: 'Extraction result' };
  const terminal = { ...child, child: { ...child.child, phase: 'completed', outcome: 'unverified' } };
  const render = (events, initiallyExpandedTools = []) => renderToStaticMarkup(React.createElement(HarnessTimeline, {
    state: state(events), styleSheet: null, initiallyExpandedTools,
    labels: { toolFailed: '执行失败', toolRetryHistory: '重试记录' },
  }));
  const recovered = [first, failed, retry, result, terminal];
  assert.match(render(recovered), /重试记录/);
  assert.doesNotMatch(render(recovered), /执行失败|studio_native_child_parent_output_invalid|已完成，未验证|已完成，已验证/);
  assert.ok(render(recovered, [first.callId]).includes(error));
  assert.match(render([first, failed, retry, result, child]), /执行失败/);
  assert.match(render([first, failed, { ...retry, input: { ...retry.input, task: 'Read another file' } }, result, terminal]), /执行失败/);
  assert.match(render([first, failed, { type: 'text.done', role: 'user', itemId: 'next-turn', text: 'Read the source' },
    retry, result, terminal]), /执行失败/);
});
test('the independent child pane shows results without a completion or verification label', () => {
  for (const outcome of ['completed', 'unverified']) {
    const value = state([{ type: 'task.started', taskId: 'child' },
      { type: 'text.done', itemId: 'answer', text: 'Observed child answer' },
      { type: 'task.finished', outcome, finalAnswerId: 'answer', verificationRequired: true }]);
    const html = renderToStaticMarkup(React.createElement(SubagentPane, { state: value, styleSheet: null,
      labels: { completed: '已完成，已验证', unverified: '已完成，未验证' } }));
    assert.match(html, /aria-readonly="true"/);
    assert.match(html, /Observed child answer/);
    assert.doesNotMatch(html, /已完成，已验证|已完成，未验证|status-line|contenteditable|<textarea|type="submit"/);
  }
});
