import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialState, reduce } from '../src/reducer.mjs';
import { visibleItems } from '../src/project.mjs';
import { buildViewModel } from '../src/view.mjs';
import { createHarnessComponents } from '../src/react-binding.mjs';
import { createSessionTaskProjector } from '../src/host/session-task-events.mjs';
import { createTimelineEventFeed } from '../src/host/state/timeline-event-feed.mjs';

const { HarnessTimeline } = createHarnessComponents(React);
const stateOf = events => events.reduce((state, event, i) => reduce(state, { v: 1, id: String(i), ...event }), initialState());
const render = (state, props = {}) => renderToStaticMarkup(React.createElement(HarnessTimeline, { state, locale: 'zh-CN', styleSheet: null, ...props }));
const descendants = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(descendants)] : [];

test('whitespace-only model content cannot create a blank flex row, but remains available to subsequent deltas', () => {
  const state = stateOf([{ type: 'task.started', taskId: 't' },
    { type: 'text.delta', itemId: 'text', delta: '\n ' }]);
  assert.equal(visibleItems(state).length, 0);
  assert.doesNotMatch(render(state), /data-testid="text-block"/);
  const next = reduce(state, { v: 1, id: 'next', type: 'text.delta', itemId: 'text', delta: '继续创建游戏' });
  assert.equal(visibleItems(next)[0].text, '\n 继续创建游戏');
  assert.match(render(next), /继续创建游戏/);
});

test('a write draft without a parsed path keeps its write identity and has no execution authority', () => {
  const state = stateOf([{ type: 'tool.preview', previewId: 'draft', name: 'write_workspace_file', input: {}, receivedChars: 12 }]);
  const html = render(state, { labels: { writePending: '请求写入' } });
  assert.match(html, /请求写入/);
  assert.doesNotMatch(html, /修改中|data-action="open-file"/);
});

test('collapsed file changes keep their summary without mounting hidden unified and split diff trees', () => {
  const state = stateOf([{ type: 'tool.scheduled', callId: 'edit', name: 'write_workspace_file', input: { path: 'game.js' } },
    { type: 'tool.result', callId: 'edit', result: 'saved', display: { kind: 'file_edit', files: [{ path: 'game.js',
      operationKind: 'write', changeStat: { added: 401, removed: 0 }, patch: '@@ -0,0 +1,401 @@\n' + '+const value = 1;\n'.repeat(401) }] } }]);
  const collapsed = render(state);
  assert.match(collapsed, /game\.js/); assert.match(collapsed, /\+401/);
  assert.doesNotMatch(collapsed, /data-testid="edit-diff"|const value/);
  const expanded = render(state, { initiallyExpandedTools: ['edit'] });
  assert.match(expanded, /data-testid="edit-diff"/); assert.match(expanded, /const value/);
});

test('streaming text reuses the completed tool view; changing disclosure rebuilds it', () => {
  const state = stateOf([{ type: 'tool.scheduled', callId: 'edit', name: 'write_workspace_file', input: { path: 'game.js' } },
    { type: 'tool.result', callId: 'edit', result: 'saved', display: { kind: 'file_edit', files: [{ path: 'game.js', patch: '@@ -1 +1 @@\n-a\n+b\n' }] } },
    { type: 'text.delta', itemId: 'live', delta: '检查' }]);
  const cache = new WeakMap();
  const toolOf = tree => descendants(tree).find(node => node.props?.['data-testid'] === 'tool-block');
  const first = toolOf(buildViewModel(state, { toolViewCache: cache }));
  const next = reduce(state, { v: 1, id: 'next', type: 'text.delta', itemId: 'live', delta: '结果' });
  assert.equal(toolOf(buildViewModel(next, { toolViewCache: cache })), first);
  const opened = toolOf(buildViewModel(next, { toolViewCache: new WeakMap(), toolOpen: new Map([['edit', true]]) }));
  assert.notEqual(opened, first);
  assert.ok(descendants(opened).some(node => node.props?.['data-testid'] === 'edit-diff'));
});

test('transient publications coalesce without losing revisions; durable settlement and reconnect bypass pending paint', () => {
  let snapshot = { revision: 0, entries: [], change: { kind: 'replace', entries: [] } }, sourceListener;
  const scheduled = new Map(); let id = 0, notifications = 0;
  const feed = createTimelineEventFeed({ getSnapshot: () => snapshot, subscribe: fn => { sourceListener = fn; return () => { sourceListener = null; }; } },
    { schedule: fn => { scheduled.set(++id, fn); return id; }, cancel: key => scheduled.delete(key) });
  const stop = feed.subscribe(() => notifications++);
  for (let revision = 1; revision <= 100; revision++) {
    const entry = { event: { type: 'assistant/live-chunk', seq: revision } };
    snapshot = { revision, entries: [...snapshot.entries, entry], change: { kind: 'append', entries: [entry] } }; sourceListener();
  }
  assert.equal(notifications, 0); assert.equal(scheduled.size, 1);
  const frame = [...scheduled.values()][0]; scheduled.clear(); frame();
  assert.equal(notifications, 1); assert.equal(feed.getSnapshot().entries.length, 100);
  snapshot = { ...snapshot, revision: 101, change: { kind: 'append', entries: [{ event: { type: 'assistant/live-chunk' } }] } }; sourceListener();
  const stale = [...scheduled.values()][0];
  snapshot = { revision: 102, entries: [], change: { kind: 'settle-assistant' } }; sourceListener();
  assert.equal(notifications, 2); assert.equal(scheduled.size, 0); stale(); assert.equal(notifications, 2);
  snapshot = { revision: 103, entries: [], change: { kind: 'replace', entries: [] } }; sourceListener();
  assert.equal(notifications, 3); stop(); assert.equal(sourceListener, null);
});

test('coalesced real Session chunks and settlement project exactly like an unthrottled replay', () => {
  const entry = (seq, type, data) => ({ type: 'event', event: { seq, type, time: seq, data: { turn: 1, step: 1, ...data } } });
  let snapshot = { revision: 0, entries: [entry(0, 'turn/start', {})], change: { kind: 'replace', entries: [] } }, listener, frame;
  const feed = createTimelineEventFeed({ getSnapshot: () => snapshot, subscribe: next => { listener = next; return () => {}; } },
    { schedule: next => { frame = next; return 1; }, cancel: () => { frame = null; } });
  const projector = createSessionTaskProjector({ sessionId: 'same-session' });
  let rendered = projector.project(feed.getSnapshot());
  const stop = feed.subscribe(() => { rendered = projector.project(feed.getSnapshot()); });
  for (let seq = 1; seq <= 40; seq++) {
    const chunk = entry(seq, 'assistant/live-chunk', { chunk: { type: 'text-delta', index: 0, text: '字' } });
    snapshot = { revision: seq, entries: [...snapshot.entries, chunk], change: { kind: 'append', entries: [chunk] } }; listener();
  }
  frame();
  assert.equal(rendered[0].state.items.find(item => item.kind === 'text').text, '字'.repeat(40));
  const settled = entry(41, 'assistant/message', { message: { id: 'settled', content: [{ type: 'text', text: '字'.repeat(40) }] } });
  snapshot = { revision: 41, entries: [...snapshot.entries, settled], change: { kind: 'append', entries: [settled] } }; listener();
  assert.deepEqual(rendered, createSessionTaskProjector({ sessionId: 'same-session' }).project(snapshot));
  assert.equal(rendered[0].state.items.filter(item => item.kind === 'text').length, 1); stop();
});
