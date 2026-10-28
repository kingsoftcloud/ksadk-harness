import type { Message, RunConfiguration } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';

/** Facts are supplied by the execution owner, never inferred from prompt prose. */
export interface ModelSurface {
  contract: 'bound-model-surface/v1';
  environment: {
    workspaceRoot: string; cwd: string; platform: string; date: string;
    commandBackend: 'local_process' | 'e2b' | 'none';
    commandCwd?: string; environmentNames?: string[];
    supportsImages: boolean;
  };
}
const bytes = (value: unknown): number => new TextEncoder().encode(canonical(value)).length;
export function validateModelSurface(surface: ModelSurface | undefined): void {
  if (surface === undefined) return;
  invariant(surface && surface.contract === 'bound-model-surface/v1'
    && Object.keys(surface).every(key => ['contract', 'environment'].includes(key)), 'invalid_model_surface');
  const env = surface.environment;
  invariant(env && Object.keys(env).every(key => ['workspaceRoot', 'cwd', 'platform', 'date', 'commandBackend',
    'commandCwd', 'environmentNames', 'supportsImages'].includes(key))
    && ['workspaceRoot', 'cwd', 'platform', 'date'].every(key => typeof env[key as keyof typeof env] === 'string'
      && String(env[key as keyof typeof env]).trim().length > 0)
    && ['local_process', 'e2b', 'none'].includes(env.commandBackend) && typeof env.supportsImages === 'boolean'
    && /^\d{4}-\d{2}-\d{2}$/.test(env.date)
    && (env.commandCwd === undefined || typeof env.commandCwd === 'string' && !!env.commandCwd.trim())
    && (env.environmentNames === undefined || Array.isArray(env.environmentNames) && env.environmentNames.length <= 256
      && new Set(env.environmentNames).size === env.environmentNames.length
      && env.environmentNames.every(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    && bytes(surface) <= 16384, 'invalid_model_environment');
}

export interface CatalogEntry { name: string; description: string; id?: string }
/** Share discovery budgeting across tool and Skill directories. Prefer all names over an arbitrary first page. */
export function boundedCapabilityCatalog(entries: CatalogEntry[], maxBytes = 4096): {
  total: number; omitted: number; mode: 'descriptions' | 'names'; entries: CatalogEntry[];
} {
  invariant(Number.isSafeInteger(maxBytes) && maxBytes >= 256 && Array.isArray(entries)
    && entries.every(entry => entry && typeof entry.name === 'string' && typeof entry.description === 'string'
      && Object.keys(entry).every(key => ['name', 'description', 'id'].includes(key))
      && (entry.id === undefined || typeof entry.id === 'string')), 'invalid_capability_catalog');
  const ordered = copy(entries).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const catalogBytes = (value: unknown) => new TextEncoder().encode(canonical(value)
    .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')).length;
  const described = ordered.map(entry => ({ ...entry, description: Array.from(entry.description).slice(0, 250).join('') }));
  const envelope = (visible: CatalogEntry[], mode: 'descriptions' | 'names') => ({ total: entries.length,
    omitted: entries.length - visible.length, mode, entries: visible });
  if (catalogBytes(envelope(described, 'descriptions')) <= maxBytes) return envelope(described, 'descriptions');
  const visible: CatalogEntry[] = [];
  for (const entry of ordered) {
    const candidate = { ...entry, description: '' };
    if (catalogBytes(envelope([...visible, candidate], 'names')) <= maxBytes) visible.push(candidate);
  }
  return envelope(visible, 'names');
}

/** One frozen assembly, stored in the transcript and therefore used by counting, dispatch and recovery alike. */
export function modelSurfaceMessages(config: RunConfiguration): Message[] {
  if (!config.modelSurface) return [];
  validateModelSurface(config.modelSurface);
  const tools = config.tools.filter(tool => config.contract.allowedToolNames === null || config.contract.allowedToolNames.includes(tool.name));
  const names = new Set(tools.map(tool => tool.name));
  const guidance: string[] = [];
  for (const item of new Set(tools.flatMap(tool => tool.modelGuidance ?? []))) {
    if (bytes([...guidance, item]) <= 3072) guidance.push(item);
  }
  if (config.toolDiscoveryPolicy && names.has('ToolSearch')) guidance.push(config.profile.discoveredToolExposure === 'direct-after-search/v1'
    || config.profile.providerToolSearchPolicy === 'anthropic-deferred/v1'
    ? 'ToolSearch loads authorized definitions. On the next model request call loaded tools directly by exact name; search cannot grant new tools.'
    : 'ToolSearch discovers authorized deferred tools. Use the advertised calling convention; search cannot grant new tools.');
  if (config.profile.providerFamily === 'anthropic-messages') guidance.push('Use only the current tool definitions and tool references. Wait for a result before issuing a dependent action.');
  else if (config.profile.providerFamily === 'openai-chat' || config.profile.providerFamily === 'openai-responses')
    guidance.push('Use structured tool arguments matching the current schema. Batch independent observations; dependent reads and edits must be separate calls.');
  return [{ role: 'system', kind: 'runtime_environment', persistent: true,
    content: canonical({ schemaVersion: 'agentkit.execution-environment/v1', ...config.modelSurface.environment }) },
  { role: 'system', kind: 'capability_directory', persistent: true, content: canonical({
    schemaVersion: 'agentkit.model-capabilities/v1', metadataTrust: 'discovery_data',
    residentToolCount: tools.filter(tool => !tool.discovery).length,
    catalog: boundedCapabilityCatalog(tools.filter(tool => tool.discovery).map(tool => ({ name: tool.name,
      description: tool.discovery?.searchHint || tool.description })), Math.max(256, Math.min(4096, config.profile.contextWindow * 2))),
    discovery: config.toolDiscoveryPolicy && names.has('ToolSearch') ? 'ToolSearch' : null,
    imageInput: config.modelSurface.environment.supportsImages, guidance,
  }) }];
}
