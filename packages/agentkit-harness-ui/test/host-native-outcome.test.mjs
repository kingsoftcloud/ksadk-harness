import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRunPresentation } from '../src/host/state/native-outcome.mjs';
import { validateNativeRecoveryStatus } from '../src/host/state/native-recovery.mjs';

test('the status client retains a valid retry display fact and rejects malformed or contradictory waiting records', () => {
  const identity = { agentId: 'agent', sessionId: 'session', runId: 'run' };
  const status = { ...identity, contract: 'agentkit.studio-native-recovery/v1', state: 'recovering',
    phase: 'preparing_context', canResume: false, modelRetryWait: {
      contract: 'agentkit.native-model-retry-wait/v1', notBefore: 1200 } };
  assert.equal(validateNativeRecoveryStatus(status, identity), status);
  assert.equal(nativeRunPresentation(validateNativeRecoveryStatus(status, identity)).label, '等待模型重试');
  for (const change of [{ notBefore: Infinity }, { notBefore: '1200' }, { notBefore: 0 },
    { contract: 'unknown' }, { canResume: true }])
    assert.throws(() => validateNativeRecoveryStatus({ ...status, modelRetryWait: { ...status.modelRetryWait, ...change } }, identity));
  for (const change of [{ state: 'available' }, { phase: 'executing_tools' }, { phase: 'completed' }])
    assert.throws(() => validateNativeRecoveryStatus({ ...status, ...change }, identity));
  const legacy = { ...status }; delete legacy.modelRetryWait;
  assert.equal(nativeRunPresentation(validateNativeRecoveryStatus(legacy, identity)).label, '整理上下文');
});

test('Host-confirmed retry waiting is distinct from context work and never masks a stopped owner or another phase', () => {
  const status = { runId: 'run', phase: 'preparing_context', state: 'recovering',
    modelRetryWait: { contract: 'agentkit.native-model-retry-wait/v1', notBefore: 1200 } };
  assert.equal(nativeRunPresentation(status).label, '等待模型重试');
  assert.equal(nativeRunPresentation({ ...status, phase: 'compacting' }).label, '等待模型重试');
  assert.equal(nativeRunPresentation({ ...status, modelRetryWait: undefined }).label, '整理上下文');
  assert.equal(nativeRunPresentation({ ...status, modelRetryWait: { contract: 'unknown', notBefore: 1200 } }).label, '整理上下文');
  assert.equal(nativeRunPresentation({ ...status, phase: 'executing_tools' }).label, '执行工具');
  assert.equal(nativeRunPresentation({ ...status, phase: 'paused' }).label, '已暂停');
  assert.notEqual(nativeRunPresentation({ ...status, state: 'available', canResume: true }).label, '等待模型重试');
  assert.notEqual(nativeRunPresentation({ ...status, phase: 'completed', outcome: 'verified' }).label, '等待模型重试');
});

test('the UI offers recovery only when the authoritative Native control reports it is available', () => {
  const stopped = { runId: 'run', phase: 'interrupted', state: 'failed', canResume: false,
    reason: 'browser_session_unavailable', error: { message: '浏览器会话不可用，请重新建立浏览器连接。' } };
  assert.deepEqual(nativeRunPresentation(stopped), { label: '任务已中断', detail: stopped.error.message });
  const recoverable = { runId: 'run', phase: 'executing_tools', state: 'available', canResume: true };
  assert.match(nativeRunPresentation(recoverable).label, /等待恢复/);
  assert.doesNotMatch(nativeRunPresentation({ ...recoverable, canResume: false }).detail, /恢复原任务后才会继续/);
  const uncertain = nativeRunPresentation({ ...stopped, reason: 'effect_outcome_unknown' });
  assert.match(uncertain.label, /结果待核对/);assert.match(uncertain.detail, /不会自动重跑/);
});
