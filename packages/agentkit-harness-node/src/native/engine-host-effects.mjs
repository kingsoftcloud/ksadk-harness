import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, invariant, isNativeError, toolReceiptSource } from '@kingsoftcloud/agentkit-harness-core';

export const ENGINE_HOST_EFFECT = 'agentkit.engine-host-tool-effect/v1';
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_INPUTS = 64;
export const RECEIPT_WAIT_MS = 30_000;

export function hostReceiptSource(record) {
  const originalOperationKey = record.snapshot.toolReconciliation?.operationKey;
  if (record.snapshot.phase !== 'awaiting_reconciliation' || !originalOperationKey) return null;
  const { call, definition } = toolReceiptSource(record, originalOperationKey);
  return definition.hostEffectProtocol === ENGINE_HOST_EFFECT ? { call, originalOperationKey } : null;
}

export function hostReceiptReply(reply, observationId) {
  invariant(reply && typeof reply === 'object' && !Array.isArray(reply), 'engine_host_receipt_invalid');
  if (observationId) {
    invariant(reply.result === undefined || reply.result && ['ok', 'error'].includes(reply.result.status), 'engine_host_receipt_invalid');
    return reply.result ?? null;
  }
  if (reply.token === undefined) return null;
  invariant(typeof reply.token === 'string' && /^[0-9a-f]{64}$/u.test(reply.token) && typeof reply.settled === 'boolean'
    && (reply.settled || Number.isSafeInteger(reply.retryUntil) && reply.retryUntil > 0), 'engine_host_receipt_invalid');
  return { token: reply.token, settled: reply.settled, retryUntil: reply.retryUntil };
}

/** Idle reads inspect a durable checkpoint. The Kernel claims the original
 * remote receipt query separately from the initial mutation. */
export async function waitForHostReceipt(record, { read, signal, assertCurrent, waitMs = RECEIPT_WAIT_MS }) {
  const source = hostReceiptSource(record);
  if (!source) return null;
  const { call, originalOperationKey } = source, { runId } = record.snapshot;
  const deadline = AbortSignal.timeout(waitMs);
  const polling = AbortSignal.any([signal, deadline]);
  try {
    while (!polling.aborted) {
      assertCurrent();
      const ready = await read(call, originalOperationKey, polling).catch(() => null);
      polling.throwIfAborted();
      assertCurrent();
      if (ready) {
        const digest = createHash('sha256').update(canonical({ runId, originalOperationKey, token: ready.token })).digest('hex');
        const prefix = 'host-receipt-' + digest;
        const attempts = record.commands.filter(row => row.consumed && row.command.commandId.startsWith(prefix + '-')).length;
        // A terminal fact has a different checkpoint token. Give the host a
        // bounded window to publish it before leaving the durable Run idle.
        if (ready.settled ? attempts < 3 : attempts === 0 || Date.now() < ready.retryUntil) {
          if (attempts) await delay(Math.min(1500 * attempts, 5000), undefined, { signal: polling });
          assertCurrent();
          return { commandId: prefix + '-' + attempts, kind: 'reconcile_tool', payload: { originalOperationKey } };
        }
      }
      await delay(1000, undefined, { signal: polling });
    }
  } catch (error) {
    if (!deadline.aborted || signal.aborted) throw error;
  }
  assertCurrent();
  return null;
}

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
