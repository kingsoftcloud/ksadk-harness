// Copied into a fresh npm installation by verify-native-installed-live.mjs.
import { createHash } from 'node:crypto';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeKernel, configure, canonical, defaultPolicyModules, defaultPolicyBindings }
  from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore, createNativeModelPort, nativeModelRecoveryPolicy }
  from '@kingsoftcloud/agentkit-harness-node';

const [mode, directory] = process.argv.slice(2);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const scope = { tenantId: 'local-test', workspaceId: 'standalone', userId: 'local-user', agentId: 'live' };
const store = new SqliteRunStore(join(directory, 'live.sqlite'));
const protocol = process.env.NATIVE_MODEL_PROTOCOL ?? 'openai-chat';
const binding = { protocol, baseUrl: process.env.NATIVE_MODEL_BASE_URL,
  model: process.env.NATIVE_MODEL_NAME, apiKey: process.env.NATIVE_MODEL_API_KEY };
const policy = Object.freeze({ id: 'example.exact-copy', version: '1', implementation: 'exact-copy/v1',
  context: () => ['Use read_input then write_result once. Copy the exact observed input; do not infer its contents. Finish with a concise confirmation.'] });
const descriptor = (name, parameters, readOnly) => ({ name, parameters, description: name === 'read_input'
  ? 'Read the acceptance input file. No arguments.' : 'Write the observed input verbatim to the output file, once.',
  readOnly, concurrentSafe: readOnly, permissions: [readOnly ? 'workspace:read' : 'workspace:write'], timeoutMs: 5000,
  contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
  ...(readOnly ? { recoveryPolicy: 'safe-read/v1' } : {}) });
const input = {
  profile: { profileId: 'standalone-live', profileVersion: '1', providerFamily: protocol,
    compatibilityDigest: digest({ protocol, baseUrl: binding.baseUrl, model: binding.model }),
    maxOutputTokens: 1024, requestTimeoutMs: 45000, maxRetries: 0, maxProviderRetries: 2 },
  hostBindingDigest: 'standalone-live-copy/v1',
  contract: { objective: 'Read the input with read_input; write its exact contents with write_result once; then confirm completion.' },
  tools: [descriptor('read_input', { type: 'object', properties: {}, additionalProperties: false }, true),
    descriptor('write_result', { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, false)],
  limits: { maxModelCalls: 6, maxToolCalls: 2, finalizationReserveModelCalls: 1, leaseMs: 2000, maxWallMs: 180000 },
  modelRecoveryPolicy: nativeModelRecoveryPolicy(binding),
};
const configuration = configure({ ...input, policyModules: [...defaultPolicyBindings(input), {
  id: policy.id, version: policy.version, implementation: policy.implementation,
}] });
let cursor = 0;
const kernel = new NativeKernel({ store, digest, owner: `live-${process.pid}`, policyModules: [...defaultPolicyModules, policy],
  ports: { model: createNativeModelPort({ resolveProfile: async () => binding,
    fetchImpl: async (...args) => {
      try {
        const response = await fetch(...args);
        await appendFile(join(directory, 'transport.jsonl'), JSON.stringify({ status: response.status }) + '\n');
        return response;
      } catch (error) {
        await appendFile(join(directory, 'transport.jsonl'), JSON.stringify({ failure: error.name }) + '\n');
        throw error;
      }
    },
  }), tools: {
    async execute(request) {
      request.signal.throwIfAborted();
      const required = request.call.name === 'read_input' ? 'workspace:read' : 'workspace:write';
      if (!request.definition.permissions.includes(required)) return { status: 'error', content: { reason: 'permission_denied', executed: false } };
      if (request.call.name === 'read_input') {
        const text = await readFile(join(directory, 'input.txt'), 'utf8');
        await appendFile(join(directory, 'reads.log'), `${request.operationKey}\n`);
        return { status: 'ok', content: { text } };
      }
      if (request.call.name === 'write_result') {
        await writeFile(join(directory, 'output.txt'), request.call.arguments.text, { flag: 'wx' });
        await appendFile(join(directory, 'writes.log'), `${request.operationKey}\n`);
        return { status: 'ok', content: { written: true } };
      }
      return { status: 'error', content: { reason: 'unknown_tool', executed: false } };
    },
  } },
  async onCheckpoint(snapshot) {
    const events = store.events(scope, 'live', cursor);
    for (const event of events) cursor = Math.max(cursor, event.seq);
    // This process exits only after the read receipt/state/events have committed.
    const record = store.load(scope, 'live');
    if (mode === 'start' && record.intents.some(intent => intent.kind === 'tool'
      && record.receipts.some(receipt => receipt.operationKey === intent.operationKey && receipt.status === 'committed'))) {
      await writeFile(join(directory, 'restart.json'), JSON.stringify({ revision: snapshot.revision, eventCursor: cursor }));
      process.exit(73);
    }
  },
});
try {
  if (mode === 'start') kernel.start({ scope, runId: 'live', sessionId: 'live', turnId: '1',
    buildId: 'live-v1', parentRunId: null, taskChainId: 'live' }, configuration);
  else kernel.attach(scope, 'live', configuration);
  const done = await kernel.runUntilIdle(scope, 'live');
  const record = store.load(scope, 'live');
  let writes = '', reads = '';
  try { writes = await readFile(join(directory, 'writes.log'), 'utf8'); } catch {}
  try { reads = await readFile(join(directory, 'reads.log'), 'utf8'); } catch {}
  await writeFile(join(directory, 'live-result.json'), JSON.stringify({ phase: done.phase, outcome: done.outcome,
    reason: done.reason, protocol, model: binding.model, usage: done.usage,
    readCalls: reads.trim().split('\n').filter(Boolean).length, writeCalls: writes.trim().split('\n').filter(Boolean).length,
    committedEvents: record.events.length, subscribedCursor: cursor,
    registeredPolicy: record.configuration.policyModules.find(binding => binding.id === policy.id),
    transport: (await readFile(join(directory, 'transport.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  }, null, 2));
} catch (error) {
  await writeFile(join(directory, 'live-error.json'), JSON.stringify({ code: error.code ?? error.name }));
  throw error;
} finally { store.close(); }
