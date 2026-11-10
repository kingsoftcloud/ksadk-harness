import { NativeKernel, emptyUsage } from '../../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, digest, scope, tool } from '../fixtures.mjs';

const [filename, boundary] = process.argv.slice(2);
const { config, snapshot } = fixture({ outputRecoveryPolicy: boundary === 'exhausted' ? 'response-boundary/v2' : 'task-or-delivery/v1',
  ...(boundary === 'exhausted' ? { outputRestartPolicy: 'per-response/v2' } : {}),
  tools: boundary === 'suffix' ? [] : [tool({ name: 'write', readOnly: false, concurrentSafe: false })],
  profile: { ...fixture().config.profile, maxContinuations: boundary === 'exhausted' ? 0 : 1 },
  limits: { maxOutputRestarts: 1 } });
const store = new SqliteRunStore(filename);
const worker = new NativeKernel({ store, digest, owner: 'killed-output-owner', ports: {
  model: { generate: async () => ({ kind: 'output_limit', text: 'Unfinished original ', toolCalls: [], usage: emptyUsage(),
    ...(boundary === 'exhausted' ? { textCommitVersion: 'provider-finished-text/v1', outputBoundary: 'assistant-text/v1' } : {}) }) },
  tools: { execute: async () => { throw Error('No effect permitted before recovery'); } },
}, onCheckpoint: async state => {
  if (boundary === 'exhausted' ? state.phase !== 'paused' : state.phase !== 'preparing_context') return;
  const ready = boundary === 'exhausted' ? state.reason === 'output_budget_exhausted'
    : boundary === 'restart' ? state.outputRestarts === 1 : state.messages.at(-1)?.kind === 'continuation_observation';
  if (!ready) return;
  process.send({ kind: 'ready', pid: process.pid, mode: state.messages.at(-1)?.continuationMode ?? null,
    modelCalls: state.usage.modelCalls, outputRestarts: state.outputRestarts, reason: state.reason });
  await new Promise(() => {});
} });
worker.start(snapshot, config);
await worker.runUntilIdle(scope, 'run');
throw Error('Expected parent to kill the held process');
