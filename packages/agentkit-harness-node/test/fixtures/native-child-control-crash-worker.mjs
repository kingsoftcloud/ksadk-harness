import { NativeKernel } from '../../../agentkit-harness-core/dist/index.mjs';
import { scope, digest } from '../../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../../src/native/sqlite-store.mjs';

const [filename, position, control = 'input', childAgentId = 'child-agent'] = process.argv.slice(2);
const crash = code => { if (control === 'resume') process.kill(process.pid, 'SIGKILL'); else process.exit(code); };
const store = new SqliteRunStore(filename, { beforeCommit: ({ record }) => {
  if (position === 'inside' && record.snapshot.runId === 'run'
    && record.events.some(event => event.kind === (control === 'resume' ? 'child.resume_requested' : 'child.input_queued'))) crash(77);
} });
const childScope = { ...scope, agentId: childAgentId }, child = store.list(childScope)[0];
const record = store.load(childScope, child.runId), binding = record.configuration.childOwnerBinding;
// This process tests the real cross-ledger transaction. It has no model/tool
// capability and exits before any child wake or execution could occur.
const kernel = new NativeKernel({ store, owner: 'child-control-crash', digest, ports: { children: {
  controlTarget: () => ({ scope: childScope, runId: child.runId, configurationDigest: child.configDigest,
    parentOperationKey: binding.parentOperationKey, parentToolCallId: binding.parentToolCallId }),
  wakeControl: async () => { if (position === 'after') crash(78); throw Error('must exit inside transaction'); },
  collect: async () => { throw Error('must not execute a child'); },
} } });
await kernel.runUntilIdle(scope, 'run');
throw Error('crash checkpoint was not reached');
