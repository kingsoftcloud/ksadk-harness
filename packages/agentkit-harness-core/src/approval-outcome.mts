/** Host answers are not interchangeable. Unknown answers never grant access.
 * Session permissions are a separate scoped Host authority, not an outcome a
 * model or tool may claim in this vocabulary. */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
export const APPROVAL_OUTCOME_POLICY = 'owner-outcome/v1' as const;
export function isApprovalDenialReason(value: unknown): value is 'approval_prompts_disabled' | 'approval_rejected' | 'approval_unavailable' | 'approval_cancelled' {
  return value === 'approval_prompts_disabled' || value === 'approval_rejected'
    || value === 'approval_unavailable' || value === 'approval_cancelled';
}
export function normalizeHostApprovalOutcome(value: unknown): HostApprovalOutcome {
  return value === 'allowed-once' || value === 'rejected' || value === 'cancelled' ? value : 'unavailable';
}
export function approvalOutcomePauseReason(value: HostApprovalOutcome): string | null {
  return value === 'rejected' ? 'approval_rejected' : value === 'cancelled' ? 'approval_cancelled'
    : value === 'unavailable' ? 'approval_unavailable' : null;
}
