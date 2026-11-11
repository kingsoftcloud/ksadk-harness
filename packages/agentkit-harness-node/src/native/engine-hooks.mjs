import { hookResult, invariant, validateHookDefinition, validateHookResult } from '@kingsoftcloud/agentkit-harness-core';

export const ENGINE_HOOKS = 'agentkit.engine-hooks/v1';

export function admitEngineHooks(value) {
  if (value === undefined) return { definitions: [], configuration: {}, timeoutMs: 0 };
  invariant(value?.contract === ENGINE_HOOKS && Array.isArray(value.hooks)
    && value.hooks.length <= 32
    && Object.keys(value).every(key => ['contract', 'hooks', 'stopContinuationLimit'].includes(key)),
  'engine_hooks_invalid');
  const definitions = value.hooks.map(raw => {
    const hook = validateHookDefinition(raw);
    invariant(hook.timeoutMs <= 60000 && hook.maxInputBytes <= 4 * 1024 * 1024
      && hook.maxOutputBytes <= 1024 * 1024, 'engine_hook_limit_exceeded');
    return hook;
  });
  const stop = definitions.some(hook => hook.events.includes('Stop'));
  invariant(stop === (value.stopContinuationLimit !== undefined)
    && (!stop || Number.isSafeInteger(value.stopContinuationLimit) && value.stopContinuationLimit >= 0),
  'engine_hook_stop_policy_invalid');
  return { definitions,
    configuration: stop ? { stopHookContinuationLimit: value.stopContinuationLimit } : {},
    timeoutMs: Math.max(0, ...definitions.map(hook => Math.ceil(hook.timeoutMs) + 5000)),
  };
}

export function engineHookPort(callHostHook, compactionObservations) {
  return { async invoke({ signal, ...request }) {
    const failure = reason => hookResult(request, request.definition.readOnly ? 'failed' : 'uncertain', null, reason);
    if (typeof callHostHook !== 'function') return hookResult(request, 'failed', null, 'binding_unavailable');
    // The host establishes its own principal from the activation; the engine's
    // internal storage scope grants no authority to a host callback.
    const { scope: _scope, ...invocation } = request;
    let reply;
    try {
      const observations = request.definition.compactionSourceProjection === 'canonical_user'
        ? compactionObservations(request) : undefined;
      reply = await callHostHook({ contract: ENGINE_HOOKS, ...invocation, ...(observations ? { observations } : {}) },
        Math.ceil(request.definition.timeoutMs) + 5000, signal);
    } catch {
      signal.throwIfAborted();
      return failure('producer_timeout');
    }
    signal.throwIfAborted();
    try {
      invariant(reply?.contract === ENGINE_HOOKS && reply.operationKey === request.operationKey
        && reply.inputDigest === request.inputDigest, 'engine_hook_result_unbound');
      return validateHookResult(request, hookResult(request, reply.status, reply.output, reply.reason));
    } catch {
      return failure('producer_invalid');
    }
  } };
}
