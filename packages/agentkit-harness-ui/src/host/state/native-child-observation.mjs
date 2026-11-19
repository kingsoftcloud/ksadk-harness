import { initialState, reduce } from '@kingsoftcloud/agentkit-harness-ui/reducer';
import { FINAL_SUBMISSION_TOOL } from '../../engine-view/adapter.mjs';

/** Product transport mapping. The standalone UI never calls a Native store. */
export function nativeChildObservationState(detail) {
  const value = detail?.observation, task = detail?.task;
  if (value?.contract !== 'agentkit.native-child-observation/v1' || value.runId !== task?.childRunId
    || value.sessionId !== task?.sessionId || !Array.isArray(value.rows)) throw Error('子会话过程与原任务不一致');
  let state = initialState(), seq = 0;
  const emit = (type, body) => { state = reduce(state, { v: 1, id: `${value.snapshotRevision}:${seq++}`, type, ...body }); };
  emit('task.started', { taskId: value.runId, runId: value.runId });
  if (value.prompt?.text) emit('text.done', { itemId: 'prompt', role: 'user', text: value.prompt.text });
  const finalText = value.phase === 'completed' && task.resultAvailable === true
    && detail.offset === 0 && typeof detail.text === 'string' && detail.text.trim() ? detail.text : '';
  const lastText = value.rows.findLast(row => row.kind === 'text');
  const remainingChars = finalText && detail.complete === false && Number.isSafeInteger(detail.totalChars)
    && Number.isSafeInteger(detail.nextOffset) ? Math.max(0, detail.totalChars - detail.nextOffset) : 0;
  for (const row of value.rows) {
    // The result page carries the settled answer. The internal submission stays in the ledger.
    if (row.kind === 'tool' && row.name === FINAL_SUBMISSION_TOOL) continue;
    if (finalText && row === lastText && (row.text?.trim() === finalText.trim()
      || row.omittedChars > 0 && finalText.startsWith(row.text)
      || remainingChars > 0 && row.text?.startsWith(finalText))) continue;
    if (row.kind === 'text' || row.kind === 'thought') emit(row.kind === 'text' ? 'text.done' : 'thinking.done', { itemId: row.id, text: row.text });
    if (row.kind === 'tool') {
      let input = {}; try { input = JSON.parse(row.input?.text); } catch { /* truncated preview remains an incomplete input */ }
      emit('tool.scheduled', { callId: row.id, name: row.name, input });
      if (row.status === 'completed') emit('tool.result', { callId: row.id, result: row.result?.text ?? null, display: row.display });
      else if (row.status === 'failed') emit('tool.error', { callId: row.id, error: row.result?.text });
      else if (['waiting', 'uncertain', 'interrupted'].includes(row.status)) emit('tool.state', { callId: row.id, status: row.status });
    }
  }
  if (value.live?.thinking) emit('thinking.delta', { itemId: `live-thought:${value.live.operationKey}`, delta: value.live.thinking });
  if (value.live?.text) emit('text.delta', { itemId: `live-text:${value.live.operationKey}`, delta: value.live.text });
  if (finalText) emit('text.done', { itemId: 'final-answer', text: finalText });
  if (['completed', 'failed', 'canceled'].includes(value.phase)) emit('task.finished', {
    outcome: value.phase === 'failed' ? 'failed' : value.phase === 'canceled' ? 'cancelled' : value.outcome === 'verified' ? 'completed'
      : value.outcome === 'blocked' ? 'blocked' : 'unverified',
    verificationRequired: value.outcome === 'unverified',
    ...(value.phase === 'completed' && state.items.at(-1)?.kind === 'text'
      ? { finalAnswerId: state.items.at(-1).id } : {}),
  });
  else if (['awaiting_interaction', 'awaiting_reconciliation', 'created'].includes(value.phase)) emit('task.state', { state: 'waiting' });
  else if (!value.driving) emit('task.state', { state: 'interrupted' });
  return { state, workspaceView: value.workspaceView, omittedRows: value.omittedRows, omittedChars: (value.prompt?.omittedChars ?? 0)
    + value.rows.reduce((sum, row) => sum + (row.omittedChars ?? 0) + (row.input?.omittedChars ?? 0) + (row.result?.omittedChars ?? 0), 0)
    + (value.live?.omittedChars ?? 0) + remainingChars };
}
