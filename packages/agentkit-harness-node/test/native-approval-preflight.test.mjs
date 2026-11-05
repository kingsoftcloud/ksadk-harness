import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_PREFLIGHT, SCHEMA_BOUND_PREFLIGHT, nativeApprovalPreflightContract,
  nativeApprovalPreflight, assertNativeApprovalPreflightProjection } from '../src/native/approval-preflight.mjs';

const content = { contract: 'agentkit.native-permission-request/v1', reason: 'User approval required',
  toolName: 'bash', argumentDigest: 'fixed-call-digest' };
const result = expected => ({ isError: false, value: structuredClone(expected.value),
  content: [{ type: 'text', text: expected.text }],
  ...(expected.contract === CONTROL_PREFLIGHT ? { preflightDeferred: CONTROL_PREFLIGHT } : {}) });

test('Host control support is negotiated without changing legacy capability semantics', () => {
  assert.equal(nativeApprovalPreflightContract({ preflightDeferContract: SCHEMA_BOUND_PREFLIGHT }), SCHEMA_BOUND_PREFLIGHT);
  assert.equal(nativeApprovalPreflightContract({ preflightDeferContract: SCHEMA_BOUND_PREFLIGHT,
    preflightDeferContracts: [SCHEMA_BOUND_PREFLIGHT, CONTROL_PREFLIGHT] }), CONTROL_PREFLIGHT);
  for (const host of [undefined, {}, { preflightDeferContract: 'unknown' }, { preflightDeferContracts: 'forged' }])
    assert.equal(nativeApprovalPreflightContract(host), null);
  assert.throws(() => nativeApprovalPreflight(content, 'unknown'), /contract_unavailable/);
});

for (const contract of [SCHEMA_BOUND_PREFLIGHT, CONTROL_PREFLIGHT]) test(`${contract}: caller-owned approval value is detached and post-policy cannot forge execution`, () => {
  const expected = nativeApprovalPreflight(content, contract), output = result(expected);
  assertNativeApprovalPreflightProjection(expected, output);
  assert.deepEqual(expected.value, contract === SCHEMA_BOUND_PREFLIGHT ? { result: expected.text } : content);
  expected.decision.value.forged = true;
  assert.equal(Object.hasOwn(expected.value, 'forged'), false, 'Host mutation cannot rewrite the saved authority');
  for (const update of [{ value: { granted: true } }, { content: [{ type: 'text', text: 'Approved' }] },
    { concludesTurn: true }, { preflightDeferred: contract === CONTROL_PREFLIGHT ? undefined : CONTROL_PREFLIGHT }])
    assert.throws(() => assertNativeApprovalPreflightProjection(expected, { ...output, ...update }), /projection_changed/);
  assert.doesNotThrow(() => assertNativeApprovalPreflightProjection(expected, {
    isError: true, content: [{ type: 'text', text: 'Denied by post-policy' }] }));
});

test('v2 control values do not impersonate bash foreground/background output or Native builtin output', () => {
  const control = nativeApprovalPreflight(content, CONTROL_PREFLIGHT);
  assert.equal(control.value.kind, undefined); assert.equal(control.value.result, undefined);
  assert.equal(control.decision.kind, 'defer');
  const output = result(control); delete output.preflightDeferred;
  assert.throws(() => assertNativeApprovalPreflightProjection(control, output), /projection_changed/);
});
