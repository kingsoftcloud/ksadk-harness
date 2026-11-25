import test from 'node:test';
import assert from 'node:assert/strict';
import { modelToolView } from '../src/native/model-tool-view.mjs';
import { projectMessagesOpenAI } from '../src/native/model-openai-chat.mjs';

test('a finished command drops Host-only fields and the echoed command text', () => {
  const receipt = { backend: 'sandbox/local_process', cancel_requested: false, command: "cat > a.js <<'EOF'\nlong\nEOF",
    controls: { applied: { addressSpaceBytes: 1 }, failed: [], status: 'applied' }, evidence_incomplete: false, exit_code: 1,
    instruction: 'Use read_command_output with task_id', observed_exit_code: null, ok: true, output_may_be_truncated: false,
    process_timeout_seconds: 900, sandbox_id: 'local_process:x', status: 'failed', stderr: 'boom', stdout: 'out',
    stdout_cursor: 3, task_id: 'cmd-1', workspace_observation: { revision: 'sha256:x', status: 'captured' } };
  assert.deepEqual(JSON.parse(modelToolView(JSON.stringify(receipt))), { exit_code: 1, status: 'failed', stderr: 'boom', stdout: 'out' });
});

test('a running command keeps the handles needed to page its output', () => {
  const view = JSON.parse(modelToolView(JSON.stringify({ status: 'running', task_id: 'cmd-2', stdout_cursor: 0,
    instruction: 'Use read_command_output with task_id', ok: true, backend: 'b' })));
  assert.deepEqual(view, { status: 'running', task_id: 'cmd-2', stdout_cursor: 0, instruction: 'Use read_command_output with task_id' });
});

test('a successful read is shown as text; failures and errors stay structured', () => {
  const read = { content: '1 | a\n2 | b', end_line: 2, line_count: 2, mtime_ns: 1.7e18, ok: true, partial: false, path: 'src/a.js',
    preview_chars: 9, read_range: { start: 1, end: 2 }, size: 4, size_bytes: 4, start_line: 1, suggested_action: '', total_lines: 2, truncated: false };
  assert.equal(modelToolView(JSON.stringify(read)), '[src/a.js lines 1-2 of 2]\n1 | a\n2 | b');
  assert.equal(modelToolView(JSON.stringify({ ...read, truncated: true })), '[src/a.js lines 1-2 of 2 (truncated)]\n1 | a\n2 | b');
  const failed = JSON.parse(modelToolView(JSON.stringify({ ok: false, code: 'not_found', path: 'x', mtime_ns: 1 })));
  assert.deepEqual(failed, { ok: false, code: 'not_found', path: 'x' });
});

test('directory listings omit repository metadata entries and per-entry timestamps', () => {
  const entries = [{ path: '.git', type: 'directory', mtime_ns: 1, size: 0 }, { path: '.git/HEAD', type: 'file', mtime_ns: 1, size: 23 },
    { path: 'src', type: 'directory', mtime_ns: 1, size: 0 }, { path: 'src/a.js', type: 'file', mtime_ns: 1, size: 9 }];
  assert.deepEqual(JSON.parse(modelToolView(JSON.stringify({ ok: true, path: '.', recursive: true, truncated: false, entries }))),
    { path: '.', recursive: true, entries: ['src/', 'src/a.js'], git_entries_omitted: 2 });
});

test('non-JSON text and receipts with integers beyond 2^53 pass through verbatim', () => {
  assert.equal(modelToolView('plain output'), 'plain output');
  const exact = '{"ok":true,"backend":"b","value":9007199254740993}';
  assert.equal(modelToolView(exact), exact);
  // A large integer that survives a round trip unchanged is safe to re-serialize.
  assert.equal(modelToolView('{"ok":true,"backend":"b","n":1700000000000000000}'), '{"n":1700000000000000000}');
  assert.equal(modelToolView('{"ok":true,"s":"9007199254740993","backend":"b"}'), '{"s":"9007199254740993"}');
});

test('the openai-chat wire carries the compact view and leaves the stored receipt unchanged', () => {
  const content = JSON.stringify({ ok: true, exit_code: 0, stdout: 'hi', status: 'completed', backend: 'b', command: 'echo hi' });
  const messages = [{ role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'c1', name: 'run_command', arguments: { command: 'echo hi' } }] },
    { role: 'tool', callId: 'c1', content }];
  const wire = projectMessagesOpenAI({ messages, profile: {} });
  assert.equal(wire.at(-1).content, '{"exit_code":0,"stdout":"hi","status":"completed"}');
  assert.equal(messages[2].content, content);
});
