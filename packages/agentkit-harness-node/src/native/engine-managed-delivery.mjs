import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { atomicPrivate, openPrivate, privateDirectory } from './local-command-state.mjs';
import { projectEngineEvent } from './engine-server.mjs';

export const MANAGED_SESSION_DELIVERY = 'agentkit.managed-session-delivery/v1';
export const MANAGED_SESSION_DELIVERY_LIMIT = 16 * 1024 ** 2;
const frameLimit = 64 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');

function storedPayload(path) {
  let fd;
  try {
    fd = openPrivate(path, constants.O_RDONLY);
    invariant(fstatSync(fd).size <= MANAGED_SESSION_DELIVERY_LIMIT, 'managed_delivery_outbox_invalid');
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function projectManagedSessionEvent(event, configuration) {
  let frame;
  try { frame = projectEngineEvent(event, !!configuration.hostVerification); }
  catch {
    // Non-JSON diagnostic values in a tool preview cannot stop execution
    // or prevent publishing the surrounding durable events.
    return { schema: 'agentkit.engine-event/v1', seq: event.seq, kind: event.kind, category: event.kind.split('.')[0], truncated: true };
  }
  if (typeof frame.detail === 'string') frame.detail = frame.detail.slice(0, 8192);
  if (Buffer.byteLength(canonical(frame)) <= frameLimit) return frame;
  const { schema, seq, kind, category, title, status, detail } = frame;
  return { schema, seq, kind, category,
    ...(typeof title === 'string' ? { title } : {}), ...(typeof status === 'string' ? { status } : {}),
    ...(typeof detail === 'string' ? { detail } : {}), truncated: true };
}

/** Retries deliver the same terminal transcript and view bytes even after
 * the Engine is replaced. The remote Host owns its Session journal and ACK. */
export function createManagedSessionDelivery({ directory, host, ref, scope, sessionId, runId, input, source, readTerminalFrames, view }) {
  const path = join(directory, digest(runId) + '.json');
  const request = (configDigest) => ({ deliveryContract: MANAGED_SESSION_DELIVERY,
    scope, sessionId, runId, ref, input, source, configDigest });
  return {
    async beforeExecute({ configDigest, signal }) {
      await host.deliver('claim', { ...request(configDigest), follow: true, hostCancel: true }, signal);
    },
    async afterTerminal({ snapshot, signal }) {
      let encoded = storedPayload(path);
      if (encoded === null) {
        const { phase, configDigest } = snapshot;
        encoded = canonical({ ...request(configDigest), phase,
          finalText: phase === 'completed' ? snapshot.finalText ?? '' : '',
          view, events: readTerminalFrames(runId) });
        invariant(Buffer.byteLength(encoded) < MANAGED_SESSION_DELIVERY_LIMIT - 1024, 'managed_delivery_outbox_too_large');
        privateDirectory(directory, true);
        atomicPrivate(path, encoded);
      }
      await host.deliver('finish', parseNativeJson(encoded), signal);
    },
  };
}
