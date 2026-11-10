import type { ModelStreamEvent, ModelStreamRecord } from './contracts.mjs';
import { canonical, copy } from './values.mjs';

/** Publish live output and retain a bounded public prefix for history. Neither supplies execution authority. */
export function modelStreamCapture(maxBytes: number, now: () => number,
  publish: (event: ModelStreamEvent, record: ModelStreamRecord) => void) {
  const records: ModelStreamRecord[] = [];
  let bytes = 2, lastTime = 0, truncated = false, discarded = 0, closed = false;
  return {
    emit(value: ModelStreamEvent) {
      if (closed) return;
      if (!value || !['text', 'thinking', 'tool_delta'].includes(value.kind) || typeof value.text !== 'string') {
        discarded++; return;
      }
      if (!value.text) return;
      const event: ModelStreamEvent = { kind: value.kind, text: value.text };
      if (event.kind === 'tool_delta') {
        const index = value.metadata?.index;
        if (!Number.isSafeInteger(index) || Number(index) < 0) { discarded++; return; }
        // Provider signatures, private replay state and arbitrary metadata must
        // never reach Session streams, even when a port includes them.
        event.metadata = { index: Number(index),
          ...(typeof value.metadata?.callId === 'string' ? { callId: value.metadata.callId } : {}),
          ...(typeof value.metadata?.name === 'string' ? { name: value.metadata.name } : {}) };
      }
      const clock = now();
      lastTime = Math.max(lastTime, Number.isSafeInteger(clock) && clock >= 0 ? clock : 0);
      const record = { time: lastTime, event };
      if (!truncated) {
        const size = new TextEncoder().encode(canonical(record)).length + (records.length ? 1 : 0);
        if (bytes + size > maxBytes) truncated = true;
        else { bytes += size; records.push(record); }
      }
      if (maxBytes === 0) return;
      // Display observers cannot veto or mutate the model result or receipt.
      try { publish(copy(event), copy(record)); } catch { /* non-authoritative observer */ }
    },
    close() { closed = true; return { version: 'agentkit.model-display/v1', records: copy(records), truncated, discarded }; },
  };
}
