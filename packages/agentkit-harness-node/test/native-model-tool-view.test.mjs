import test from 'node:test';
import assert from 'node:assert/strict';
import { localCommandToolDefinitions } from '../src/native/local-command-tools.mjs';
import { modelToolView } from '../src/native/model-tool-view.mjs';
import { projectMessagesAnthropic } from '../src/native/model-anthropic.mjs';
import { projectMessagesOpenAI } from '../src/native/model-openai-chat.mjs';
import { projectMessagesResponses } from '../src/native/model-responses.mjs';

const localTools = localCommandToolDefinitions();
const terminal = { ok: true, backend: 'sandbox/local_process', sandbox_id: 'local_process:session',
  command: 'echo example', controls: { status: 'applied' }, status: 'completed', exit_code: 0,
  task_id: 'a'.repeat(64), stdout_cursor: 4096, stderr_cursor: 0,
  output_may_be_truncated: true, stdout: 'preview',
  instruction: 'Use read_command_output with task_id' };

const projectors = [
  ['OpenAI Chat', request => projectMessagesOpenAI(request).at(-1).content],
  ['Anthropic', request => projectMessagesAnthropic(request).items.at(-1).content[0].content],
  ['Responses', request => projectMessagesResponses(request).items.at(-1).output],
];
function modelInput(name, content, tools) {
  return { profile: {}, tools, messages: [
    { role: 'user', content: 'Inspect the outcome.' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'c1', name, arguments: {} }] },
    { role: 'tool', callId: 'c1', content },
  ] };
}

for (const [protocol, project] of projectors) {
  test(`${protocol} keeps paging handles for completed local commands and their output pages`, () => {
    const raw = JSON.stringify(terminal);
    const request = modelInput('run_command', raw, localTools);
    const { command, controls, sandbox_id, ...expected } = terminal;
    assert.deepEqual(JSON.parse(project(request)), expected);
    assert.equal(request.messages[2].content, raw);

    const page = JSON.stringify({ status: 'completed', exit_code: 0, task_id: terminal.task_id,
      stdout: 'next preview', stdout_cursor: 8192, stderr_cursor: 0, output_may_be_truncated: true });
    assert.equal(project(modelInput('read_command_output', page, localTools)), page);
  });

  test(`${protocol} preserves external results, even when their fields resemble local receipts`, () => {
    const raw = '{ "backend":"sandbox/local_process","contract":"inventory/v2","available":false,"entries":[{"path":"reports","quantity":6}],"size_bytes":12 }';
    assert.equal(project(modelInput('mcp_inventory', raw, localTools)), raw);
    const hostCommand = [{ name: 'run_command', contextRole: 'none', permissions: [] }];
    assert.equal(project(modelInput('run_command', raw, hostCommand)), raw);
    const workspaceRead = '{"ok":true,"path":"a.txt","content":"page","next_start_line":9,"partial":true}';
    assert.equal(project(modelInput('read_workspace_file', workspaceRead, localTools)), workspaceRead);
  });
}

test('local receipts with integers that would lose precision pass through verbatim', () => {
  const inexact = '{"backend":"sandbox/local_process","controls":{},"value":9007199254740993}';
  const exact = '{"backend":"sandbox/local_process","controls":{},"value":1700000000000000000}';
  assert.equal(modelToolView(inexact, 'run_command', localTools), inexact);
  assert.equal(modelToolView(exact, 'run_command', localTools), '{"backend":"sandbox/local_process","value":1700000000000000000}');
});
