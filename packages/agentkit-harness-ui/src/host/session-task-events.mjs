import { initialState, reduce } from '@kingsoftcloud/agentkit-harness-ui/reducer';
import { previewToolInput } from '@kingsoftcloud/agentkit-harness-ui/input-preview';
import { nativeRunIsInactive } from './state/native-outcome.mjs';
import { ENGINE_EVENT_SCHEMA, FINAL_SUBMISSION_TOOL, engineEventToTimeline, engineWebDeliveries } from '../engine-view/adapter.mjs';

const textOf = content => (Array.isArray(content) ? content : []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const nativeInterruptionMessages = Object.freeze({
  NATIVE_BACKGROUND_RESULT_UNKNOWN: '已结束等待，原命令结果仍未知；不会重跑。',
  NATIVE_READ_INTERRUPTED: '读取结果未确认；本轮已停止，需要获取新的观察结果。',
  NATIVE_RESOURCE_RESULT_UNKNOWN: '旧浏览器已隔离，原操作结果仍未知；后续必须获取新观察。',
});

const outcomeFact = (fact, callId, turn, sessionId, status) => fact?.contract === 'agentkit.native-tool-outcome/v1'
  && fact.status === status && typeof fact.runId === 'string' && fact.runId
  && typeof fact.sessionId === 'string' && fact.sessionId && (!sessionId || fact.sessionId === sessionId)
  && typeof fact.callId === 'string' && fact.callId && fact.callId === callId
  && Number.isSafeInteger(fact.turn) && fact.turn === turn;
const uncertainFact = (fact, callId, turn, sessionId) => outcomeFact(fact, callId, turn, sessionId, 'uncertain');

/** Enrich old Session projections from scoped journal facts without rewriting them. */
export function nativeHistoricalToolState(state, status, turn, sessionId) {
  const view = status?.uncertainTools;
  if (view?.contract !== 'agentkit.native-session-tool-outcomes/v1' || view.sessionId !== sessionId || !Array.isArray(view.facts)) return state;
  let changed = false;
  const items = state.items.map(item => {
    if (item.kind !== 'tool') return item;
    const fact = view.facts.find(fact => ['uncertain', 'not_dispatched'].includes(fact.status)
      && outcomeFact(fact, item.callId, turn, sessionId, fact.status));
    if (!fact) return item;
    changed = true;
    return { ...item, status: fact.status, progress: fact.status === 'uncertain' ? '执行结果未知，需要核对回执' : null };
  });
  return changed ? { ...state, items } : state;
}
const commandTools = new Set(['run_command', 'read_command_output']);

function commandDisplay(name, value) {
  if (!commandTools.has(name) || !value || typeof value !== 'object'
    || typeof value.stdout !== 'string' && typeof value.stderr !== 'string') return undefined;
  return { kind: 'command_output', stdout: value.stdout ?? '', stderr: value.stderr ?? '',
    ...(Number.isInteger(value.exit_code) ? { exit: value.exit_code } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}) };
}

/** Transport adapter only. The package owns lifecycle and presentation. */
function admittedContextMarker(event, sessionId) {
  const data = event.data, marker = data?.marker;
  if (!sessionId || event.ignorable !== true || Object.hasOwn(event, 'surfaceOp')
    || data?.contract !== 'agentkit.native-context-presentation/v1' || data.sessionId !== sessionId
    || typeof data.runId !== 'string' || !data.runId.trim() || data.runId.length > 256
    || !Number.isSafeInteger(data.turn) || data.turn < 1 || !/^ak-native-[a-f0-9]{64}$/.test(marker?.id ?? '')
    || !['completed', 'failed', 'interrupted'].includes(marker.status) || marker.origin !== 'auto'
    || !['start', 'tool', 'message'].includes(marker.after?.kind)
    || marker.after.kind !== 'start' && !/^ak-native-[a-f0-9]{64}$/.test(marker.after.id ?? '')) return null;
  return data;
}

export function createSessionTaskProjector({ sessionId } = {}) {
  let revision = -1, previousWindow = null, tasks = new Map(), result = [], activeTurn = null, settledSteps = new Set(), previews = new Map(), finalAnswers = new Map(), dispositions = new Map(), engineTurns = new Map(), replies = new Map();
  let settledEngineThoughts = new Set();
  const apply = entry => {
    const event = entry.event, data = event?.data;
    if (!event || !data) return;
    if (event.type === 'agentkit-native/tool-outcome') {
      const previous = tasks.get(data.turn);
      if (event.ignorable !== true || !outcomeFact(data, data.callId, data.turn, sessionId, 'not_dispatched')
        || !previous || previous.runId && previous.runId !== data.runId
        || !previous.items.some(item => item.kind === 'tool' && item.callId === data.callId)) return;
      dispositions.set(`${data.turn}:${data.callId}`, data);
      const next = reduce(previous, { v: 1, type: 'tool.state', id: `disposition:${data.runId}:${data.callId}:${event.seq}`,
        callId: data.callId, status: data.status });
      tasks.set(data.turn, { ...next, runId: data.runId });return;
    }
    if (event.type === 'agentkit-native/context-marker') {
      const observation = admittedContextMarker(event, sessionId), previous = observation && tasks.get(observation.turn);
      if (!previous || previous.runId && previous.runId !== observation.runId) return;
      const next = reduce(previous, { v: 1, type: 'context.marker',
        id: `context:${observation.runId}:${observation.marker.id}:${observation.marker.status}`, marker: observation.marker });
      tasks.set(observation.turn, { ...next, runId: observation.runId });
      return;
    }
    if (Number.isSafeInteger(data.turn)) activeTurn = data.turn;
    const turn = Number.isSafeInteger(data.turn) ? data.turn : activeTurn;
    if (!Number.isSafeInteger(turn)) return;
    let task = tasks.get(turn);
    if (!task) task = reduce(initialState(), { v: 1, type: 'task.started', id: `turn:${turn}`, taskId: String(turn),
      ...(event.type === 'turn/start' ? { startedAt: event.time } : {}) });
    const prefix = `${turn}:${data.step ?? 0}`, source = `${entry.type}:${event.seq}`;
    const engineBlock = index => `${turn}:engine-thought:${index}`;
    const responseId = typeof sessionId === 'string' && sessionId && Number.isSafeInteger(data.step) && data.step > 0
      ? JSON.stringify([sessionId, turn, data.step]) : null;
    // The host retains successful attempt frames until step/end so its own
    // tool dispatcher can still resolve preview identities. A committed
    // message already owns our transcript. Its compact content positions may
    // differ from provider stream positions (tools can arrive before text).
    if (event.type === 'assistant/live-chunk' && settledSteps.has(prefix)) return;
    let index = 0;
    const emit = (type, value) => { task = reduce(task, { v: 1, type, id: `${source}:${index++}`, ts: event.time, ...value }); };
    if (event.type === 'turn/start' && task.taskStartedAt === null) emit('task.started', { taskId: String(turn), startedAt: event.time });
    if (event.type === 'agentkit/native-engine-event' && event.ignorable === true
      && typeof data.runId === 'string' && data.runId && data.event?.schema === ENGINE_EVENT_SCHEMA
      && Number.isSafeInteger(data.event.seq)) {
      const previous = engineTurns.get(turn);
      if (previous && (previous.runId !== data.runId || previous.seq >= data.event.seq)) return;
      const terminal = data.event.kind === 'run.terminal';
      engineTurns.set(turn, { runId: data.runId, seq: data.event.seq, terminal,
        ...(terminal ? { deliveries: engineWebDeliveries(data.event).map(item => ({ ...item, seq: event.seq })),
          ...(data.event.title === 'completed' ? { deliverySeq: event.seq } : {}) } : {}) });
      if (Number.isSafeInteger(data.settledThinkingBlock) && data.settledThinkingBlock >= 0)
        settledEngineThoughts.add(engineBlock(data.settledThinkingBlock));
      for (const frame of engineEventToTimeline(data.event, { runId: data.runId, time: event.time, startedAt: task.taskStartedAt ?? event.time }))
        task = reduce(task, frame);
      tasks.set(turn, task);
      return;
    }
    const block = (value, position, done = true, sourceMessageId) => {
      const itemId = `${prefix}:block:${position}`;
      if (value.type === 'text') emit(done ? 'text.done' : 'text.delta', { itemId, ...(responseId ? { responseId } : {}), ...(sourceMessageId ? { sourceMessageId } : {}), ...(done ? { text: value.text } : { delta: value.text }) });
      if (value.type === 'reasoning') emit(done ? 'thinking.done' : 'thinking.delta', { itemId, ...(responseId ? { responseId } : {}), ...(sourceMessageId ? { sourceMessageId } : {}), ...(done ? { text: value.text } : { delta: value.text }) });
    };
    if (event.type === 'user/message' && ['user', 'user-rpc'].includes(data.source?.kind))
      emit('text.done', { itemId: `user:${data.id ?? event.seq}`, text: textOf(data.content), role: 'user' });
    const engine = engineTurns.get(turn);
    if (event.type === 'agentkit/native-engine-tool-draft') {
      if (event.ignorable !== true || engine?.runId !== data.runId || !task.modelThinkingId
        || !/^[a-f0-9]{64}$/.test(data.requestId) || task.modelThinkingId !== `${data.runId}:thought:${data.requestId}`
        || !Array.isArray(data.tools) || data.tools.length > 16) return;
      for (const tool of data.tools) {
        if (!Number.isSafeInteger(tool?.index) || tool.index < 0 || typeof tool.name !== 'string'
          || !/^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(tool.name) || tool.name === FINAL_SUBMISSION_TOOL) continue;
        emit('tool.preview', { previewId: `${task.modelThinkingId}:draft:${tool.index}`, name: tool.name, responseId: task.modelThinkingId });
      }
      tasks.set(turn, task);
      return;
    }
    if (event.type === 'assistant/live-chunk' && engine) {
      const chunk = data.chunk;
      if (task.modelThinkingId && chunk?.type === 'reasoning-delta' && Number.isSafeInteger(chunk.index)
        && !settledEngineThoughts.has(engineBlock(chunk.index))
        && !task.items.some(item => item.kind === 'tool-preview' && item.responseId === task.modelThinkingId)) {
        emit('thinking.delta', { itemId: task.modelThinkingId, responseId: task.modelThinkingId, delta: chunk.text });
        tasks.set(turn, task);
      }
      return;
    }
    if (event.type === 'assistant/message') {
      const content = data.message?.content ?? [];
      const textIndex = content.findLastIndex(part => part.type === 'text' && part.text?.trim());
      const final = data.interrupted !== true && textIndex >= 0 && !content.some(part => part.type === 'tool-call');
      finalAnswers.set(turn, final ? `${prefix}:block:${textIndex}` : null);
      if (final) replies.set(turn, { messageId: data.message.id });
      else replies.delete(turn);
      if (engine && (task.finalAnswerId || !final)) return;
      content.forEach((part, i) => {
      block(part, i, true, data.message.id);
      // A host may publish the live dispatch before the committed assistant
      // message. Its exact call identity anchors the row after the model's
      // preceding content; arrival order does not define transcript order.
      if (part.type === 'tool-call' && typeof part.id === 'string') {
        const existing = task.items.find(item => item.kind === 'tool' && item.callId === part.id);
        if (existing) task = { ...task, items: [...task.items.filter(item => item !== existing), existing] };
      }
      });
    }
    if (event.type === 'assistant/live-chunk' && !engine) {
      const chunk = data.chunk;
      if (chunk?.type === 'text-delta') block({ type: 'text', text: chunk.text }, chunk.index, false);
      if (chunk?.type === 'reasoning-delta') block({ type: 'reasoning', text: chunk.text }, chunk.index, false);
      if (chunk?.type === 'block-end') block(chunk.block, chunk.index);
      if (chunk?.type === 'tool-call-delta') {
        const previewId = `preview:${data.attemptId}:${chunk.index}`;
        const previous = previews.get(previewId) ?? { text: '', receivedChars: 0, name: '' };
        const delta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : '';
        const next = { text: (previous.text + delta).slice(0, 128 * 1024), receivedChars: previous.receivedChars + delta.length,
          name: chunk.name || previous.name };
        previews.set(previewId, next);
        emit('tool.preview', { previewId, name: next.name, input: previewToolInput(next.text), receivedChars: next.receivedChars,
          ...(responseId ? { responseId } : {}) });
      }
    }
    if (event.type === 'tool/call' && !engine) {
      let input = {}; try { input = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments; } catch { /* incomplete arguments */ }
      emit('tool.scheduled', { callId: data.callId, name: data.name, input, ...(responseId ? { responseId } : {}) });
    }
    if (event.type === 'tool/result' && !engine) {
      const message = data.message;
      const text = textOf(message?.content); let value;
      try { value = JSON.parse(text); } catch { /* plain tool result */ }
      const name = task.items.find(item => item.callId === message?.toolCallId)?.name;
      const display = data.meta?.contract === 'agentkit.workspace-display/v1' ? data.meta.display
        : commandDisplay(name, value);
      const workspaceObservation = (name === 'read_workspace_file' || name === 'search_workspace_files') && value?.ok === true;
      if (dispositions.has(`${turn}:${message?.toolCallId}`)) emit('tool.state', { callId: message.toolCallId, status: 'not_dispatched' });
      else if (uncertainFact(data.meta?.nativeOutcome, message?.toolCallId, turn, sessionId) || value?.status === 'uncertain') emit('tool.state', { callId: message?.toolCallId, status: 'uncertain', message: '执行结果未知，需要核对回执' });
      else emit(message?.isError ? 'tool.error' : 'tool.result', { callId: message?.toolCallId,
        ...(message?.isError ? { error: text } : { result: workspaceObservation ? value : text,
          ...(display ? { display } : {}) }) });
    }
    if (event.type === 'turn/end') {
      const reason = data.reason;
      if (replies.has(turn)) replies.set(turn, { ...replies.get(turn), time: event.time, seq: event.seq,
        branchable: reason?.kind === 'completed' });
      if (engine?.terminal && (task.finalAnswerId || !finalAnswers.get(turn) || reason?.kind !== 'completed')) return;
      if (engine && task.taskState === 'paused' && task.taskReason === 'provider_unavailable' && reason?.kind === 'error') return;
      const interruption = reason?.kind === 'error' && typeof reason.error?.code === 'string'
        && Object.hasOwn(nativeInterruptionMessages, reason.error.code) ? nativeInterruptionMessages[reason.error.code] : null;
      const outcome = interruption ? 'unverified' : reason?.kind === 'completed' ? 'unverified' : reason?.kind === 'blocked' ? 'blocked'
        : reason?.kind === 'aborted' ? 'cancelled' : reason?.kind === 'error' ? 'failed' : 'unverified';
      emit('task.finished', { outcome, ...(interruption ? { executionState: 'interrupted', summary: interruption }
        : { error: reason?.error?.message }), reason: reason?.error?.code, endedAt: event.time,
        ...(reason?.kind === 'completed' && finalAnswers.get(turn) ? { finalAnswerId: finalAnswers.get(turn) } : {}) });
    }
    tasks.set(turn, task);
  };
  return {
    project(window) {
      if (window.revision === revision) return result;
      let suffix = null;
      if (window.change?.kind === 'append' && previousWindow && window.revision > revision) {
        if (window.revision === revision + 1) suffix = window.change.entries;
        else {
          // React may observe several source publications in one render. The
          // last delta alone misses frames; replaying the whole history is
          // unnecessary when its immutable prefix is still exactly present.
          const previous = previousWindow.entries ?? [], next = window.entries ?? [];
          if (next.length >= previous.length && previous.every((entry, index) => next[index] === entry))
            suffix = next.slice(previous.length);
        }
      }
      const append = suffix !== null && !suffix.some(entry => entry.event?.type === 'assistant/message');
      if (!append) {
        tasks = new Map(); activeTurn = null; previews = new Map(); finalAnswers = new Map(); dispositions = new Map();
        engineTurns = new Map(); replies = new Map(); settledEngineThoughts = new Set();
        settledSteps = new Set((window.entries ?? []).filter(entry => entry.event?.type === 'assistant/message')
          .map(entry => `${entry.event.data.turn}:${entry.event.data.step ?? 0}`));
      }
      for (const entry of append ? suffix : window.entries ?? []) apply(entry);
      revision = window.revision;previousWindow = window;
      result = [...tasks].sort(([a], [b]) => a - b).map(([turn, state]) => ({
        turn, state, ...(replies.has(turn) ? { reply: replies.get(turn) } : {}),
        ...(state.finalAnswerId && engineTurns.get(turn)?.deliverySeq !== undefined
          ? { deliveries: engineTurns.get(turn).deliveries, deliverySeq: engineTurns.get(turn).deliverySeq } : {}),
      }));
      return result;
    },
  };
}

/** Native's committed outcome overrides the transport's coarser ending. */
export function nativeStatusForTurn(status, turn) {
  return Number.isSafeInteger(turn) && status?.presentationTurn === turn ? status : null;
}

export function nativeTaskState(state, status, running) {
  if (!status?.phase) return state;
  const active = !nativeRunIsInactive(status, running);
  let taskState = status.phase === 'completed' ? status.outcome === 'verified' ? 'completed'
    : status.outcome === 'blocked' ? 'blocked' : 'unverified'
    : status.phase === 'failed' ? 'failed' : status.phase === 'canceled' ? 'cancelled'
    : status.phase === 'interrupted' || !active && !['paused', 'awaiting_interaction', 'awaiting_reconciliation'].includes(status.phase)
        ? 'interrupted' : status.phase === 'paused' ? 'paused'
          : ['awaiting_interaction', 'awaiting_reconciliation'].includes(status.phase) ? 'waiting' : 'running';
  const toolStates = status.toolStates?.contract === 'agentkit.native-tool-states/v1' && status.toolStates.runId === status.runId
    ? new Map(status.toolStates.calls.map(call => [call.callId, call.status])) : new Map();
  const observations = status.commandPreviews;
  const previews = status.phase === 'executing_tools' && observations?.contract === 'agentkit.native-command-previews/v1'
    && observations.runId === status.runId && observations.sessionId === status.sessionId
    && Array.isArray(observations.calls) && observations.calls.length <= 16
    ? new Map(observations.calls.filter(call => typeof call.callId === 'string' && Number.isSafeInteger(call.sequence)
      && call.sequence > 0 && call.display?.kind === 'command_preview' && typeof call.display.stdout === 'string'
      && typeof call.display.stderr === 'string' && !Object.hasOwn(call.display, 'exit')
      && new TextEncoder().encode(call.display.stdout + call.display.stderr).length <= 65536)
      .map(call => [call.callId, { display: { kind: 'command_preview', stdout: call.display.stdout, stderr: call.display.stderr },
        truncated: call.truncated === true }])) : new Map();
  let presented = { ...state, items: state.items.map(item => item.kind === 'tool' && item.name === 'run_command'
      && !['completed', 'failed'].includes(item.status) && previews.has(item.callId)
      ? { ...item, status: 'running', display: previews.get(item.callId).display,
        progress: previews.get(item.callId).truncated ? '运行中的输出预览已截断' : null } : item.kind === 'tool' && toolStates.has(item.callId)
      ? item.status === toolStates.get(item.callId) ? item : { ...item, status: toolStates.get(item.callId) } : item.kind === 'tool-preview' && taskState !== 'running'
      ? { ...item, streaming: false } : item.kind === 'tool' && ['scheduled', 'running'].includes(item.status)
      && ['interrupted', 'waiting', 'paused', 'cancelled', 'failed', 'unverified', 'completed'].includes(taskState)
      ? { ...item, status: taskState === 'waiting' ? 'waiting' : 'interrupted' } : item),
    runId: status.runId, taskState, taskOutcome: status.outcome,
    verificationRequired: typeof status.verificationRequired === 'boolean' ? status.verificationRequired : state.verificationRequired,
    taskReason: status.reason, taskError: status.error?.message ?? null };
  if (status.contextStatus?.contract === 'agentkit.native-context-status/v1' && status.contextStatus.runId === status.runId)
    for (const marker of status.contextStatus.markers ?? []) presented = reduce(presented, {
      v: 1, type: 'context.marker', id: `context:${status.runId}:${marker.id}:${marker.status}`, marker,
    });
  return presented;
}

/** Match children only by their authenticated owning tool call, never by order or role. */
export function bindNativeSubagents(state, tasks) {
  let next = state;
  for (const task of tasks ?? []) {
    if (!task.parentToolCallId || !state.items.some(item => item.kind === 'tool' && item.callId === task.parentToolCallId)) continue;
    next = reduce(next, { v: 1, type: 'subagent.bound', id: `child:${task.childRunId}:${task.snapshotRevision}`,
      callId: task.parentToolCallId, child: { runId: task.childRunId, sessionId: task.sessionId, parentRunId: task.parentRunId,
        role: task.role, title: task.goalPreview, phase: task.phase, activity: task.activity } });
  }
  return next;
}
