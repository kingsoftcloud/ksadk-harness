import { initialState } from '../reducer.mjs';

/** Only an exact durable request identity replaces its optimistic bubble.
 * Repeating the same text intentionally remains a distinct user message. */
export function pendingInputStates(inputs, eventWindow) {
  const candidates = (Array.isArray(inputs) ? inputs : []).filter(item => item?.placement === 'transcript');
  if (!candidates.length) return [];
  const committed = new Set((eventWindow?.entries ?? []).flatMap(entry => {
    const event = entry.event;
    return event?.type === 'user/message' && ['user', 'user-rpc'].includes(event.data?.source?.kind)
      && typeof event.data.source.rpcId === 'string' ? [event.data.source.rpcId] : [];
  }));
  const seen = new Set();
  return candidates.flatMap(item => {
    if (item?.placement !== 'transcript' || typeof item.requestId !== 'string'
      || committed.has(item.requestId) || seen.has(item.requestId) || typeof item.text !== 'string') return [];
    seen.add(item.requestId);
    return [{ requestId: item.requestId, state: { ...initialState(), items: [
      { kind: 'text', id: `pending:${item.requestId}`, role: 'user', text: item.text, streaming: false },
    ] } }];
  });
}
