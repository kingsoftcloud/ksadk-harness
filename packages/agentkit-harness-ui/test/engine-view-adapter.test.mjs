import test from "node:test";
import assert from "node:assert/strict";
import { engineEventsToTimeline, engineWebDeliveries } from "../src/engine-view/adapter.mjs";
import { initialState, reduceAll } from "../src/reducer.mjs";
import { buildViewModel } from "../src/view.mjs";
import { engineStatusPanelModel } from "../src/host/state/native-status-panel.mjs";
import { toolErrorSummary } from "../src/tool-error.mjs";

const e = (seq, kind, extra = {}) => ({ schema: "agentkit.engine-event/v1", seq, kind, category: kind.split(".")[0], ...extra });
const run = [
  e(1, "run.started"),
  e(5, "model.completed", { title: "tool_calls", detail: "Writing the file now.", tools: ["write_workspace_file"],
    calls: [{ callId: "c1", name: "write_workspace_file", arguments: { path: "out.txt", content: "hi" } }] }),
  e(7, "tool.completed", { title: "write_workspace_file", status: "ok", callId: "c1",
    result: { ok: true, path: "out.txt", diff_additions: 1, diff_deletions: 0 } }),
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
  assert.deepEqual(state.items[1].display.files[0].changeStat, { added: 1, removed: 0 });
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

test("the model request shows a thinking indicator only while it is pending", () => {
  let state = reduceAll(initialState(), [
    ...engineEventsToTimeline([e(1, "run.started")]),
    { v: 1, id: "user", itemId: "prompt", type: "text.done", role: "user", text: "Run a task." },
  ]);
  const showsThinking = () => JSON.stringify(buildViewModel(state)).includes('"data-testid":"model-thinking"');
  const apply = (...events) => { state = reduceAll(state, engineEventsToTimeline(events)); };

  apply(e(2, "effect.prepared"));
  assert.equal(showsThinking(), false, "workspace activity does not imply a model request");
  const request = { category: "model", title: "request", requestId: "a".repeat(64) };
  apply(e(3, "effect.prepared", request));
  assert.equal(showsThinking(), true);
  assert.deepEqual(state.items.map(item => item.role), ["user"]);
  const thought = state.modelThinkingId;
  state = reduceAll(state, [{ v: 1, id: "live", itemId: thought, type: "thinking.delta", delta: "Live preview" }]);
  assert.equal(showsThinking(), false, "the rolling thought replaces the indicator");
  apply(e(4, "effect.settled", request), e(5, "model.completed", { ...request, thinking: "Complete thought" }));
  assert.equal(showsThinking(), false);
  assert.deepEqual(state.items.filter(item => item.kind === "thought").map(item => [item.id, item.streaming, item.text]),
    [[thought, false, "Complete thought"]]);
  apply(e(6, "effect.prepared", { ...request, requestId: "b".repeat(64) }));
  assert.equal(showsThinking(), true, "a later model call has its own indicator");
  apply(e(7, "run.terminal", { title: "canceled", status: "canceled" }));
  assert.equal(showsThinking(), false);
});

test("the retry indicator requires a new request; a terminal 400 stays visible without retrying", () => {
  const request = { category: "model", title: "request" };
  const apply = (...events) => { state = reduceAll(state, engineEventsToTimeline(events)); };
  const visible = () => JSON.stringify(buildViewModel(state, { locale: "zh-CN" }));
  let state = initialState();
  apply(e(1, "run.started"), e(2, "model.failure_observed", { status: "retrying" }));
  assert.doesNotMatch(visible(), /model-retry/);
  apply(e(3, "effect.prepared", { ...request, retry: true }));
  assert.match(visible(), /模型正在重试/);
  apply(e(4, "effect.settled", request), e(5, "model.failure_observed", { httpStatus: 400 }));
  assert.doesNotMatch(visible(), /model-retry/);
  const modelError = "模型网关拒绝了请求（HTTP 400），未自动重试。";
  apply(e(6, "run.terminal", { title: "failed", status: "failed", reason: "provider_terminal_error", modelError }));
  assert.equal(state.taskError, modelError);
  assert.equal(state.taskState, "failed");
});

test("a compaction request uses its own activity label and never looks like ordinary thinking", () => {
  const request = { category: "model", title: "request" };
  const events = [e(1, "run.started"), e(2, "effect.prepared", { ...request, purpose: "compaction" }),
    e(3, "effect.settled", request)];
  const compacting = reduceAll(initialState(), engineEventsToTimeline(events.slice(0, -1)));
  const visible = state => JSON.stringify(buildViewModel(state, { locale: "zh-CN" }));
  assert.match(visible(compacting), /正在压缩上下文/);
  assert.doesNotMatch(visible(compacting), /model-thinking/);
  assert.doesNotMatch(visible(reduceAll(compacting, engineEventsToTimeline(events))), /model-compaction/);
});

test("retry exhaustion pauses the task until a later model request starts", () => {
  const request = { category: "model", title: "request" };
  const modelError = "模型服务暂不可用，自动重试次数已用完。任务已暂停，可稍后继续。";
  const events = [e(1, "run.started"), e(2, "effect.prepared", { ...request, retry: true }),
    e(3, "effect.settled", request), e(4, "model.retry_exhausted", { modelError }), e(5, "effect.prepared", request)];
  const paused = reduceAll(initialState(), engineEventsToTimeline(events.slice(0, -1)));
  assert.equal(paused.taskState, "paused");
  assert.equal(paused.taskMessage, modelError);
  assert.doesNotMatch(JSON.stringify(buildViewModel(paused)), /model-retry/);
  const resumed = reduceAll(paused, engineEventsToTimeline(events));
  assert.equal(resumed.taskState, "running");
  assert.equal(resumed.taskMessage, null);
  assert.equal(resumed.modelRequestRetry, false);
});

test("independent runs display the last committed checklist, including after refresh", () => {
  const pending = { content: "Validate the game", status: "pending" };
  const [receipt, plan, clear] = [
    e(1, "tool.completed", { callId: "todo", title: "TodoWrite", status: "ok", result: { todos: [pending] } }),
    e(2, "todo.updated", { plan: { items: [{ ...pending, status: "completed", id: "stable" }], completedCount: 3, totalCount: 4 } }),
    e(3, "todo.updated", { plan: null }),
  ];
  const panel = (...events) => engineStatusPanelModel([{ state: reduceAll(initialState(), engineEventsToTimeline(events)) },
    { state: initialState() }], true);
  assert.equal(panel(receipt).plan.items[0].content, pending.content);
  assert.deepEqual(panel(receipt, plan).plan, {
    items: [{ ...pending, status: "completed", id: "stable", priority: null }],
    completedCount: 3, totalCount: 4, omittedItems: 3,
  });
  assert.equal(panel(receipt, plan, clear).plan, null);
});

test("a batch edit error retains the failed item index and reason", () => {
  const [event] = engineEventsToTimeline([e(1, "tool.completed", { callId: "edit", title: "multi_edit_workspace_file", status: "error",
    result: { error_type: "snippet_not_found", failed_edit_index: 2, nearby_candidates: [{ text: "file content" }] } })]);
  assert.equal(toolErrorSummary(event.error, { locale: "zh-CN" }), "第 3 项找不到原文，本批修改未写入");
  assert.equal(Object.hasOwn(event.error, "nearby_candidates"), false);
});

test("retryable edit errors stay in history and final submissions do not hold the process open", () => {
  const frames = [
    e(1, "run.started"),
    e(2, "model.completed", { calls: [{ callId: "edit", name: "multi_edit_workspace_file" }] }),
    e(3, "tool.completed", { callId: "edit", title: "multi_edit_workspace_file", status: "error",
      result: { error_type: "snippet_not_found", failed_edit_index: 2 } }),
    e(4, "model.completed", { detail: "重新读取原文后修正。", calls: [{ callId: "retry", name: "edit_workspace_file" }] }),
    e(5, "tool.completed", { callId: "retry", title: "edit_workspace_file", status: "ok" }),
    e(6, "model.completed", { calls: [{ callId: "submission", name: "submit_final_output" }] }),
    e(7, "run.terminal", { title: "completed", status: "unverified", detail: "可打开 `starark.html`。" }),
  ];
  const state = events => reduceAll(initialState(), engineEventsToTimeline(events));
  const running = JSON.stringify(buildViewModel(state(frames.slice(0, 5)), { locale: "zh-CN" }));
  assert.match(running, /重新读取原文后修正/);
  assert.doesNotMatch(running, /找不到原文/);
  const finished = state(frames);
  assert.equal(finished.items.find(item => item.callId === "edit")?.status, "failed");
  assert.ok(!finished.items.some(item => item.callId === "submission"));
  const folded = JSON.stringify(buildViewModel(finished));
  assert.match(folded, /work-history-toggle/);
  assert.doesNotMatch(folded, /重新读取原文后修正|找不到原文/);
  assert.match(JSON.stringify(buildViewModel(finished, { locale: "zh-CN", historyOpen: new Map([["work:run:start", true]]) })),
    /找不到原文/);
});

test("an edit argument error stays out of live progress and is available in expanded history", () => {
  const frames = [
    e(1, "run.started"),
    e(2, "model.completed", { calls: [{ callId: "edit", name: "multi_edit_workspace_file" }] }),
    e(3, "tool.completed", { callId: "edit", title: "multi_edit_workspace_file", status: "error",
      result: { code: "invalid_arguments", executed: false } }),
    e(4, "model.completed", { calls: [{ callId: "retry", name: "multi_edit_workspace_file", arguments: { path: "starark/test/harness.js" } }] }),
    e(5, "tool.completed", { callId: "retry", title: "multi_edit_workspace_file", status: "ok" }),
  ];
  const render = (events, options) => JSON.stringify(buildViewModel(
    reduceAll(initialState(), engineEventsToTimeline(events)), { locale: "zh-CN", ...options }));
  const validationError = /工具参数校验未通过/;
  assert.doesNotMatch(render(frames), validationError);
  assert.match(render(frames), /harness\.js/);
  const finished = [...frames, e(6, "run.terminal", { title: "completed", detail: "修改完成。" })];
  assert.doesNotMatch(render(finished), validationError);
  assert.match(render(finished, {
    historyOpen: new Map([["work:run:start", true]]),
    toolOpen: new Map([["activity:changes:edit", true]]),
  }), validationError);
  const failed = [...frames.slice(0, 3), e(4, "run.terminal", { title: "failed" })];
  assert.doesNotMatch(render(failed), validationError);
  assert.match(render(failed, { historyOpen: new Map([["work:run:start", true]]) }), validationError);
});

test("web delivery prefers the committed manifest and supports earlier final answers", () => {
  const final = e(10, "run.terminal", { title: "completed",
    detail: "打开 `starark.html`，请忽略 `../other.html` 和 [外部链接](https://example.com/x.html)。" });
  assert.deepEqual(engineWebDeliveries(final), [{ path: "starark.html" }]);
  assert.deepEqual(engineWebDeliveries({ ...final, deliverables: [{ kind: "web", root: "site", path: "site/pages/index.html" }] }),
    [{ path: "site/pages/index.html", root: "site" }]);
  assert.deepEqual(engineWebDeliveries({ ...final, title: "failed" }), []);
});

test("a policy-blocked terminal call shows one status and reveals its reason on demand", () => {
  const state = reduceAll(initialState(), engineEventsToTimeline([
    e(1, "run.started"),
    e(2, "model.completed", { calls: [{ callId: "blocked", name: "run_command", arguments: { command: "example command" } }] }),
    e(3, "tool.completed", { callId: "blocked", title: "run_command", status: "error", result: {
      error_type: "command_policy_blocked", executed: false, exit_code: 126, finding: { detail: "Example rule requires approval" },
    } }),
  ]));
  const render = options => JSON.stringify(buildViewModel(state, { locale: "zh-CN", ...options }));
  assert.match(render(), /未执行/);
  assert.doesNotMatch(render(), /执行失败|Example rule|exit 126/);
  const expanded = render({ toolOpen: new Map([["blocked", true]]) });
  assert.match(expanded, /Example rule requires approval/);
  assert.doesNotMatch(expanded, /command_policy_blocked|exit 126/);
});
