import { canonical, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { MANAGED_SESSION_DELIVERY_LIMIT } from './engine-managed-delivery.mjs';
import { hostReceiptReply } from './engine-host-effects.mjs';

export const MANAGED_HOST_RESOURCES = 'agentkit.managed-host-resources/v1';
const PATH = '/_agentkit/managed-host/v1/';
const LIMIT = 2 * 1024 ** 2;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function createManagedEngineHost(config, env, fetchImpl = fetch) {
  invariant(object(config) && Object.keys(config).sort().join(',') === 'endpoint,tokenEnv'
    && typeof config.endpoint === 'string' && typeof config.tokenEnv === 'string'
    && /^[A-Z][A-Z0-9_]{0,127}$/.test(config.tokenEnv), 'engine_managed_host_config_invalid');
  const origin = new URL(config.endpoint), token = env[config.tokenEnv];
  invariant((origin.protocol === 'https:' || origin.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
    && origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash
    && typeof token === 'string' && token.length >= 32, 'engine_managed_host_config_invalid');

  async function exchange(path, payload, signal, timeoutMs, limit = LIMIT) {
    const body = canonical({ contract: MANAGED_HOST_RESOURCES, ...payload });
    invariant(Buffer.byteLength(body) <= limit, 'engine_managed_host_request_too_large');
    const response = await fetchImpl(origin.origin + PATH + path, {
      method: 'POST', redirect: 'error', body,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel();
      throw Object.assign(new Error('Managed host is unavailable'), { code: 'engine_managed_host_unavailable' });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      invariant(size <= LIMIT, 'engine_managed_host_reply_too_large');
      chunks.push(chunk);
    }
    const reply = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    invariant(object(reply) && reply.contract === MANAGED_HOST_RESOURCES, 'engine_managed_host_reply_invalid');
    return reply;
  }

  return Object.freeze({
    async admit({ scope, sessionId, runId, toolCatalog, signal }) {
      const reply = await exchange('admit', { scope, sessionId, runId, toolCatalog }, signal, 20000);
      invariant(typeof reply.ref === 'string' && reply.ref.length > 0 && reply.ref.length <= 8192
        && typeof reply.hostInstructions === 'string' && reply.hostInstructions.length <= 100000
        && Array.isArray(reply.hostTools), 'engine_managed_host_reply_invalid');
      return { ref: reply.ref, hostInstructions: reply.hostInstructions, hostTools: reply.hostTools,
        sessionDelivery: reply.sessionDelivery === true };
    },
    async deliver(path, payload, signal) {
      try {
        const reply = await exchange(path, payload, signal, 30000, MANAGED_SESSION_DELIVERY_LIMIT);
        invariant(reply.received === true, 'engine_managed_host_delivery_not_confirmed');
      } catch (error) {
        signal.throwIfAborted();
        throw Object.assign(new Error('Studio session delivery pending', { cause: error }), { code: 'NATIVE_KERNEL_REMOTE_HOST_RETRY' });
      }
    },
    async callTool({ scope, sessionId, ref, runId, callId, name, arguments: args, effect, signal, timeoutMs }) {
      invariant(effect === undefined || typeof effect?.operationKey === 'string', 'engine_managed_host_effect_invalid');
      const reply = await exchange('tool', { scope, sessionId, ref, runId, callId, name, arguments: args,
        ...(effect ? { effect: { operationKey: effect.operationKey, approved: effect.approved,
          canRequestApproval: effect.canRequestApproval } } : {}) }, signal, timeoutMs + 1000);
      invariant(['ok', 'error', 'approval_required', 'uncertain'].includes(reply.status), 'engine_managed_host_reply_invalid');
      return { status: reply.status, content: reply.content };
    },
    async receipt(payload, signal) {
      const reply = await exchange('receipt', payload, signal, payload.observationId ? 12000 : 3000);
      return hostReceiptReply(reply, payload.observationId);
    },
  });
}
