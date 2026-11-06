import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeChildPanel } from '../src/host/native-run-panel.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const walk = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(walk)] : [];
function hooks(Component, dispatcher) {
  const states = [], effects = [];
  return { render(props) {
    let stateIndex = 0, effectIndex = 0; const pending = [];
    dispatcher.useState = initial => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    };
    dispatcher.useEffect = (run, deps) => {
      const index = effectIndex++, old = effects[index];
      if (!old || deps.some((value, i) => value !== old.deps[i]))
        pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: run() }; });
    };
    const tree = Component(props); pending.forEach(run => run()); return tree;
  }, dispose() { effects.forEach(effect => effect.cleanup?.()); } };
}

test('the real header panel shows output exhaustion and its original-run recovery inside the existing dialog', async t => {
  const dispatcher = {}, React = { Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: (...args) => dispatcher.useState(...args), useEffect: (...args) => dispatcher.useEffect(...args) };
  let resumes = 0;
  const status = { contract: 'agentkit.studio-native-recovery/v1', agentId: 'agent', sessionId: 'session', runId: 'original',
    state: 'available', phase: 'paused', reason: 'output_budget_exhausted', outcome: null, canResume: true };
  const Panel = createNativeChildPanel({ ui: { React, ResourceDialog: 'dialog', buttonStyle: () => ({}) },
    resolveAgentFromPreset: () => 'agent', setInterval: () => 1, clearInterval() {},
    hostRemote: {
      agents: async () => ({ items: [{ metadata: { id: 'agent', local: true }, spec: { runtime: { type: 'harness' } } }] }),
      nativeRecoveryStatus: async () => status,
      nativeChildHistory: async () => ({ contract: 'agentkit.studio-native-child-history/v1', sessionId: 'session', runId: 'original',
        tasks: [], inventoryDigest: 'a'.repeat(64), offset: 0, nextOffset: 0, totalTasks: 0, complete: true }),
      resumeNativeRun: async request => { resumes++; assert.equal(request.runId, 'original');
        return { ...status, state: 'recovering', phase: 'preparing_context', reason: null, canResume: false }; },
    } });
  const props = { sessionId: 'session', useSessions: select => select({ byId: { session: {
    running: false, projectionValues: { agentPreset: 'preset' },
  } } }) };
  const outer = hooks(Panel, dispatcher); t.after(() => outer.dispose());
  outer.render(props); await tick();
  const mounted = outer.render(props).children[0], child = hooks(mounted.type, dispatcher);
  t.after(() => child.dispose()); child.render(mounted.props); child.render(mounted.props); await tick();
  let tree = child.render(mounted.props);
  const badge = walk(tree).find(node => node.props['aria-label'] === 'Native 任务状态');
  assert.match(badge.children.join(''), /输出恢复额度.*暂停/);
  assert.match(badge.props.title, /已保留.*工具结果和回复片段/);
  assert.equal(walk(tree).some(node => node.type === 'dialog'), false);
  walk(tree).find(node => node.type === 'button' && node.children.includes('运行与子任务')).props.onClick();
  child.render(mounted.props); await tick(); tree = child.render(mounted.props);
  const dialog = walk(tree).find(node => node.type === 'dialog'); assert.ok(dialog);
  assert.match(walk(dialog).find(node => node.props['aria-label'] === '运行原因与后续操作').children.join(''), /核对后恢复原运行/);
  assert.equal(resumes, 0, 'rendering or reading status cannot resume work');
  walk(dialog).find(node => node.type === 'button' && node.children.includes('恢复原运行')).props.onClick();
  await tick(); assert.equal(resumes, 1);
  assert.equal(walk(tree).some(node => node.type === 'hr' || node.type === 'footer'), false);
});
