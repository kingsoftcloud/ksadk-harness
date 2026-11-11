import { CONTEXT_CONTRIBUTION_CONTRACT, canonical, invariant } from '@kingsoftcloud/agentkit-harness-core';

export const ENGINE_VERIFICATION = 'agentkit.engine-verification/v1';
const TIMEOUT_MS = 5000;
const EVIDENCE_BYTES = 256 * 1024;
const ID = /^[a-zA-Z0-9._-]{1,128}$/;

export function admitEngineVerification(input) {
  if (input === undefined) return undefined;
  invariant(input && input.contract === ENGINE_VERIFICATION
    && Object.keys(input).every(key => ['contract', 'verifierRef', 'verifierVersion', 'bindingDigest',
      'evidenceTools', 'contextSourceId'].includes(key))
    && typeof input.verifierRef === 'string' && ID.test(input.verifierRef)
    && typeof input.verifierVersion === 'string' && ID.test(input.verifierVersion)
    && typeof input.bindingDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(input.bindingDigest)
    && Array.isArray(input.evidenceTools) && input.evidenceTools.length <= 16
    && new Set(input.evidenceTools).size === input.evidenceTools.length
    && input.evidenceTools.every(name => typeof name === 'string' && ID.test(name))
    && (input.contextSourceId === null || typeof input.contextSourceId === 'string' && ID.test(input.contextSourceId)),
  'engine_verification_binding_invalid');
  const { contract: _contract, ...binding } = input;
  return binding;
}

function verificationEvidence(record, definition) {
  const { configuration, events, intents, receipts } = record;
  const tools = new Set(definition.evidenceTools);
  const source = configuration.contextSources.find(item => item.sourceId === definition.contextSourceId);
  const intentByKey = new Map(intents.map(intent => [intent.operationKey, intent]));
  const receiptByKey = new Map(receipts.map(receipt => [receipt.operationKey, receipt]));
  const calls = [], context = [];
  let available = EVIDENCE_BYTES, contextSeen = false;
  const append = (target, item) => {
    const size = Buffer.byteLength(canonical(item));
    if (size > available) return;
    available -= size;
    target.push(item);
  };
  for (let index = events.length - 1; index >= 0 && available > 0; index--) {
    const event = events[index];
    if (event.kind !== 'effect.settled' || event.payload.status !== 'committed') continue;
    const { operationKey, kind } = event.payload;
    const receipt = receiptByKey.get(operationKey);
    if (receipt?.status !== 'committed') continue;
    if (source && !contextSeen && kind === 'context' && receipt.result.action === 'ready') {
      contextSeen = true;
      for (const message of receipt.result.messages ?? []) {
        if (message.kind !== 'context_contribution') continue;
        let fragment;
        try { fragment = JSON.parse(message.content); } catch { continue; }
        if (fragment.schemaVersion === CONTEXT_CONTRIBUTION_CONTRACT
          && fragment.sourceId === source.sourceId && fragment.bindingDigest === source.bindingDigest
          && fragment.purpose === 'context_only' && (fragment.expiresAt === undefined || fragment.expiresAt > Date.now())) {
          append(context, { sourceId: source.sourceId, item: fragment.item });
        }
      }
    }
    if (kind !== 'tool') continue;
    const admitted = intentByKey.get(operationKey)?.payload.calls, results = receipt.result.results;
    if (!Array.isArray(admitted) || !Array.isArray(results) || admitted.length !== results.length) continue;
    for (let offset = 0; offset < admitted.length && calls.length < 64; offset++) {
      const call = admitted[offset], result = results[offset];
      if (!tools.has(call.name) || !result || result.status === 'approval_required') continue;
      append(calls, { operationKey: admitted.length > 1 ? `${operationKey}:call:${offset + 1}` : operationKey,
        eventId: event.eventId, call, status: result.status, content: result.content ?? null });
    }
  }
  return { calls, context };
}

export function engineVerificationPort(store, callHostVerification, digest) {
  return {
    available: configuration => !!configuration.hostVerification,
    async verify(request) {
      const record = store.load(request.scope, request.runId);
      const definition = record.configuration.hostVerification;
      const item = request.contract.acceptance[0];
      const candidate = request.candidate;
      invariant(definition && item?.verifierRef === definition.verifierRef
        && item.verifierVersion === definition.verifierVersion && candidate.binding, 'engine_verification_unbound');
      const input = { contract: ENGINE_VERIFICATION, runId: request.runId,
        operationKey: request.operationKey, definition, candidateId: candidate.candidateId,
        contractRevision: request.contract.revision, candidateBinding: candidate.binding,
        goal: request.snapshot.goal, goalRevision: request.snapshot.goalRevision,
        evidence: verificationEvidence(record, definition) };
      const inputDigest = digest(input);
      const base = { candidateId: candidate.candidateId, contractRevision: request.contract.revision,
        binding: candidate.binding, workspaceRevision: candidate.workspaceRevision, workspaceDependency: 'none' };
      const unavailable = { status: 'blocked', reason: 'host_verification_unavailable',
        safeSummary: 'The bound host could not verify the requested result.', evidenceRefs: [] };
      let result = unavailable;
      try {
        const reply = await callHostVerification({ ...input, inputDigest }, TIMEOUT_MS, request.signal);
        if (reply?.contract === ENGINE_VERIFICATION && reply.operationKey === request.operationKey
          && reply.inputDigest === inputDigest && ['passed', 'failed', 'blocked'].includes(reply.status)
          && typeof reply.reason === 'string' && ID.test(reply.reason)
          && typeof reply.safeSummary === 'string' && reply.safeSummary.length <= 2048
          && Array.isArray(reply.evidenceRefs) && reply.evidenceRefs.length <= 16
          && reply.evidenceRefs.every(ref => typeof ref === 'string' && ref.trim() && ref.length <= 256)
          && (reply.status === 'blocked' || reply.evidenceRefs.length > 0)) result = reply;
      } catch {
        request.signal.throwIfAborted();
      }
      return { ...base, status: result.status === 'blocked' ? 'unverified' : result.status,
        reason: result.reason, failureFingerprint: digest([definition, result.status, result.reason]),
        checks: [{ id: item.id, status: result.status, verifierId: item.verifierRef, verifierVersion: item.verifierVersion,
          verificationMethod: item.verificationMethod, evidence: { reason: result.reason }, evidenceRefs: result.evidenceRefs,
          safeSummary: result.safeSummary, repairable: result.status === 'failed' }] };
    },
  };
}
