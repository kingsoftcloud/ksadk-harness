import { createHash } from 'node:crypto';
import { isNativeError } from '@kingsoftcloud/agentkit-harness-core';

export const ENGINE_HOST_EFFECT = 'agentkit.engine-host-tool-effect/v1';
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_INPUTS = 64;

/** The host receives original user text and stable identities, never imported prose or media. */
export function engineUserObservations(store, scope, snapshot, { indexes, currentOnly = false } = {}) {
  const owners = new Map([[snapshot.runId, snapshot]]), seen = new Set(), observations = [];
  let bytes = 0;
  for (let index = snapshot.messages.length - 1; index >= 0; index--) {
    if (indexes && !indexes.has(index)) continue;
    const message = snapshot.messages[index];
    if (message.role !== 'user' || message.kind !== 'user_input' || !message.content.trim()) continue;
    const { sourceRunId, sourceIndex } = message.history ?? { sourceRunId: snapshot.runId, sourceIndex: index };
    if (currentOnly && sourceRunId !== snapshot.runId) continue;
    const sourceEventId = `native-message://${sourceRunId}#message=${sourceIndex}`;
    if (seen.has(sourceEventId)) continue;
    if (!owners.has(sourceRunId)) {
      try { owners.set(sourceRunId, store.load(scope, sourceRunId).snapshot); }
      catch (error) { if (!isNativeError(error) || error.code !== 'run_not_found') throw error; continue; }
    }
    const owner = owners.get(sourceRunId), original = owner?.messages[sourceIndex];
    if (!original || owner.sessionId !== snapshot.sessionId || original.history
      || original.kind !== 'user_input' || original.role !== 'user' || original.content !== message.content) continue;
    bytes += Buffer.byteLength(original.content, 'utf8');
    if (bytes > MAX_INPUT_BYTES || observations.length >= MAX_INPUTS) break;
    seen.add(sourceEventId);
    observations.push({ sourceEventId, sourceRunId, content: original.content,
      sourceDigest: 'sha256:' + createHash('sha256').update(original.content).digest('hex') });
  }
  return observations.reverse();
}

export function completedHostObservations(store, scope, { snapshot, configuration, events }) {
  const tools = new Set(configuration.tools.filter(tool => tool.hostEffectProtocol === ENGINE_HOST_EFFECT)
    .map(tool => tool.name));
  if (!tools.size || snapshot.phase !== 'completed') return null;
  const eligible = snapshot.outcome === 'verified' || snapshot.outcome === 'unverified'
    && (['required_acceptance_empty', 'verification_report_missing'].includes(snapshot.reason)
      || snapshot.reason === 'required_verification_incomplete' && snapshot.verification
      && !snapshot.verification.checks.some(item => ['failed', 'blocked'].includes(item.status)));
  const effectTools = [...new Set(events.flatMap(event => {
    if (event.kind === 'tool.completed') return [event.payload.name];
    if (event.kind === 'model.completed') return (event.payload.toolCalls ?? []).map(call => call.name);
    return [];
  }).filter(name => tools.has(name)))];
  return { contract: ENGINE_HOST_EFFECT, runId: snapshot.runId, effectTools,
    observations: eligible && !configuration.hostVerification
      ? engineUserObservations(store, scope, snapshot, { currentOnly: true }) : [] };
}
