import test from "node:test";
import assert from "node:assert/strict";
import { engineEventsToTimeline } from "../src/engine-view/adapter.mjs";
import { initialState, reduceAll } from "../src/reducer.mjs";
import { buildViewModel } from "../src/view.mjs";

const e = (seq, kind, extra = {}) => ({ schema: "agentkit.engine-event/v1", seq, kind, category: kind.split(".")[0], ...extra });
const run = [
  e(1, "run.started"),
  e(5, "model.completed", { title: "tool_calls", detail: "Writing the file now.", tools: ["write_workspace_file"],
    calls: [{ callId: "c1", name: "write_workspace_file", arguments: { path: "out.txt", content: "hi" } }] }),
  e(7, "tool.completed", { title: "write_workspace_file", status: "ok", callId: "c1", result: { ok: true } }),
  e(8, "model.failure_observed", { detail: "transport_error", status: "retrying" }),
  e(9, "effect.prepared"),
  e(12, "run.terminal", { title: "completed", status: "unverified", detail: "Created out.txt." }),
];

test("an engine run becomes a replay-safe timeline the shared reducer renders", () => {
  const events = engineEventsToTimeline(run, { runId: "r1" });
  assert.ok(events.every(event => event.v === 1 && typeof event.id === "string"));
  const state = reduceAll(initialState(), events);
  assert.deepEqual(reduceAll(state, events), state, "replaying the same events is a no-op");
  const half = reduceAll(reduceAll(initialState(), events.slice(0, 4)), events);
  assert.deepEqual(half, state, "replaying a prefix then the whole run converges");
  assert.deepEqual(state.items.map(item => [item.kind, item.kind === "tool" ? item.status : item.text]),
    [["text", "Writing the file now."], ["tool", "completed"], ["text", "Created out.txt."]]);
  assert.equal(state.items[1].name, "write_workspace_file"); assert.deepEqual(state.items[1].input, { path: "out.txt", content: "hi" });
  assert.equal(state.taskOutcome, "unverified");
  assert.ok(JSON.stringify(buildViewModel(state)).includes("Created out.txt."));
});

test("failures, pauses and unknown events map conservatively", () => {
  const failed = engineEventsToTimeline([e(1, "run.started"), e(2, "model.completed", { calls: [{ callId: "c", name: "kb_search", arguments: "q" }] }),
    e(3, "tool.completed", { title: "kb_search", status: "error", callId: "c", result: { message: "offline" } }),
    e(4, "run.terminal", { title: "failed", status: "failed", reason: "provider_terminal_error" })], { runId: "r" });
  assert.deepEqual(failed.find(event => event.type === "tool.error").error, { message: "offline" });
  assert.deepEqual(failed.find(event => event.type === "tool.scheduled").input, { value: "q" });
  assert.equal(failed.at(-1).outcome, "failed"); assert.equal(failed.at(-1).reason, "provider_terminal_error");
  const paused = engineEventsToTimeline([e(1, "run.terminal", { title: "paused", reason: "provider_unavailable" })], { runId: "r" });
  assert.deepEqual(paused.map(event => [event.type, event.state]), [["task.state", "paused"]]);
  assert.deepEqual(engineEventsToTimeline([e(1, "something.new"), { schema: "other", seq: 2, kind: "run.started" }, null]), []);
  // A completed task never claims verification it did not report.
  assert.equal(engineEventsToTimeline([e(1, "run.terminal", { title: "completed" })])[0].outcome, "completed");
  assert.equal(engineEventsToTimeline([e(1, "run.terminal", { title: "completed", status: "unverified" })])[0].outcome, "unverified");
});
