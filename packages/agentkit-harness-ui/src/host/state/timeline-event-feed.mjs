/** Presentation scheduling only. Never rewrite or drop authoritative events.
 * Transient chunks share a paint; durable/reconnect changes publish immediately. */
export function createTimelineEventFeed(source, {
  schedule = callback => typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : setTimeout(callback, 16),
  cancel = handle => typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(handle) : clearTimeout(handle),
} = {}) {
  let snapshot = source.getSnapshot(), release = null, frame = null, generation = 0;
  const listeners = new Set();
  const cancelPending = () => { generation++; if (frame !== null) cancel(frame); frame = null; };
  const publish = () => {
    const next = source.getSnapshot();
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const changed = () => {
    const change = source.getSnapshot().change;
    const transient = change?.kind === 'append' && change.entries.length > 0
      && change.entries.every(entry => entry.event?.type === 'assistant/live-chunk');
    if (!transient) { cancelPending(); publish(); return; }
    if (frame !== null) return;
    const current = generation;
    frame = schedule(() => { if (current !== generation) return; frame = null; publish(); });
  };
  return {
    getSnapshot() { if (!listeners.size) snapshot = source.getSnapshot(); return snapshot; },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) { release = source.subscribe(changed); publish(); }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { cancelPending(); release?.(); release = null; }
      };
    },
  };
}
