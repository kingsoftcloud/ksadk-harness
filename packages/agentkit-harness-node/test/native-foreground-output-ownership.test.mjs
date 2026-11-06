import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeKernel, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeLocalCommandTools } from '../src/native/local-command-tools.mjs';
import { createOwnedCommandResolver, createOwnedCommandOutputReader,
  OWNED_COMMAND_OUTPUT_CONTRACT } from '../src/native/owned-command.mjs';

test('persisted foreground output remains owned and cursor-readable after a cold SQLite restore', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-foreground-owner-')));
  const workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  const stateRoot = join(root, 'commands'), database = join(root, 'runs.sqlite');
  let store = new SqliteRunStore(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const makeTools = () => createNativeLocalCommandTools({ workspaceRoot, stateRoot, sessionId: 'session',
    sourceEnv: { PATH: '/bin:/usr/bin' }, settings: { wallSeconds: 10 },
    outputPolicy: { version: 'persisted-stream/v1', previewBytes: 4096, persistedBytes: 65536 },
    authorize: async () => 'allow', resolveOwnedCommand: createOwnedCommandResolver({ scope, store }),
    captureWorkspace: () => ({ revision: digest('workspace'), entries: {} }) });
  let tools = makeTools(), paused = false;
  const { config, snapshot } = fixture({ tools: tools.definitions, limits: { effectTimeoutMs: 700000 } });
  const first = new NativeKernel({ store, digest, owner: 'first-owner', ports: {
    model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [
      { callId: 'launch', name: 'run_command', arguments: {
        command: "printf 'once\\n' >> launches; printf '%020000d' 0; printf '\\nVERIFY_FACT=retained\\n'", timeout: 10 },
      },
    ] }) }, tools,
  }, onCheckpoint: async current => {
    if (!paused && current.usage.toolCalls === 1 && current.phase === 'preparing_context') {
      paused = true; first.submit(scope, 'run', { commandId: 'pause-after-foreground', kind: 'pause', payload: {} });
    }
  } });
  first.start(snapshot, config);
  const stopped = await first.runUntilIdle(scope, 'run');
  assert.equal(stopped.phase, 'paused');
  const launch = store.load(scope, 'run').receipts.find(row => Array.isArray(row.result?.results))?.result.results[0];
  assert.ok(launch, 'the real foreground launch receipt must be committed');
  assert.equal(launch.content.output_may_be_truncated, true);
  assert.equal(launch.content.stdout.includes('VERIFY_FACT='), false);
  assert.equal(stopped.backgroundCommands.length, 1, 'the advertised task_id must have a committed owner');
  assert.equal(stopped.backgroundCommands[0].notified, true, 'a settled foreground command needs no later completion notice');
  assert.equal(launch.backgroundCommandRef.taskId, launch.content.task_id);
  assert.equal(store.observation(scope, 'run').facts.activity.terminals[0].state, 'completed',
    'a known foreground completion must not appear as an unknown background process');
  const authorityBefore = store.load(scope, 'run');
  const cacheDb = new DatabaseSync(database);
  try {
    const cached = cacheDb.prepare('SELECT run_key,data FROM native_run_observations').get();
    const oldView = JSON.parse(cached.data);
    oldView.commitProjection.contract = 'agentkit.native-commit-projection/v2';
    oldView.facts.activity.terminals[0].state = 'unknown';
    cacheDb.prepare('UPDATE native_run_observations SET data=? WHERE run_key=?').run(JSON.stringify(oldView), cached.run_key);
    assert.equal(store.observation(scope, 'run').facts.activity.terminals[0].state, 'completed',
      'an older display cache is rebuilt from the unchanged original receipt');
    assert.deepEqual(store.load(scope, 'run'), authorityBefore, 'display migration changes no execution authority');
  } finally { cacheDb.close(); }

  store.close(); store = new SqliteRunStore(database); tools = makeTools();
  let generated = 0, paged;
  const second = new NativeKernel({ store, digest, owner: 'cold-owner', ports: {
    model: { generate: async () => ++generated === 1
      ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'page', name: 'read_command_output',
        arguments: { task_id: launch.content.task_id, stdout_cursor: launch.content.stdout_cursor, max_bytes: 65536 } }] }
      : { kind: 'final_candidate', text: 'retained', usage: emptyUsage(), toolCalls: [] } },
    tools: { execute: async request => { paged = await tools.execute(request); return paged; } },
  } });
  second.submit(scope, 'run', { commandId: 'resume-cold', kind: 'resume', payload: {} });
  await second.runUntilIdle(scope, 'run');
  assert.equal(paged.status, 'ok', JSON.stringify(paged.content));
  const full = launch.content.stdout + paged.content.stdout;
  assert.equal(full, '0'.repeat(20000) + '\nVERIFY_FACT=retained\n');
  assert.equal(readFileSync(join(workspaceRoot, 'launches'), 'utf8'), 'once\n');
  const reader = createOwnedCommandOutputReader({ scope, store, readers: { local_process: tools.reader } });
  const request = { contract: OWNED_COMMAND_OUTPUT_CONTRACT, scope, runId: 'run', sessionId: 'session',
    taskId: launch.content.task_id, stdoutCursor: launch.content.stdout_cursor, stderrCursor: 0,
    maxBytes: 65536, signal: new AbortController().signal };
  assert.equal((await reader.read(request)).stdout, paged.content.stdout);
  await assert.rejects(reader.read({ ...request, taskId: 'f'.repeat(64) }), { code: 'background_command_not_owned' });
  assert.equal(readFileSync(join(workspaceRoot, 'launches'), 'utf8'), 'once\n', 'paging never reruns the command');
});
