import { randomUUID } from 'node:crypto';
import { canonical, copy, invariant, scopeKey } from '@kingsoftcloud/agentkit-harness-core';

export const SESSION_TOOL_APPROVAL_CONTRACT = 'agentkit.native-session-tool-approval/v1';
const bindingKeys = ['scope', 'sessionId', 'buildId', 'authorityDigest', 'toolName', 'definitionDigest'];
const opaque = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
function bindingOf(value) {
  invariant(value && !Array.isArray(value) && Object.keys(value).length === bindingKeys.length
    && bindingKeys.every(key => Object.hasOwn(value, key)), 'session_tool_approval_binding_invalid');
  scopeKey(value.scope);
  invariant(['sessionId', 'buildId', 'toolName'].every(key => opaque(value[key]))
    && ['authorityDigest', 'definitionDigest'].every(key => /^[a-f0-9]{64}$/.test(value[key])), 'session_tool_approval_binding_invalid');
  return copy(value);
}

/** Live, explicit Session grants for one additional permission constraint.
 * The Host must still run every downstream policy, guard and sandbox check.
 * Offers cannot be reconstructed from model output or an old audit record;
 * a new process starts without grants. Audit failure never installs a grant.
 */
export function createSessionToolApprovalOwner({ audit, now = Date.now, token = randomUUID,
  maxOffers = 256, maxGrants = 1024, offerTimeoutMs = 120000 } = {}) {
  invariant(typeof audit === 'function' && typeof now === 'function' && typeof token === 'function'
    && [maxOffers, maxGrants, offerTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0),
  'session_tool_approval_owner_invalid');
  const offers = new Map(), grants = new Map();
  let closed = false;
  const current = entry => {
    try { return !closed && !entry.signal.aborted && now() < entry.expiresAt && entry.isCurrent() === true; }
    catch { return false; }
  };
  const record = entry => {
    const event = { contract: SESSION_TOOL_APPROVAL_CONTRACT, offerId: entry.offerId,
      requestId: entry.requestId, binding: copy(entry.binding), offerExpiresAt: entry.expiresAt };
    const result = audit(copy(event));
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      invariant(false, 'session_tool_approval_audit_must_commit_synchronously');
    }
    return Object.freeze(event);
  };
  const prune = () => {
    for (const [id, entry] of offers) if (!current(entry)) offers.delete(id);
  };
  return Object.freeze({
    offer({ binding, requestId, signal, isCurrent }) {
      invariant(!closed && opaque(requestId) && signal instanceof AbortSignal && typeof isCurrent === 'function',
        'session_tool_approval_offer_invalid');
      const admitted = bindingOf(binding); prune();
      invariant(offers.size < maxOffers, 'session_tool_approval_offer_capacity');
      const offerId = token();
      invariant(opaque(offerId) && !offers.has(offerId) && ![...grants.values()].some(item => item.offerId === offerId),
        'session_tool_approval_token_invalid');
      const entry = { offerId, requestId, binding: admitted, signal, isCurrent, expiresAt: now() + offerTimeoutMs };
      invariant(current(entry), 'session_tool_approval_offer_stale');
      offers.set(offerId, entry);
      return Object.freeze({ contract: SESSION_TOOL_APPROVAL_CONTRACT, offerId, requestId,
        sessionId: admitted.sessionId, toolName: admitted.toolName, expiresAt: entry.expiresAt });
    },
    grant({ offerId, requestId, binding }) {
      invariant(!closed, 'session_tool_approval_closed');
      const admitted = bindingOf(binding), key = canonical(admitted), previous = grants.get(key);
      if (previous?.offerId === offerId && previous.requestId === requestId)
        return { status: 'duplicate', receipt: copy(previous) };
      const entry = offers.get(offerId);
      invariant(entry && entry.requestId === requestId && canonical(entry.binding) === key && current(entry),
        'session_tool_approval_offer_stale');
      invariant(grants.has(key) || grants.size < maxGrants, 'session_tool_approval_grant_capacity');
      const receipt = record(entry);
      // A synchronous audit callback may revoke/withdraw the offer.
      invariant(offers.get(offerId) === entry && current(entry), 'session_tool_approval_offer_stale');
      grants.set(key, receipt); offers.delete(offerId);
      return { status: 'accepted', receipt: copy(receipt) };
    },
    has(binding) { return !closed && grants.has(canonical(bindingOf(binding))); },
    withdraw(offerId, { revokeGrant = false } = {}) {
      offers.delete(offerId);
      const revoked = [];
      if (revokeGrant) for (const [key, receipt] of grants) if (receipt.offerId === offerId) {
        revoked.push(copy(receipt)); grants.delete(key);
      }
      return revoked;
    },
    revokeSession(scope, sessionId) {
      const identity = canonical({ scope, sessionId });
      for (const [id, entry] of offers) if (canonical({ scope: entry.binding.scope, sessionId: entry.binding.sessionId }) === identity) offers.delete(id);
      for (const [id, entry] of grants) if (canonical({ scope: entry.binding.scope, sessionId: entry.binding.sessionId }) === identity) grants.delete(id);
    },
    close() { closed = true; offers.clear(); grants.clear(); },
  });
}
