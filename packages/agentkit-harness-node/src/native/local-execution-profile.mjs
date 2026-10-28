import { localControlSettings, buildScriptEnvironment, LOCAL_PROCESS_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/local-process';
import { localOutputPolicy, localEnvironmentPolicy } from '@kingsoftcloud/agentkit-harness-node/native/local-output-policy';
import { LOCAL_COMMAND_TOOLS_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/local-command-tools';
import { LOCAL_COMMAND_POLICY, GOVERNED_COMMAND_POLICY } from '@kingsoftcloud/agentkit-harness-node/native/local-command-policy';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

/** Select a Host execution profile once, then use the same settings for binding, facts and actual transport. */
export function bindNativeLocalExecution({ settings = {}, sourceEnv = {}, modern = false } = {}) {
  const selected = localControlSettings(settings);
  const outputPolicy = modern ? localOutputPolicy({ version: 'persisted-stream/v1',
    previewBytes: Math.max(4, Math.min(selected.maxOutputBytes, 16384)), persistedBytes: 64 * 1024 * 1024 }) : null;
  const environmentPolicy = modern ? localEnvironmentPolicy({ version: 'local-development/v1' }) : null;
  const environment = buildScriptEnvironment(sourceEnv, { settings: selected, environmentPolicy });
  return { settings: selected, outputPolicy, environmentPolicy, environment, binding: {
    contract: LOCAL_COMMAND_TOOLS_CONTRACT, controls: { contract: LOCAL_PROCESS_CONTRACT, settings: selected,
      ...(modern ? { outputPolicy, environmentPolicy } : {}) },
    risk: [LOCAL_COMMAND_POLICY, GOVERNED_COMMAND_POLICY], backend: 'local_process', environmentDigest: hash(environment),
  } };
}

/** The same selected execution profile supplies both transport bindings and model facts. */
export function nativeLocalExecutionMethods({ enabled, settings, sourceEnv, workspaceRoot, commandBackend }) {
  const localExecution = ({ modern = false } = {}) => enabled
    ? bindNativeLocalExecution({ settings, sourceEnv, modern }) : null;
  return { localExecution, executionEnvironment({ modern = false } = {}) {
    const local = localExecution({ modern });
    return { workspaceRoot, cwd: workspaceRoot, platform: process.platform, commandBackend,
      ...(local ? { commandCwd: workspaceRoot, environmentNames: Object.keys(local.environment).sort() } : {}) };
  } };
}
