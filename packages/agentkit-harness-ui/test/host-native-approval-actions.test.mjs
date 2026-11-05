import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeApprovalActions } from '../src/host/native-approval-actions.mjs';

const offer = () => ({ contract: 'agentkit.native-session-tool-approval/v1', offerId: 'offer', requestId: 'pending-approval',
  agentId: 'agent', sessionId: 'session', runId: 'original-run', toolName: 'run_command', targetSessionId: 'session' });
function mount(grant) {
  const values = [], refs = [], cleanups = []; let index = 0, ref = 0;
  const answered = [], sent = [];
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => { const i = index++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = value; }]; },
    useRef: initial => refs[ref++] ?? (refs[ref - 1] = { current: initial }),
    useEffect: callback => { if (!cleanups.length) cleanups.push(callback()); } };
  const pending = { toolName: 'run_command', sessionId: 'session', sessionGrant: offer(), answerable: true,
    answer: async value => { answered.push(value); pending.answerable = false; } };
  const Component = createNativeApprovalActions({ React, hostRemote: { grantNativeSessionTool: async request => {
    sent.push(structuredClone(request)); return grant(request, sent.length);
  } } });
  return { pending, answered, sent, render() { index = 0; ref = 0; return Component({ pending }); },
    dispose() { cleanups.forEach(cleanup => cleanup?.()); } };
}

test('a Session button awaits the exact Host grant receipt before approving only the pending current call', async () => {
  let finish;
  const f = mount(() => new Promise(resolve => { finish = resolve; }));
  const button = f.render().children[0]; assert.equal(button.children[0], '本会话允许此工具');
  const first = button.props.onClick(), second = button.props.onClick(); await second;
  assert.equal(f.sent.length, 1); assert.deepEqual(f.answered, []);
  assert.equal(f.render().children[0].props.disabled, true);
  finish({ status: 'accepted', offerId: 'offer', requestId: 'pending-approval' }); await first;
  assert.deepEqual(f.answered, ['allowed-once']);
  assert.deepEqual(f.sent[0], { agentId: 'agent', sessionId: 'session', runId: 'original-run', offerId: 'offer', requestId: 'pending-approval' });
  assert.match(button.props.title, /Host 和沙箱限制仍然有效/); f.dispose();
});

test('a lost grant reply retries its original offer and never turns an unconfirmed mutation into approval', async () => {
  const f = mount((_request, count) => { if (count === 1) throw Error('reply lost');
    return { status: 'duplicate', offerId: 'offer', requestId: 'pending-approval' }; });
  await f.render().children[0].props.onClick(); assert.deepEqual(f.answered, []);
  assert.equal(f.render().children[1].props.role, 'alert');
  await f.render().children[0].props.onClick(); assert.deepEqual(f.sent[0], f.sent[1]);
  assert.deepEqual(f.answered, ['allowed-once']); f.dispose();
});

test('a Host-rejected stale offer directs the user to one-call approval instead of repeating an invalid grant', async () => {
  for (const code of ['session_tool_approval_offer_stale', 'studio_native_session_approval_stale']) {
    const f = mount(() => { throw Object.assign(Error('stale offer'), { code }); });
    await f.render().children[0].props.onClick();
    const view = f.render();
    assert.equal(view.children[0].props.disabled, true);
    assert.equal(view.children[0].children[0], '会话授权已失效');
    assert.match(view.children[1].children[0], /允许一次/);
    await view.children[0].props.onClick();
    assert.equal(f.sent.length, 1); assert.deepEqual(f.answered, []);
    assert.equal(f.pending.answerable, true); f.dispose();
  }
});

test('a stale offer cannot disable or approve a later Host-owned offer on the same component', async () => {
  const f = mount(request => {
    if (request.offerId === 'offer') throw Object.assign(Error('expired'), { code: 'session_tool_approval_offer_stale' });
    return { status: 'accepted', offerId: request.offerId, requestId: request.requestId };
  });
  const old = f.render().children[0]; await old.props.onClick();
  f.pending.sessionGrant = { ...offer(), offerId: 'new-host-offer', requestId: 'new-pending-approval' };
  const current = f.render();
  assert.equal(current.children[0].props.disabled, false);
  assert.equal(current.children[1], null);
  await old.props.onClick(); assert.equal(f.sent.length, 1);
  await current.children[0].props.onClick();
  assert.equal(f.sent[1].offerId, 'new-host-offer');
  assert.deepEqual(f.answered, ['allowed-once']); f.dispose();
});

test('a stale or foreign grant receipt never answers the pending permission', async () => {
  for (const receipt of [{ status: 'accepted', offerId: 'foreign', requestId: 'pending-approval' },
    { status: 'accepted', offerId: 'offer', requestId: 'foreign' }, { status: 'unavailable' }]) {
    const f = mount(() => receipt); await f.render().children[0].props.onClick();
    assert.deepEqual(f.answered, []); assert.equal(f.render().children[1].props.role, 'alert'); f.dispose();
  }
});

test('withdrawing a card while its grant reply is pending cannot approve a replacement card', async () => {
  let finish; const f = mount(() => new Promise(resolve => { finish = resolve; }));
  const operation = f.render().children[0].props.onClick(); f.dispose();
  finish({ status: 'accepted', offerId: 'offer', requestId: 'pending-approval' }); await operation;
  assert.deepEqual(f.answered, []);
});

test('only an owned Native offer is shown, and child grants name their own target Session', () => {
  const f = mount(() => assert.fail('rendering cannot grant'));
  for (const change of [{ contract: 'unknown' }, { sessionId: 'foreign' }, { toolName: 'another-tool' }, { offerId: '' }]) {
    f.pending.sessionGrant = { ...offer(), ...change }; assert.equal(f.render(), null);
  }
  f.pending.sessionGrant = { ...offer(), targetSessionId: 'child-session' };
  assert.equal(f.render().children[0].children[0], '本子任务会话允许此工具'); assert.equal(f.sent.length, 0); f.dispose();
});
