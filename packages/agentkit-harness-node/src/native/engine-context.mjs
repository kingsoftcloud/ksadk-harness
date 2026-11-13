import { invariant } from '@kingsoftcloud/agentkit-harness-core';

export const ENGINE_CONTEXT = 'agentkit.engine-context/v1';
const MAX_SOURCES = 32;
const MAX_SOURCE_MS = 30000;
const SOURCE_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function admitEngineContextSources(value) {
  if (value === undefined) return [];
  invariant(value?.contract === ENGINE_CONTEXT
    && Object.keys(value).every(key => key === 'contract' || key === 'sources') && Array.isArray(value.sources)
    && value.sources.length <= MAX_SOURCES, 'engine_context_sources_invalid');
  const seen = new Set();
  return value.sources.map(source => {
    invariant(source && typeof source === 'object'
      && Object.keys(source).every(key => ['sourceId', 'bindingDigest', 'timeoutMs', 'maxTokens', 'maxBytes',
        'failureMode', 'allowInstructions'].includes(key))
      && typeof source.sourceId === 'string' && SOURCE_ID.test(source.sourceId) && !seen.has(source.sourceId)
      && typeof source.bindingDigest === 'string' && DIGEST.test(source.bindingDigest)
      && Number.isSafeInteger(source.timeoutMs) && source.timeoutMs >= 1 && source.timeoutMs <= MAX_SOURCE_MS
      && Number.isSafeInteger(source.maxTokens) && source.maxTokens >= 1 && source.maxTokens <= 1048576
      && Number.isSafeInteger(source.maxBytes) && source.maxBytes >= 1 && source.maxBytes <= 131072
      && ['skip', 'warn', 'fail'].includes(source.failureMode) && typeof source.allowInstructions === 'boolean',
    'engine_context_source_invalid');
    seen.add(source.sourceId);
    return { contract: 'agentkit.native-context-source/v1', sourceId: source.sourceId,
      bindingDigest: source.bindingDigest, priority: 0, timeoutMs: source.timeoutMs, maxTokens: source.maxTokens,
      maxBytes: source.maxBytes, required: source.failureMode === 'fail',
      hostProjection: source.allowInstructions ? 'instructions-and-data/v1' : 'data/v1',
      ...(source.failureMode === 'warn' ? { warnOnFailure: true } : {}) };
  });
}

export function engineContextPort(port, callHostContext) {
  return { ...port, async readSource({ source, snapshot, operationKey, signal, remainingTokens }) {
    invariant(source.hostProjection && typeof callHostContext === 'function', 'engine_context_unavailable');
    const reply = await callHostContext({
      contract: ENGINE_CONTEXT, runId: snapshot.runId, turnId: snapshot.turnId, operationKey,
      sourceId: source.sourceId, bindingDigest: source.bindingDigest,
      goal: snapshot.goal, goalRevision: snapshot.goalRevision, remainingTokens,
    }, source.timeoutMs, signal);
    invariant(reply?.contract === ENGINE_CONTEXT && reply.sourceId === source.sourceId
      && reply.bindingDigest === source.bindingDigest && Array.isArray(reply.items), 'engine_context_result_invalid');
    return { items: reply.items };
  } };
}
