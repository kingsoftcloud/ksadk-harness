import { canonical, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

export const SCHEMA_BOUND_PREFLIGHT = 'dsh.tool-preflight-defer/v1';
export const CONTROL_PREFLIGHT = 'dsh.tool-preflight-defer/v2';

/** Select an explicitly advertised Host seam. Never guess support from a tool
 * name or relax the actual tool's output schema to carry an approval request. */
export function nativeApprovalPreflightContract(capabilities) {
  const advertised = capabilities?.preflightDeferContracts ?? [capabilities?.preflightDeferContract];
  if (!Array.isArray(advertised)) return null;
  return advertised.includes(CONTROL_PREFLIGHT) ? CONTROL_PREFLIGHT
    : advertised.includes(SCHEMA_BOUND_PREFLIGHT) ? SCHEMA_BOUND_PREFLIGHT : null;
}

/** A pre-dispatch control value is not a successful tool body value. The v1
 * envelope is retained only for historical Hosts whose owned tools declare it.
 * The v2 Host renders marked control data without invoking the body projector. */
export function nativeApprovalPreflight(content, contract) {
  invariant([SCHEMA_BOUND_PREFLIGHT, CONTROL_PREFLIGHT].includes(contract), 'native_approval_preflight_contract_unavailable');
  const text = canonical(content);
  const value = contract === SCHEMA_BOUND_PREFLIGHT ? { result: text } : parseNativeJson(text);
  return { contract, value, text, decision: { kind: 'defer', value: structuredClone(value) } };
}

/** Post-policy denial remains a denial. A success-shaped replacement cannot
 * turn a deferred request into an execution receipt or change its authority. */
export function assertNativeApprovalPreflightProjection(expected, result) {
  if (result?.isError === true) return;
  invariant(result?.isError === false && !result.concludesTurn
    && (expected.contract === CONTROL_PREFLIGHT ? result.preflightDeferred === CONTROL_PREFLIGHT
      : result.preflightDeferred === undefined)
    && canonical(result.value) === canonical(expected.value)
    && canonical(result.content) === canonical([{ type: 'text', text: expected.text }]),
  'native_approval_preflight_projection_changed');
}
