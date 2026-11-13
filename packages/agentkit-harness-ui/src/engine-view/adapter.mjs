// agentkit.engine-event/v1 -> harness-ui protocol v1.
//
// Pure and React-free. The engine projects its journal into engine events; this
// adapter turns them into the timeline's own event stream. It is deterministic
// and keyed by engine sequence numbers, so replaying any prefix is a no-op.
import { PROTOCOL_VERSION } from "../protocol.mjs";
import { toolIdentity } from "../tool-identity.mjs";

export const ENGINE_EVENT_SCHEMA = "agentkit.engine-event/v1";
export const ENGINE_VIEW_CONTRACT = "agentkit.engine-view/v1";
export const FINAL_SUBMISSION_TOOL = "submit_final_output";

const OUTCOMES = new Set(["completed", "unverified", "blocked", "failed", "cancelled"]);
const text = value => typeof value === "string" && value.trim().length > 0;
const input = value => value === undefined || value === null ? {} : typeof value === "object" ? value : { value };

function completedEditDisplay(event) {
  const kind = toolIdentity(event.title)?.family;
  const { ok, path, diff_additions: added, diff_deletions: removed } = event.result ?? {};
  if (!["edit", "write"].includes(kind) || ok !== true || !text(path)
    || ![added, removed].every(count => Number.isSafeInteger(count) && count >= 0)) return undefined;
  return { kind: "file_edit", files: [{ path, changeStat: { added, removed }, operationKind: kind === "write" ? "write" : "edit" }] };
}

function outcomeOf(event) {
  if (event.title === "failed" || event.status === "failed") return "failed";
  if (["canceled", "cancelled"].includes(event.title) || ["canceled", "cancelled"].includes(event.status)) return "cancelled";
  if (event.status === "verified") return "completed";
  if (OUTCOMES.has(event.status)) return event.status;
  return event.title === "completed" ? "completed" : "unverified";
}

function toolFailure(result, name) {
  const code = result?.error_type ?? result?.code ?? result?.error_code;
  const message = result?.error_message ?? result?.message;
  if (!text(code)) return { message: text(message) ? message : `工具 ${name ?? ""} 未成功`.trim() };
  const reason = code === 'command_policy_blocked' && result?.executed === false ? result.finding?.detail : undefined;
  return { code, ...(text(reason) ? { message: reason } : text(message) ? { message } : {}),
    ...(Number.isSafeInteger(result.failed_edit_index) && result.failed_edit_index >= 0
      ? { failed_edit_index: result.failed_edit_index } : {}) };
}

/** Convert one engine event; returns zero or more harness-ui events. */
export function engineEventToTimeline(event, { runId = "run", time, startedAt = time } = {}) {
  if (!event || event.schema !== ENGINE_EVENT_SCHEMA || !Number.isSafeInteger(event.seq)) return [];
  const v = PROTOCOL_VERSION, id = suffix => `${runId}:${event.seq}:${suffix}`;
  const thoughtId = typeof event.requestId === "string" && /^[a-f0-9]{64}$/.test(event.requestId)
    ? `${runId}:thought:${event.requestId}` : id("thought");
  switch (event.kind) {
    case "run.started":
      return [{ v, id: id("start"), type: "task.started", taskId: runId, runId, startedAt }];
    case "todo.initialized":
    case "todo.updated":
      return Object.hasOwn(event, "plan") ? [{ v, id: id("todo"), type: "plan.updated",
        items: event.plan?.items ?? [], completedCount: event.plan?.completedCount, totalCount: event.plan?.totalCount }] : [];
    case "effect.prepared":
    case "effect.settled":
      return event.category === "model" && event.title === "request"
        ? [{ v, id: id("model-request"), type: "model.request", active: event.kind === "effect.prepared",
          retry: event.kind === "effect.prepared" && event.retry === true,
          ...(event.purpose === "compaction" ? { purpose: "compaction" } : {}), itemId: thoughtId }]
        : [];
    case "model.completed": {
      const out = [];
      if (text(event.thinking)) out.push({ v, id: id("thought-done"), type: "thinking.done", itemId: thoughtId, text: event.thinking });
      // Commentary that accompanies tool calls is progress, not the answer.
      if (text(event.detail) && (event.title === "initial_plan" || Array.isArray(event.calls) && event.calls.length)) {
        const itemId = `${runId}:note:${event.seq}`;
        out.push({ v, id: id("note"), type: "text.delta", itemId, delta: event.detail },
          { v, id: id("note-done"), type: "text.done", itemId });
      }
      for (const call of Array.isArray(event.calls) ? event.calls : []) {
        if (!text(call?.callId) || !text(call?.name) || call.name === FINAL_SUBMISSION_TOOL) continue;
        out.push({ v, id: id(`call:${call.callId}`), type: "tool.scheduled", callId: call.callId, name: call.name, input: input(call.arguments) },
          { v, id: id(`run:${call.callId}`), type: "tool.started", callId: call.callId });
      }
      return out;
    }
    case "model.stream_interrupted":
      return text(event.thinking)
        ? [{ v, id: id("thought-done"), type: "thinking.done", itemId: thoughtId, text: event.thinking }]
        : [];
    case "tool.completed": {
      if (!text(event.callId)) return [];
      if (event.status === "uncertain") return [{ v, id: id("uncertain"), type: "tool.state",
        callId: event.callId, status: "uncertain" }];
      // Older engines stored the committed TodoWrite receipt but omitted the
      // separate checklist projection. Never infer progress from tool inputs.
      const display = event.status === "ok" ? completedEditDisplay(event) : undefined;
      if (event.status !== "ok") return [{ v, id: id("error"), type: "tool.error", callId: event.callId,
        error: toolFailure(event.result, event.title) }];
      const out = [{ v, id: id("result"), type: "tool.result", callId: event.callId, result: event.result ?? null,
        ...(display ? { display } : {}) }];
      if (event.title === "TodoWrite" && Array.isArray(event.result?.todos))
        out.push({ v, id: id("todo-receipt"), type: "plan.updated",
          items: event.result.todos.map((item, index) => ({ ...item, id: `todo:${index}` })) });
      return out;
    }
    case "model.retry_exhausted":
      return [{ v, id: id("paused"), type: "task.state", state: "paused", reason: "provider_unavailable",
        message: event.modelError }];
    case "run.terminal": {
      const out = [];
      const itemId = `${runId}:final`;
      if (text(event.detail)) {
        out.push({ v, id: id("final"), type: "text.delta", itemId, delta: event.detail }, { v, id: id("final-done"), type: "text.done", itemId });
      }
      if (event.title === "paused") return [...out, { v, id: id("paused"), type: "task.state", state: "paused", reason: event.reason ?? null }];
      if (event.title === "interrupted") return [{ v, id: id("finished"), type: "task.finished",
        outcome: "unverified", executionState: "interrupted", endedAt: time, reason: event.reason }];
      return [...out, { v, id: id("finished"), type: "task.finished", outcome: outcomeOf(event), endedAt: time,
        ...(out.length ? { finalAnswerId: itemId } : {}), ...(event.reason ? { reason: event.reason } : {}),
        ...(text(event.modelError) ? { error: event.modelError } : {}) }];
    }
    default:
      return [];
  }
}

export function engineEventsToTimeline(events, options) {
  return (Array.isArray(events) ? events : []).flatMap(event => engineEventToTimeline(event, options));
}

export function relativeDeliveryPath(path) {
  return typeof path === "string" && path.length <= 2048 && !/[\\:\u0000-\u001f\u007f?#]/u.test(path)
    && path.split("/").every(part => part && part !== "." && part !== "..");
}

/** Web cards come from the Run's manifest. Older Runs can name an HTML file
 * explicitly in the final answer; the host still has to confirm it exists. */
export function engineWebDeliveries(event) {
  if (event?.schema !== ENGINE_EVENT_SCHEMA || event.kind !== "run.terminal" || event.title !== "completed"
    || !text(event.detail)) return [];
  const declared = Array.isArray(event.deliverables) ? event.deliverables : [];
  const web = declared.find(item => item?.kind === "web" && relativeDeliveryPath(item.path)
    && /\.html?$/i.test(item.path) && (item.root === "." || relativeDeliveryPath(item.root)
      && item.path.startsWith(item.root + "/")));
  if (web) return [{ path: web.path, root: web.root }];
  if (declared.length) return [];

  const paths = new Set();
  for (const match of event.detail.matchAll(/`([^`\r\n]+)`|\]\(([^\s()]+)\)/g)) {
    const path = (match[1] ?? match[2]).replace(/^\.\//, "");
    if (relativeDeliveryPath(path) && !/[%<>]/.test(path) && /\.html?$/i.test(path)) paths.add(path);
    if (paths.size >= 8) break;
  }
  return [...paths].map(path => ({ path }));
}
