// agentkit.engine-event/v1 -> harness-ui protocol v1.
//
// Pure and React-free. The engine projects its journal into engine events; this
// adapter turns them into the timeline's own event stream. It is deterministic
// and keyed by engine sequence numbers, so replaying any prefix is a no-op.
import { PROTOCOL_VERSION } from "../protocol.mjs";

export const ENGINE_EVENT_SCHEMA = "agentkit.engine-event/v1";
export const ENGINE_VIEW_CONTRACT = "agentkit.engine-view/v1";

const OUTCOMES = new Set(["completed", "unverified", "blocked", "failed", "cancelled"]);
const text = value => typeof value === "string" && value.trim().length > 0;
const input = value => value === undefined || value === null ? {} : typeof value === "object" ? value : { value };

function outcomeOf(event) {
  if (event.title === "failed" || event.status === "failed") return "failed";
  if (event.title === "cancelled" || event.status === "cancelled") return "cancelled";
  if (OUTCOMES.has(event.status)) return event.status;
  return event.title === "completed" ? "completed" : "unverified";
}

/** Convert one engine event; returns zero or more harness-ui events. */
export function engineEventToTimeline(event, { runId = "run" } = {}) {
  if (!event || event.schema !== ENGINE_EVENT_SCHEMA || !Number.isSafeInteger(event.seq)) return [];
  const v = PROTOCOL_VERSION, id = suffix => `${runId}:${event.seq}:${suffix}`;
  switch (event.kind) {
    case "run.started":
      return [{ v, id: id("start"), type: "task.started", taskId: runId, runId }];
    case "model.completed": {
      const out = [];
      // Commentary that accompanies tool calls is progress, not the answer.
      if (text(event.detail) && Array.isArray(event.calls) && event.calls.length) {
        const itemId = `${runId}:note:${event.seq}`;
        out.push({ v, id: id("note"), type: "text.delta", itemId, delta: event.detail },
          { v, id: id("note-done"), type: "text.done", itemId });
      }
      for (const call of Array.isArray(event.calls) ? event.calls : []) {
        if (!text(call?.callId) || !text(call?.name)) continue;
        out.push({ v, id: id(`call:${call.callId}`), type: "tool.scheduled", callId: call.callId, name: call.name, input: input(call.arguments) },
          { v, id: id(`run:${call.callId}`), type: "tool.started", callId: call.callId });
      }
      return out;
    }
    case "tool.completed": {
      if (!text(event.callId)) return [];
      return event.status === "ok"
        ? [{ v, id: id("result"), type: "tool.result", callId: event.callId, result: event.result ?? null }]
        : [{ v, id: id("error"), type: "tool.error", callId: event.callId,
          error: { message: typeof event.result?.message === "string" ? event.result.message : `工具 ${event.title ?? ""} 未成功`.trim() } }];
    }
    case "model.failure_observed":
      return [{ v, id: id("retry"), type: "task.state", state: "running", reason: "model_retry", message: `模型请求失败（${event.detail ?? "unknown"}），正在重试。` }];
    case "run.terminal": {
      const out = [];
      if (text(event.detail)) {
        const itemId = `${runId}:final`;
        out.push({ v, id: id("final"), type: "text.delta", itemId, delta: event.detail }, { v, id: id("final-done"), type: "text.done", itemId });
      }
      if (event.title === "paused") return [...out, { v, id: id("paused"), type: "task.state", state: "paused", reason: event.reason ?? null }];
      return [...out, { v, id: id("finished"), type: "task.finished", outcome: outcomeOf(event), ...(event.reason ? { reason: event.reason } : {}) }];
    }
    default:
      return [];
  }
}

export function engineEventsToTimeline(events, options) {
  return (Array.isArray(events) ? events : []).flatMap(event => engineEventToTimeline(event, options));
}
