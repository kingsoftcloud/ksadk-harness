import { canonical, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

const pageLimit = 1024 ** 2;
const tailLimit = 3 * 1024 ** 2;

/** Freeze presentation in the same transaction as the public event cursor.
 * A reconnect after an Engine upgrade can still read the identical frames. */
export function createManagedSessionFrames(db, projectEvent) {
  const enabled = configuration => projectEvent && configuration?.hostRecoveryBinding?.sessionDelivery === true;
  const last = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM managed_session_frames WHERE run_id=?');
  const insert = db.prepare('INSERT INTO managed_session_frames (run_id, seq, data) VALUES (?,?,?)');
  const page = db.prepare('SELECT data FROM managed_session_frames WHERE run_id=? AND seq>? ORDER BY seq LIMIT 128');
  const tail = db.prepare('SELECT data FROM managed_session_frames WHERE run_id=? ORDER BY seq DESC LIMIT 2000');

  function collect(rows, limit) {
    const events = [];
    let bytes = 0;
    for (const { data } of rows) {
      bytes += Buffer.byteLength(data) + 1;
      if (bytes > limit) break;
      events.push(parseNativeJson(data));
    }
    return events;
  }

  return {
    sync(record) {
      if (!enabled(record.configuration)) return;
      const runId = record.snapshot.runId;
      const cursor = last.get(runId).seq;
      for (const event of record.events) {
        if (event.seq <= cursor) continue;
        const frame = projectEvent(event, record.configuration);
        invariant(frame.seq === event.seq, 'NATIVE_KERNEL_FRAME_SEQUENCE_INVALID');
        const data = canonical(frame);
        invariant(Buffer.byteLength(data) < pageLimit, 'NATIVE_KERNEL_FRAME_TOO_LARGE');
        insert.run(runId, event.seq, data);
      }
    },
    read(runId, after) { return collect(page.iterate(runId, after), pageLimit); },
    tail(runId) { return collect(tail.iterate(runId), tailLimit).reverse(); },
  };
}
