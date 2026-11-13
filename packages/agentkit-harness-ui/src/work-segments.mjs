import { toolIdentity } from './tool-identity.mjs';

/** Completion is declared by the Host; a text row alone never closes a task.
 * This is a view over immutable transcript rows, not a second task lifecycle. */
export function conversationWorkSegments(state, items) {
  const segments = [];
  let segment = { id: `work:${state.taskId ?? 'task'}:start`, inputs: [], work: [] };
  for (const item of items) {
    if (item.kind === 'text' && item.role === 'user') {
      if (segment.work.length) { segments.push(segment); segment = { id: `work:${state.taskId ?? 'task'}:${item.id}`, inputs: [], work: [] }; }
      segment.inputs.push(item);
    } else segment.work.push(item);
  }
  if (segment.inputs.length || segment.work.length) segments.push(segment);
  const closed = ['completed', 'unverified'].includes(state.taskState) && !state.taskError;
  const ended = closed || ['failed', 'cancelled', 'interrupted'].includes(state.taskState);
  return segments.map((segment, index) => {
    const rows = segment.work;
    const candidate = rows.find(item => item.id === state.finalAnswerId)
      ?? (state.taskState === 'completed' && index === segments.length - 1 ? rows.at(-1) : null);
    const final = closed && candidate?.kind === 'text' && candidate.role !== 'user' && !candidate.streaming ? candidate : null;
    const answerIndex = final ? rows.findIndex(item => item.kind === 'text' && (item.id === final.id
      || final.sourceMessageId && item.sourceMessageId === final.sourceMessageId)) : -1;
    const process = answerIndex >= 0 ? rows.slice(0, answerIndex) : rows;
    return { ...segment, process, following: answerIndex >= 0 ? rows.slice(answerIndex) : [],
      collapsible: ended && process.length > 0 };
  });
}

/** Use only committed Host times. History without timing has a plain label. */
export function completedWorkLabel(state, locale) {
  const zh = String(locale ?? '').startsWith('zh');
  const start = state.taskStartedAt, end = state.taskEndedAt;
  if (![start, end].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) || end < start)
    return zh ? '已工作' : 'Worked';
  let seconds = Math.max(1, Math.round((end - start) / 1000));
  const parts = [];
  for (const [size, cn, en] of [[86400, '天', 'd'], [3600, '时', 'h'], [60, '分', 'm'], [1, '秒', 's']]) {
    const value = Math.floor(seconds / size); seconds %= size;
    if (value) parts.push(zh ? `${value} ${cn}` : `${value}${en}`);
  }
  return `${zh ? '已工作' : 'Worked'} ${parts.slice(0, 2).join(' ')}`;
}

export function interruptedWorkLabel(state, locale) {
  if (state.taskState !== 'interrupted') return null;
  const zh = String(locale ?? '').startsWith('zh');
  if (state.taskReason === 'effect_outcome_unknown') {
    const lastUncertain = state.items.findLast(item => item.kind === 'tool' && item.status === 'uncertain');
    const browser = lastUncertain && toolIdentity(lastUncertain.name).family === 'browser';
    return zh ? (browser ? '已中断：浏览器验收结果未确认' : '已中断：工具执行结果未确认')
      : (browser ? 'Interrupted: browser verification result unconfirmed' : 'Interrupted: tool result unconfirmed');
  }
  if (state.taskReason === 'browser_session_unavailable')
    return zh ? '已中断：浏览器会话不可用' : 'Interrupted: browser session unavailable';
  return zh ? '任务已中断' : 'Task interrupted';
}
