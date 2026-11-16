import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSessionTaskProjector } from '../src/host/session-task-events.mjs';
import { pendingInputStates } from '../src/host/pending-inputs.mjs';
import { buildViewModel } from '../src/view.mjs';
import { createHarnessComponents } from '../src/react-binding.mjs';
import { findAllByTestId } from './helpers.mjs';

const attachment = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 100, width: 40, height: 20, name: 'screen.png' };
const entry = (seq, type, data) => ({ event: { type, seq, time: seq * 1000, data: { turn: 1, ...data } } });
const rows = [entry(1, 'turn/start', {}), entry(2, 'user/message', { source: { kind: 'user-rpc', rpcId: 'request' },
  content: [{ type: 'image', attachment }, { type: 'text', text: '' }] })];

test('an image-only user message survives durable replay and retains its scoped reference without accepting a supplied URL', () => {
  const snapshot = { revision: 1, entries: rows };
  const [task] = createSessionTaskProjector().project(snapshot);
  assert.deepEqual(task.state.items[0].images, [{ attachment }]);
  assert.equal(findAllByTestId(buildViewModel(task.state), 'user-image').length, 1);
  assert.deepEqual(createSessionTaskProjector().project(snapshot)[0], task);
  const bad = structuredClone(rows); bad[1].event.data.content[0].attachment = { ...attachment, attachmentId: 'https://evil/image', url: 'https://evil/image' };
  assert.equal(findAllByTestId(buildViewModel(createSessionTaskProjector().project({ revision: 1, entries: bad })[0].state), 'user-image').length, 0);
});

test('pending preview is replaced only by its committed request; the replay uses the host image loader', () => {
  const inputs = [{ requestId: 'request', placement: 'transcript', text: '', attachments: [{ type: 'image', value: { previewUrl: 'blob:local-image', name: 'screen.png' } }] }];
  const [pending] = pendingInputStates(inputs, { entries: [] });
  const { HarnessTimeline } = createHarnessComponents(React);
  assert.match(renderToStaticMarkup(React.createElement(HarnessTimeline, { state: pending.state, styleSheet: null })), /src="blob:local-image"/);
  assert.deepEqual(pendingInputStates(inputs, { entries: rows }), []);
  const [task] = createSessionTaskProjector().project({ revision: 1, entries: rows });
  const loader = Object.assign(() => Promise.resolve('blob:restored-image'), { peek: () => 'blob:restored-image' });
  const html = renderToStaticMarkup(React.createElement(HarnessTimeline, { state: task.state, loadImage: loader, styleSheet: null }));
  assert.match(html, /src="blob:restored-image"/); assert.match(html, /查看图片：screen.png/);
  assert.doesNotMatch(html, /attachmentId|blob:local-image/);
});
