import assert from 'node:assert/strict';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NativeKernel, configure, emptyUsage, canonical } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node';
import { createNativeChildren, nativeChildRoles } from '@kingsoftcloud/agentkit-harness-node/native/children';
import { bindNativeLocalExecution } from '@kingsoftcloud/agentkit-harness-node/native/local-execution-profile';
import { installTaskTimeline } from '@kingsoftcloud/agentkit-harness-ui/host/task-timeline';
import { installNativeCommandPane } from '@kingsoftcloud/agentkit-harness-ui/host/native-command-pane';
import { installNativeChildPane } from '@kingsoftcloud/agentkit-harness-ui/host/native-child-pane';
import { createNativeChildPanel } from '@kingsoftcloud/agentkit-harness-ui/host/native-run-panel';
import { createNativeA2aPanel } from '@kingsoftcloud/agentkit-harness-ui/host/native-a2a';
import { createHarnessComponents } from '@kingsoftcloud/agentkit-harness-ui/react-binding';
import { initialState, reduceAll } from '@kingsoftcloud/agentkit-harness-ui/reducer';

const require = createRequire(import.meta.url), nodeRequire = createRequire(import.meta.resolve('@kingsoftcloud/agentkit-harness-node'));
assert.equal(nodeRequire.resolve('@kingsoftcloud/agentkit-harness-core'), require.resolve('@kingsoftcloud/agentkit-harness-core'));
assert.equal(typeof createNativeChildren, 'function'); assert.equal(typeof createNativeChildPanel, 'function');
assert.equal(typeof createNativeA2aPanel, 'function');
assert.equal(nativeChildRoles({ subAgents: [{ name: 'reader', instructions: 'Inspect evidence.', tools: [] }] },
  { childAllocationPolicy: 'parent-shared/v1' })[0].maxTurns, 16);
const workspace = join(process.cwd(), 'proof-workspace'); mkdirSync(workspace);
assert.equal(bindNativeLocalExecution({ modern: true, sourceEnv: { PATH: '/usr/bin:/bin', HOME: workspace } }).outputPolicy.version,
  'persisted-stream/v1');
const scope = { tenantId: 'installed', workspaceId: 'workspace', userId: 'operator', agentId: 'agent' };
const storePath = join(process.cwd(), 'runs.sqlite'), store = new SqliteRunStore(storePath);
const config = configure({ profile: { profileId: 'controlled', profileVersion: '1', providerFamily: 'fixture',
  compatibilityDigest: 'installed-proof/v1' }, contract: { objective: 'Verify installed packages.' }, hostBindingDigest: 'installed-host/v1' });
const kernel = new NativeKernel({ store, owner: 'installed-probe', digest: value => createHash('sha256').update(canonical(value)).digest('hex'),
  ports: { model: { generate: async () => ({ kind: 'final_candidate', text: 'Installed runtime completed.', toolCalls: [], usage: emptyUsage() }) },
    tools: { execute: async () => assert.fail('No tool is admitted in this controlled task') } } });
kernel.start({ scope, runId: 'run', sessionId: 'session', turnId: '1', buildId: 'proof', parentRunId: null, taskChainId: 'chain' }, config);
assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed'); store.close();
const reopened = new SqliteRunStore(storePath); assert.equal(reopened.load(scope, 'run').snapshot.finalText, 'Installed runtime completed.'); reopened.close();

const state = reduceAll(initialState(), [
  { v: 1, id: 'start', type: 'task.started', taskId: 'run' },
  { v: 1, id: 'thought', type: 'thinking.delta', itemId: 'thinking', delta: 'Controlled provider thought.' },
  { v: 1, id: 'thought-end', type: 'thinking.done', itemId: 'thinking' },
  { v: 1, id: 'tool', type: 'tool.scheduled', callId: 'command', name: 'run_command', input: { command: 'printf installed-proof' } },
  { v: 1, id: 'tool-start', type: 'tool.started', callId: 'command' },
  { v: 1, id: 'tool-end', type: 'tool.result', callId: 'command', result: { stdout: 'installed-proof', exit_code: 0 } },
  { v: 1, id: 'answer', type: 'text.done', itemId: 'answer', text: 'Installed UI answer.' },
]);
const { HarnessTimeline } = createHarnessComponents(React);
const html = renderToStaticMarkup(React.createElement(HarnessTimeline, { state, theme: 'dark', initiallyExpandedThoughts: ['thinking'], styleSheet: null }));
assert.match(html, /Installed UI answer/); assert.match(html, /printf installed-proof/); assert.match(html, /Controlled provider thought/);

const slots = new Map(), tabs = new Map(), cleanup = [], opened = [], eventSource = {};
const ctx = { theme: { getTheme: () => ({ active: { colorScheme: 'dark' } }) }, on: () => () => {},
  sessions: { binding: () => ({ eventSource }) }, effect: install => { const stop = install(); if (typeof stop === 'function') cleanup.push(stop); },
  sidebarRight: { openTab: (kind, options) => opened.push({ kind, ...options }) },
  sidebarRightTabs: { register: definition => { tabs.set(definition.id, definition); return () => tabs.delete(definition.id); } },
  slots: { register: (definition, component) => { const key = definition.name + ':' + (definition.key ?? 'primary');
    slots.set(key, { definition, component }); return () => slots.delete(key); },
  inject: (_name, install) => { const stop = install(); if (typeof stop === 'function') cleanup.push(stop); return typeof stop === 'function' ? stop : () => {}; } } };
installTaskTimeline(ctx, { ui: { React, ReactDOM }, hostRemote: {}, resolveAgentFromPreset: () => 'agent' });
assert.equal(slots.get('conversation.chat.presentation:primary').definition.inject('session').hooks.harnessEvents, eventSource);
const commands = installNativeCommandPane(ctx, { React, hostRemote: {} });
const children = installNativeChildPane(ctx, { React, hostRemote: {}, labels: {}, renderText: text => text });
commands.open({ agentId: 'agent', sessionId: 'session', id: 'owned-command' });
children.open({ agentId: 'agent', parentSessionId: 'session', parentRunId: 'original-parent', runId: 'owned-child', sessionId: 'child-session' });
assert.equal(opened[0].params.id, 'owned-command'); assert.equal(opened[1].params.parentRunId, 'original-parent');
for (const stop of cleanup.reverse()) stop(); assert.equal(slots.size, 0); assert.equal(tabs.size, 0);
console.log(JSON.stringify({ schemaVersion: 'agentkit.native-installed-ui/v1', status: 'passed', packages: 3,
  singleCore: true, durableRuntime: true, taskTimeline: true, providerThinking: true, terminal: true,
  commandAndChildDocking: true, disposal: true, model: 'controlled' }));
