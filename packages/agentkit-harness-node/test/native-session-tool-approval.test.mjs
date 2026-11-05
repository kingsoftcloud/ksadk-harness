import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToolApprovalOwner } from '../src/native/session-tool-approval.mjs';

const binding = () => ({ scope: { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' }, sessionId: 'session',
  buildId: 'build', toolName: 'run_command', authorityDigest: 'a'.repeat(64), definitionDigest: 'b'.repeat(64) });
const setup = (options = {}) => {
  const events = [], controller = new AbortController(); let sequence = 0, time = 100, live = true;
  const owner = createSessionToolApprovalOwner({ audit: event => { events.push(event); }, token: () => `offer-${++sequence}`,
    now: () => time, ...options });
  const offer = owner.offer({ binding: binding(), requestId: 'pending-ledger-approval', signal: controller.signal, isCurrent: () => live });
  const command = { offerId: offer.offerId, requestId: offer.requestId, binding: binding() };
  return { owner, offer, command, controller, events, time: value => { time = value; }, live: value => { live = value; } };
};

test('an offer is not a grant; one explicit scoped decision commits one audit receipt and retries are idempotent', () => {
  const f = setup();
  assert.equal(f.owner.has(binding()), false); assert.equal(f.events.length, 0);
  assert.equal(f.owner.grant(f.command).status, 'accepted'); assert.equal(f.owner.has(binding()), true);
  assert.equal(f.owner.grant(f.command).status, 'duplicate'); assert.equal(f.events.length, 1);
  f.events[0].binding.toolName = 'forged';
  assert.equal(f.owner.grant(f.command).receipt.binding.toolName, 'run_command');
  assert.doesNotMatch(JSON.stringify(f.offer), /authorityDigest|definitionDigest|workspaceId/);
});

for (const field of ['sessionId', 'buildId', 'toolName', 'authorityDigest', 'definitionDigest', 'tenantId', 'workspaceId', 'userId', 'agentId'])
test(`a Session grant never crosses ${field}`, () => {
  const f = setup(), altered = binding(); f.owner.grant(f.command);
  if (Object.hasOwn(altered.scope, field)) altered.scope[field] += '-other';
  else altered[field] = field.endsWith('Digest') ? 'c'.repeat(64) : altered[field] + '-other';
  assert.equal(f.owner.has(altered), false);
  assert.throws(() => f.owner.grant({ ...f.command, binding: altered }), { code: 'session_tool_approval_offer_stale' });
});

for (const failure of ['abort', 'timeout', 'superseded', 'withdrawn', 'forged-offer', 'forged-request', 'closed'])
test(`${failure} cannot turn a live permission offer into a grant`, () => {
  const f = setup();
  if (failure === 'abort') f.controller.abort();
  if (failure === 'timeout') f.time(f.offer.expiresAt);
  if (failure === 'superseded') f.live(false);
  if (failure === 'withdrawn') f.owner.withdraw(f.offer.offerId);
  if (failure === 'forged-offer') f.command.offerId = 'old-audit-offer';
  if (failure === 'forged-request') f.command.requestId = 'another-request';
  if (failure === 'closed') f.owner.close();
  assert.throws(() => f.owner.grant(f.command), { code: failure === 'closed' ? 'session_tool_approval_closed' : 'session_tool_approval_offer_stale' });
  assert.equal(f.owner.has(binding()), false); assert.equal(f.events.length, 0);
});

test('revoking a Session removes its outstanding offers and grants; a new owner cannot replay an old audit', () => {
  const f = setup(); f.owner.grant(f.command); f.owner.revokeSession(binding().scope, 'session');
  assert.equal(f.owner.has(binding()), false);
  assert.throws(() => f.owner.grant(f.command), { code: 'session_tool_approval_offer_stale' });
  const next = createSessionToolApprovalOwner({ audit: () => assert.fail('must not audit a replay') });
  assert.equal(next.has(binding()), false);
  assert.throws(() => next.grant(f.command), { code: 'session_tool_approval_offer_stale' });
});

test('a rejection racing a grant revokes that offer only and its reply cannot recreate permission', () => {
  const f = setup(); f.owner.grant(f.command);
  const revoked = f.owner.withdraw(f.offer.offerId, { revokeGrant: true });
  assert.equal(revoked.length, 1); assert.equal(f.owner.has(binding()), false);
  assert.throws(() => f.owner.grant(f.command), { code: 'session_tool_approval_offer_stale' });
  assert.equal(f.owner.withdraw(f.offer.offerId, { revokeGrant: true }).length, 0);
});

test('a failed or asynchronous audit cannot install a grant', () => {
  for (const audit of [() => { throw Error('audit unavailable'); }, () => Promise.resolve(), () => Promise.reject(Error('audit failed'))]) {
    const f = setup({ audit }); assert.throws(() => f.owner.grant(f.command)); assert.equal(f.owner.has(binding()), false);
  }
});

test('a failed current-owner probe closes the offer without executing an audit or authorizing a tool', () => {
  let calls = 0;
  const owner = createSessionToolApprovalOwner({ audit: () => assert.fail('must not audit') });
  const offer = owner.offer({ binding: binding(), requestId: 'request', signal: new AbortController().signal,
    isCurrent: () => { if (++calls === 1) return true; throw Error('owner disconnected'); } });
  assert.throws(() => owner.grant({ ...offer, binding: binding() }), { code: 'session_tool_approval_offer_stale' });
  assert.equal(owner.has(binding()), false);
});

test('resource limits do not silently evict a grant or admit an untracked offer', () => {
  const f = setup({ maxOffers: 1, maxGrants: 1 });
  assert.throws(() => f.owner.offer({ binding: binding(), requestId: 'second', signal: f.controller.signal, isCurrent: () => true }),
    { code: 'session_tool_approval_offer_capacity' });
  f.owner.grant(f.command);
  const second = { ...binding(), toolName: 'write_workspace_file' };
  const offer = f.owner.offer({ binding: second, requestId: 'second', signal: f.controller.signal, isCurrent: () => true });
  assert.throws(() => f.owner.grant({ ...offer, binding: second }), { code: 'session_tool_approval_grant_capacity' });
  assert.equal(f.owner.has(binding()), true); assert.equal(f.owner.has(second), false);
});
