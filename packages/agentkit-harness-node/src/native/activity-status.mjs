import { createHash } from 'node:crypto';
import { canonical, projectBackgroundCommands } from '@kingsoftcloud/agentkit-harness-core';

const settledCommandStates = new Set(['completed', 'failed', 'canceled', 'timed_out', 'output_limit']);

/** Project a committed retry deadline at the Host's current time. This is a
 * display fact only; it cannot schedule, resume or extend a model request. */
export function nativeModelRetryWait(snapshot, { driving = false, now = Date.now() } = {}) {
  if (!driving || !snapshot || !['preparing_context', 'compacting'].includes(snapshot.phase)
    || snapshot.pendingIntent !== null || !Number.isFinite(now)
    || !Number.isFinite(snapshot.retryNotBefore) || snapshot.retryNotBefore <= now) return null;
  return { contract: 'agentkit.native-model-retry-wait/v1', notBefore: snapshot.retryNotBefore };
}

/** A completed foreground launch has no later background notification. Its
 * exact committed launch receipt is already a lifecycle fact, not a liveness
 * guess from a task ID, a notified bit or model-visible output text. */
function foregroundReceiptState(record, ref, intent) {
  if (ref.sourceRunId !== record.snapshot.runId || intent?.kind !== 'tool'
    || intent.payload.calls?.length !== 1) return null;
  const definition = record.configuration?.tools.find(tool => tool.name === intent.payload.calls[0].name);
  if (definition?.backgroundCommandPolicy !== 'owned-command-launch/v1') return null;
  const receipt = record.receipts?.find(row => row.operationKey === ref.operationKey);
  const results = receipt?.result?.results;
  const result = results?.length === 1 ? results[0] : null;
  if (receipt?.status !== 'committed' || result?.status !== 'ok'
    || result.backgroundCommandFinished !== true || !result.backgroundCommandRef
    || canonical(result.backgroundCommandRef) !== canonical(ref)
    || result.content?.task_id !== ref.taskId || result.content.evidence_incomplete === true
    || !settledCommandStates.has(result.content.status)) return null;
  return result.content.status;
}

/** A bounded presentation of the committed task checklist. */
export function nativeTodoPlan(todos) {
  if (!todos.length) return null;
  const occurrences = new Map();
  const items = todos.slice(0, 512).map(todo => {
    const digest = createHash('sha256').update(todo.content).digest('hex');
    const occurrence = occurrences.get(digest) ?? 0; occurrences.set(digest, occurrence + 1);
    return { id: `todo:${digest}:${occurrence}`, content: todo.content, status: todo.status };
  });
  return { items, completedCount: todos.filter(todo => todo.status === 'completed').length,
    totalCount: todos.length, omittedItems: Math.max(0, todos.length - items.length) };
}

/** Content and lifecycle facts from committed task state; no control authority. */
export function nativeActivityStatus(record, { driving = false } = {}) {
  if (!record) return null;
  const { snapshot } = record;
  const observations = new Map();
  for (const event of record.events ?? []) if (event.kind === 'background.commands_observed')
    for (const command of event.payload.commands ?? []) observations.set(command.taskId, command);
  const commands = snapshot.backgroundCommands ?? [];
  const intents = new Map(record.intents.map(intent => [intent.operationKey, intent]));
  const terminals = projectBackgroundCommands(commands, 128).map(({ ref }) => {
    const observed = observations.get(ref.taskId);
    const intent = intents.get(ref.operationKey);
    const calls = intent?.payload.calls ?? [];
    const call = calls.length === 1 ? calls[0] : null;
    return { id: ref.taskId, runId: snapshot.runId,
      title: call?.arguments.command?.slice(0, 512) || ref.taskId,
      state: observed?.status ?? foregroundReceiptState(record, ref, intent) ?? 'unknown', canCancel: false };
  });
  return { contract: 'agentkit.native-activity-status/v1', runId: snapshot.runId, snapshotRevision: snapshot.revision,
    isRunning: driving, plan: nativeTodoPlan(snapshot.todos?.items ?? []),
    terminals, omittedTerminals: commands.length - terminals.length };
}
