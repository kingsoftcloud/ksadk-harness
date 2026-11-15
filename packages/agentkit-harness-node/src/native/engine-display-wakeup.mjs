/** Ephemeral presentation notification, scoped to a Run. The journal remains
 * authoritative; a timeout still observes durable changes and other processes. */
export function createDisplayWakeup() {
  const waiting = new Map();
  return {
    notify(runId) { for (const wake of [...waiting.get(runId) ?? []]) wake(); },
    wait(runId, timeoutMs, signal) {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        let settled = false;
        const listeners = waiting.get(runId) ?? new Set(); waiting.set(runId, listeners);
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer); signal.removeEventListener('abort', abort); listeners.delete(wake);
          if (!listeners.size) waiting.delete(runId);
          if (error) reject(error); else resolve();
        };
        const wake = () => finish(), abort = () => finish(signal.reason);
        const timer = setTimeout(wake, timeoutMs);
        listeners.add(wake); signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
}
