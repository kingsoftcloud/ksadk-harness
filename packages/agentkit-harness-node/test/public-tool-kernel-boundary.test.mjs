import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest } from '../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeSkillDisclosurePort } from '../src/native/skill-disclosure.mjs';
import { createNativeToolAuthority } from '../src/native/tool-authority.mjs';
import { createStudioNativeChildMerge } from '../src/native/child-merge.mjs';

for (const family of ['disclosure', 'child-merge']) for (const state of ['approval_required', 'denied'])
  test(`real Kernel/SQLite ${family} ${state} retains authority and persists only public diagnostics`, async t => {
    const store = new SqliteRunStore(':memory:'); t.after(() => store.close());
    let authorizations = 0, effects = 0, result;
    const authorize = async () => { authorizations++; return { status: state, interactionId: 'original-interaction', code: 'DENIED',
      message: 'Authorization: Bearer fixtureKernelSecret', details: { api_key: 'fixtureKernelKey' } }; };
    const port = family === 'disclosure' ? createNativeSkillDisclosurePort({ scope, sessionId: 'session', store, skillRefs: [], authorize,
      assertCurrent: createNativeToolAuthority({ scope, sessionId: 'session', store }),
      source: { manifest: async () => { effects++; return {}; }, fullText: async () => { effects++; return ''; }, resource: async () => { effects++; return Buffer.alloc(0); } } })
      : createStudioNativeChildMerge({ scope, sessionId: 'session', store, roles: [], fileWorkspaces: {}, authorize,
        previousPublication: async () => { effects++; } });
    const definition = port.definition ?? port.definitions[0];
    const { config, snapshot } = fixture({ tools: [definition], limits: { effectTimeoutMs: 130000 } }); store.create(config, snapshot);
    let models = 0;
    const kernel = new NativeKernel({ store, digest, owner: 'diagnostic-owner', ports: {
      model: { generate: async () => ++models === 1
        ? { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'original-call', name: definition.name,
          arguments: family === 'disclosure' ? {} : { child_run_id: 'child' } }], usage: emptyUsage() }
        : { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() } },
      tools: { execute: async request => { result = await port.execute(request); return result; } },
    } });
    await kernel.runUntilIdle(scope, 'run');
    assert.equal(authorizations, 1); assert.equal(effects, 0);
    assert.equal(result.status, state === 'approval_required' ? state : 'error');
    if (state === 'approval_required') assert.equal(result.interactionId, 'original-interaction');
    assert.doesNotMatch(JSON.stringify(store.load(scope, 'run')), /fixtureKernelSecret|fixtureKernelKey/);
    port.close?.();
  });
