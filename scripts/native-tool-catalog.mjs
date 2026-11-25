import { NATIVE_DEFAULT_TOOL_NAMES } from '@kingsoftcloud/agentkit-harness-core/capability-profile';
import { NATIVE_CHILD_WORKSPACE_TOOLS } from '@kingsoftcloud/agentkit-harness-core/child-workspace-tools';
import { workspacePatchDefinition, workspaceRewindDefinitions, workspaceToolDefinitions } from '../packages/agentkit-harness-node/src/native/workspace-tools.mjs';
import { nativeWebToolDefinitions } from '../packages/agentkit-harness-node/src/native/web-tools.mjs';
import { studioBrowserDefinition } from '../packages/agentkit-harness-node/src/native/browser-workspace-protocol.mjs';
import { localCommandToolDefinitions } from '../packages/agentkit-harness-node/src/native/local-command-tools.mjs';
import { supportsLocalProcessPlatform } from '../packages/agentkit-harness-node/src/native/local-process.mjs';

/** Public authoring metadata. The engine still admits and runs its own tools. */
export function nativeToolCatalog(version) {
  const supportedCommandPlatforms = ['darwin', 'linux', 'win32'].flatMap(platform =>
    ['arm64', 'x64'].filter(arch => supportsLocalProcessPlatform({ platform, arch })).map(arch => `${platform}-${arch}`));
  const describe = ({ name, description, parameters, readOnly, timeoutMs, permissions }, availability) =>
    ({ name, description, parameters, readOnly, timeoutMs, permissions, availability });
  return {
    schemaVersion: 'agentkit.engine-tool-catalog/v1',
    version,
    defaultTools: [...NATIVE_DEFAULT_TOOL_NAMES],
    childWorkspaceTools: [...NATIVE_CHILD_WORKSPACE_TOOLS],
    supportedCommandPlatforms,
    tools: [
      ...[workspacePatchDefinition(), ...workspaceRewindDefinitions(), ...workspaceToolDefinitions()].map(tool => describe(tool, 'always')),
      ...nativeWebToolDefinitions().map(tool => describe(tool, tool.name === 'web_search' ? 'search' : 'always')),
      describe(studioBrowserDefinition(), 'browser'),
      ...localCommandToolDefinitions().map(tool => describe(tool, 'local-command')),
    ],
  };
}
