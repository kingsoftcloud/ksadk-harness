/** Versioned trusted Server transport. The Gateway's A2A assertion is never a
 * Kernel permit. Every mutation/read still verifies its own Server signature. */
import { canonical, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

export const MANAGED_NATIVE_KERNEL_PATH = '/_agentkit/native-kernel/v1';
export const AGENT_KERNEL_SUBMIT_PATH = '/agent-kernel/v1/SubmitAgentControl';
const AGENT_KERNEL_STATUS_PATH = '/agent-kernel/v1/GetAgentStatus';
const AGENT_KERNEL_EVENTS_PATH = '/agent-kernel/v1/SubscribeSessionEvents';
const platformPaths = new Set([AGENT_KERNEL_SUBMIT_PATH, AGENT_KERNEL_STATUS_PATH, AGENT_KERNEL_EVENTS_PATH]);
export function isAgentKernelPlatformPath(url) { return platformPaths.has(url?.split('?', 1)[0]); }

function readPlatformSubscription(request) {
  const params = new URL(request.url, 'http://localhost').searchParams;
  const fields = ['tenant_id', 'agent_instance_id', 'session_id', 'after_seq'];
  invariant(fields.every(field => params.getAll(field).length <= 1), 'NATIVE_KERNEL_CURSOR_INVALID');
  const cursor = params.get('after_seq') ?? '0';
  invariant(/^\d+$/u.test(cursor), 'NATIVE_KERNEL_CURSOR_INVALID');
  const header = request.headers['x-agent-control-permit'];
  invariant(typeof header === 'string' && header.length <= 8192, 'NATIVE_KERNEL_PERMIT_INVALID');
  let permit;
  try { permit = parseNativeJson(header); } catch { invariant(false, 'NATIVE_KERNEL_PERMIT_INVALID'); }
  return { permit, subscription: { tenant_id: params.get('tenant_id'), agent_instance_id: params.get('agent_instance_id'),
    session_id: params.get('session_id'), after_seq: Number(cursor), authorization_ref: permit?.permit_id } };
}

function platformFrame(fact) {
  return { timestamp: fact.timestamp, ...fact.payload, seq: fact.seq, family: fact.family, family_version: fact.family_version,
    event_type: fact.event_type, event_id: fact.event_id, session_id: fact.session_id,
    ...(fact.run_id ? { run_id: fact.run_id } : {}) };
}

export function createManagedNativeKernelHttp(runtime) {
  invariant(typeof runtime?.receive === 'function' && typeof runtime.subscribe === 'function', 'NATIVE_KERNEL_HTTP_CONFIGURATION_INVALID');
  const lifetime = new AbortController(), responses = new Set();
  const json = (response, status, body, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    response.end(canonical(body)); };
  async function handle(request, response, { signal } = {}) {
    const disconnected = new AbortController();
    const scoped = AbortSignal.any([lifetime.signal, disconnected.signal, ...(signal ? [signal] : [])]);
    const stop = () => disconnected.abort(); response.once('close', stop); responses.add(response);
    const abort = () => response.destroy(); scoped.addEventListener('abort', abort, { once: true });
    let iterator;
    try {
      scoped.throwIfAborted();
      const path = request.url?.split('?')[0];
      const standardCommand = path === AGENT_KERNEL_SUBMIT_PATH;
      const standardStatus = path === AGENT_KERNEL_STATUS_PATH, standardEvents = path === AGENT_KERNEL_EVENTS_PATH;
      let body;
      if (standardEvents) {
        invariant(request.method === 'GET', 'NATIVE_KERNEL_HTTP_UNSUPPORTED');
        body = readPlatformSubscription(request);
      } else {
        invariant(request.method === 'POST' && [MANAGED_NATIVE_KERNEL_PATH + '/commands', MANAGED_NATIVE_KERNEL_PATH + '/status',
          MANAGED_NATIVE_KERNEL_PATH + '/events', AGENT_KERNEL_SUBMIT_PATH, AGENT_KERNEL_STATUS_PATH].includes(path)
          && request.url === path, 'NATIVE_KERNEL_HTTP_UNSUPPORTED');
        const chunks = []; let size = 0;
        for await (const chunk of request) { scoped.throwIfAborted(); size += chunk.length;
          invariant(size <= 2 * 1024 ** 2, 'NATIVE_KERNEL_HTTP_BODY_LIMIT'); chunks.push(chunk); }
        body = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        invariant(body && typeof body === 'object' && !Array.isArray(body), 'NATIVE_KERNEL_COMMAND_INVALID');
      }
      scoped.throwIfAborted();
      if (standardCommand || path.endsWith('/commands')) {
        const receipt = await runtime.receive(body.command, body.permit); scoped.throwIfAborted();
        const status = standardCommand && receipt.error?.code === 'idempotency_conflict' ? 409
          : { accepted: 202, duplicate: 200, rejected: 400, unsupported: 409, queue_full: 429, persistence_uncertain: 503 }[receipt.status];
        const headers = standardCommand ? { 'x-ksadk-agent-kernel': '1', 'x-ksadk-control-status': receipt.status,
          'x-ksadk-command-id': receipt.command_id,
          ...(receipt.message_id ? { 'x-ksadk-control-message-id': receipt.message_id } : {}) } : {};
        json(response, status ?? 503, receipt, headers);
      } else if (standardStatus || path.endsWith('/status')) {
        const status = standardStatus ? await runtime.platformStatus(body.query, body.permit) : await runtime.getStatus(body.query, body.permit);
        scoped.throwIfAborted(); json(response, 200, status);
      } else {
        const { epoch, events: source } = standardEvents ? await runtime.platformEvents(body.subscription, body.permit, { signal: scoped })
          : { events: await runtime.subscribe(body.subscription, body.permit, { signal: scoped }) };
        scoped.throwIfAborted(); iterator = source[Symbol.asyncIterator]();
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no',
          ...(epoch ? { 'x-agentengine-history-epoch': epoch } : {}) });
        response.flushHeaders();
        for (;;) {
          const next = await iterator.next(); scoped.throwIfAborted(); if (next.done) break;
          const fact = next.value;
          const frame = fact === null ? ': heartbeat\n\n' : standardEvents
            ? `id: ${fact.seq}\ndata: ${canonical(platformFrame(fact))}\n\n`
            : `id: ${fact.seq}\nevent: session-event\ndata: ${canonical(fact)}\n\n`;
          if (!response.write(frame)) {
            await new Promise((resolve, reject) => {
              const onAbort = () => { cleanup(); reject(scoped.reason); };
              const onDrain = () => { cleanup(); resolve(); };
              const cleanup = () => { scoped.removeEventListener('abort', onAbort); response.off('drain', onDrain); };
              scoped.addEventListener('abort', onAbort, { once: true }); response.once('drain', onDrain); if (scoped.aborted) onAbort();
            });
          }
        }
        response.end();
      }
    } catch (error) {
      if (response.headersSent || scoped.aborted) response.destroy();
      else {
        const forbidden = ['NATIVE_KERNEL_PERMIT_INVALID', 'NATIVE_KERNEL_NONCE_REUSED'].includes(error.code);
        const bad = ['NATIVE_KERNEL_COMMAND_INVALID', 'NATIVE_KERNEL_HTTP_BODY_LIMIT', 'NATIVE_KERNEL_CURSOR_INVALID',
          'invalid_session_injection', 'session_injection_conflict',
          'execution_grant_id_invalid', 'execution_grant_id_required',
          'NATIVE_MANAGED_STUDIO_INPUT_UNSUPPORTED', 'NATIVE_MANAGED_STUDIO_ATTACHMENT_EXPIRED', 'NATIVE_MANAGED_STUDIO_IMAGE_INVALID',
          'engine_managed_options_invalid', 'engine_managed_model_unavailable', 'engine_tool_policy_requires_durable_approvals',
          'engine_input_images_invalid', 'engine_input_images_unsupported', 'engine_input_images_too_large',
          'invalid_model_json', 'duplicate_model_json_key', 'model_json_nesting_exceeded', 'model_json_integer_digits_exceeded',
          'non_finite_model_json_number', 'non_json_value'].includes(error.code)
          || error instanceof SyntaxError || error instanceof TypeError;
        const missing = error.code === 'NATIVE_KERNEL_SESSION_NOT_FOUND';
        json(response, forbidden ? 403 : missing || error.code === 'NATIVE_KERNEL_HTTP_UNSUPPORTED' ? 404 : bad ? 400 : 503,
          { error: { code: forbidden ? 'NATIVE_KERNEL_AUTHORIZATION_FAILED' : missing ? 'NATIVE_KERNEL_SESSION_NOT_FOUND'
            : bad ? 'NATIVE_KERNEL_INVALID_REQUEST' : 'NATIVE_KERNEL_UNAVAILABLE' } });
      }
    } finally {
      scoped.removeEventListener('abort', abort); disconnected.abort(); response.off('close', stop); responses.delete(response);
      try { if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {}); } catch {}
    }
  }
  return Object.freeze({ handle, close() { lifetime.abort(); for (const response of responses) response.destroy(); } });
}
