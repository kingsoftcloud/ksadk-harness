// Native model protocol adapter: one host-resolved HTTP request per attempt.
//
// createNativeModelPort({ resolveProfile, fetchImpl, maxResponseBytes,
//   idleTimeoutMs }) -> ModelPort. generate(request, emit) resolves a host-owned
// binding, issues exactly ONE HTTP request, streams text/thinking/tool_delta
// display deltas, and returns one sealed ModelResult. The adapter never retries
// and never executes tools; kernel policy owns backoff, call budgets and tool
// execution.
//
// The binding's apiKey is placed only in the Authorization/x-api-key header and
// never persisted in request, messages or result. binding.parameters may add
// generation fields but never override messages/tools/model/stream or
// security-sensitive transport values. Caller signal, body size and idle
// silence are all bounded.

import {
  emptyUsage, parseRetryAfterMs, sanitizeFailureKind, ProtocolError,
} from './model-normalize.mjs';
import {
  readModelSse, SseFramingError, IdleTimeout,
} from './model-sse.mjs';
import {
  parseOpenAIBuffered, createOpenAIStreamTurn,
} from './model-openai-chat.mjs';
import {
  parseAnthropicBuffered, createAnthropicStreamState,
} from './model-anthropic.mjs';
import {
  parseResponsesBuffered, createResponsesStreamState,
} from './model-responses.mjs';
import { MediaError } from './model-media.mjs';
import { buildNativeModelRequest } from './model-request.mjs';
// parseModelJson is the kernel's strict finite JSON parser; used here for the
// 400 context-length error heuristic so a malformed error body is never parsed
// as a lenient ambiguity.
import { parseModelJson, MODEL_FAILURE_CODES, MODEL_GATEWAY_ERROR_CODES, MODEL_GATEWAY_ERROR_TYPES,
  isModelGatewayRequestId } from '@kingsoftcloud/agentkit-harness-core';
import { observeModelTransportPort } from './model-transport-observation.mjs';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_IDLE_MS = 180000;

/** Only the adapter's plain inference request is admitted for cold replay.
 * Profile extensions can enable provider behavior we cannot prove pure. Keep
 * those manual until their semantics have an explicit Host admission contract.
 * A replay remains a new billed attempt; the ledger retains uncertain usage. */
export function nativeModelRecoveryPolicy({ protocol, parameters = {} } = {}) {
  return ['openai-chat', 'openai-responses', 'anthropic-messages'].includes(protocol)
    && parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters)
    && Object.keys(parameters).length === 0 ? 'pure-inference/v1' : 'manual';
}

// A response body exceeded maxResponseBytes: terminal, never a truncated final.
class OverflowError extends Error {
  constructor() { super('response body exceeded maxResponseBytes'); this.name = 'OverflowError'; }
}

export function createNativeModelPort({
  resolveProfile,
  fetchImpl = fetch,
  maxResponseBytes = DEFAULT_MAX_BYTES,
  idleTimeoutMs = DEFAULT_IDLE_MS,
} = {}) {
  if (typeof resolveProfile !== 'function') {
    throw new TypeError('createNativeModelPort requires a resolveProfile function');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createNativeModelPort requires a fetchImpl function');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new RangeError('maxResponseBytes must be a positive safe integer');
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) throw new RangeError('idleTimeoutMs must be positive and finite');
  const maxBytes = maxResponseBytes;
  const idleTimeout = idleTimeoutMs;

  return observeModelTransportPort(async (request, emitEvent, observation) => {
      if (!request || typeof request !== 'object' || !request.profile) {
        return withFailure(terminalResult('invalid_response'), null, 'request', 'request_invalid');
      }

      // 1. Resolve the host-owned binding. A host hook failure is terminal and
      // sanitized: exception text may carry credentials, so only the kind leaks.
      let binding;
      try {
        binding = await resolveProfile(request.profile, request);
      } catch {
        return withFailure(terminalResult('host_error'), null, 'binding', 'host_binding');
      }

      // 2. Build the wire request. Pre-flight validation of the binding, profile
      // or media is terminal; the adapter never calls HTTP with a bad binding.
      let built;
      try {
        built = buildNativeModelRequest(binding, request);
      } catch (error) {
        const failureKind = (error instanceof ProtocolError || error instanceof MediaError)
          ? 'invalid_response' : 'client_error';
        return withFailure(terminalResult(failureKind), binding, 'request', 'request_invalid');
      }

      // 3. One fetch with a combined signal: the caller's signal plus an internal
      // controller that bounds overall wall time. Redirects are disabled so a 3xx
      // is a terminal client error, never a silent second request.
      const internal = new AbortController();
      const signals = [internal.signal];
      if (request.signal) signals.push(request.signal);
      const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      let overallTimer = null;
      const overallMs = Number(request.profile?.requestTimeoutMs);
      if (Number.isFinite(overallMs) && overallMs > 0) {
        overallTimer = setTimeout(() => internal.abort(new IdleTimeout()), overallMs);
        overallTimer.unref?.();
      }

      let response;
      try {
        observation.phase('headers');
        response = await fetchImpl(built.url, {
          method: 'POST',
          headers: built.headers,
          body: built.body,
          signal: combined,
          redirect: 'manual',
        });
        observation.headers();
      } catch (error) {
        clearTimer(overallTimer);
        // Honor a caller-initiated abort by propagating it.
        if (request.signal?.aborted) throw error;
        if (internal.signal.aborted) return withFailure(retryableResult('request_timeout'), binding, 'headers', 'stream_timeout');
        return withFailure(retryableResult(sanitizeFailureKind(error, 'network_error')), binding, 'headers', 'transport_error');
      }

      // 4. Dispatch. The overall timer stays armed through body reads so a
      // server that sends headers then hangs the body is bounded; the finally
      // clears the timer and cancels any unconsumed body so no connection leaks
      // (e.g. a 429 whose body was never read).
      try {
        if (!response.ok) {
          observation.phase('http-error');
          const body = await readHttpError(response, maxBytes);
          const result = classifyHttpError(response, body);
          const gateway = httpGatewayDiagnostic(response, body);
          request.signal?.throwIfAborted();
          const code = response.status === 401 ? 'http_authentication' : response.status === 403 ? 'http_permission'
            : response.status === 429 ? 'http_rate_limit' : response.status === 408 ? 'http_timeout'
              : response.status >= 500 ? 'http_server' : 'http_client';
          return withFailure(result, binding, 'http-error', code, { httpStatus: response.status, ...(gateway ? { gateway } : {}) });
        }
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream')) {
          observation.phase('stream');
          const idlePolicy = request.profile.streaming !== false && request.profile.streamTimeoutPolicy === 'idle/v1';
          if (idlePolicy) { clearTimer(overallTimer); overallTimer = null; }
          return await streamResponse(response, request, binding, emitEvent, internal, maxBytes,
            idlePolicy && overallMs > 0 ? Math.min(idleTimeout, overallMs) : idleTimeout, observation);
        }
        observation.phase('buffered');
        return await bufferedResponse(response, request, binding, maxBytes, emitEvent, observation);
      } catch (error) {
        if (request.signal?.aborted) throw error;
        if (error instanceof IdleTimeout || internal.signal.aborted) {
          return withFailure(retryableResult('request_timeout'), binding, 'buffered', 'stream_timeout');
        }
        // Overflow, bad UTF-8, or a transport error mid-body: a partial body is
        // never sealed as a final; the attempt is terminal invalid_response.
        return withFailure(terminalResult('invalid_response'), binding, 'buffered', error instanceof OverflowError
          ? 'body_limit' : error instanceof TypeError && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
            ? 'body_encoding' : protocolCode(error));
      } finally {
        clearTimer(overallTimer);
        cancelBody(response);
      }
  });
}

async function streamResponse(response, request, binding, emit, internal, maxBytes, idleTimeoutMs, observation) {
  const profile = request.profile;
  const idlePolicy = profile.streaming !== false && profile.streamTimeoutPolicy === 'idle/v1';
  const state = binding.protocol === 'anthropic-messages'
    ? createAnthropicStreamState(profile)
    : binding.protocol === 'openai-responses'
      ? createResponsesStreamState(profile)
      : createOpenAIStreamTurn(profile, binding);
  // Idle silence aborts the fetch via the internal controller so the pending
  // body read rejects cleanly instead of leaving an orphaned read to cancel.
  const abort = (reason) => internal.abort(reason);
  let frameIndex = -1;
  // Bound only a sustained, exact cycle before the response produces text or
  // tool arguments. Inspect a small suffix independent of SSE chunk boundaries.
  let reasoning = request.purpose == null || request.purpose === 'task' ? '' : null;
  let sinceCheck = 0;
  let repetition = false;
  const observe = event => {
    if ((event.kind === 'text' && event.text.trim()) || event.kind === 'tool_delta') reasoning = null;
    if (reasoning !== null && event.kind === 'thinking' && event.text) {
      reasoning = (reasoning + event.text).slice(-1024);
      sinceCheck += event.text.length;
      if (reasoning.length === 1024 && sinceCheck >= 128) {
        sinceCheck = 0;
        for (let size = 1; size <= 64; size++) {
          if (reasoning.slice(size) !== reasoning.slice(0, -size)) continue;
          repetition = true;
          break;
        }
      }
    }
    emit(event);
  };
  const failed = (result, code, fields = {}) => withFailure(result, binding, 'stream', code,
    { ...(frameIndex < 0 ? {} : { frameIndex }),
      ...(code === 'usage_conflict' && state.usageConflict ? { usageConflict: state.usageConflict } : {}), ...fields });
  try {
    for await (const frame of readModelSse(response.body, { maxBytes, idleTimeoutMs, abort, observeBytes: observation.bytes })) {
      if (idlePolicy && !frame.data.trim()) continue;
      frameIndex++;
      observation.frame();
      state.consume(frame, observe);
      if (repetition && reasoning !== null && !state.done) {
        abort(new Error('reasoning_repetition'));
        return failed({ kind: 'output_limit', text: '', toolCalls: [], usage: emptyUsage(), usageReported: false,
          textCommitVersion: 'provider-finished-text/v1', outputBoundary: 'no-visible-output/v1' }, 'reasoning_repetition');
      }
      if (idlePolicy) emit({ kind: 'activity', text: '' });
      if (state.done) break;
    }
  } catch (error) {
    if (request.signal?.aborted) throw error; // caller cancel propagates
    if (error instanceof IdleTimeout) {
      return failed(state.finalize({ errorKind: 'provider_retryable_error', failureKind: 'request_timeout' }), 'stream_timeout');
    }
    if (error instanceof SseFramingError) {
      return failed(state.finalize({ errorKind: 'provider_terminal_error', failureKind: 'invalid_response' }), protocolCode(error));
    }
    if (error instanceof ProtocolError) {
      // Typed provider error envelopes carry a closed, credential-free classification.
      if (error.streamError) {
        return failed(state.finalize({ errorKind: error.streamError.kind, failureKind: error.streamError.failureKind }), 'provider_error',
          error.streamError.diagnostic ? { providerError: error.streamError.diagnostic } : {});
      }
      return failed(state.finalize({ errorKind: 'provider_terminal_error', failureKind: 'invalid_response' }), protocolCode(error));
    }
    if (internal.signal.aborted) {
      // An overall-timeout abort (and any idle abort that surfaced as a
      // transport error) is a retryable request timeout, never a final.
      return failed(state.finalize({ errorKind: 'provider_retryable_error', failureKind: 'request_timeout' }), 'stream_timeout');
    }
    return failed(state.finalize({ errorKind: 'provider_retryable_error', failureKind: sanitizeFailureKind(error, 'network_error') }), 'transport_error');
  }
  const result = state.finalize();
  return failed(result, state.streamError ? 'provider_error' : result.kind === 'malformed_tool_call' ? 'tool_payload_invalid'
    : result.failureKind === 'incomplete_response' ? 'stream_incomplete' : 'protocol_invalid',
  state.streamError?.diagnostic ? { providerError: state.streamError.diagnostic } : {});
}

async function bufferedResponse(response, request, binding, maxBytes, emit, observation) {
  const bodyText = await readBoundedText(response, maxBytes, observation.bytes);
  const captureReplay = request.profile?.providerReplayMode !== 'none';
  // Keep legacy buffered admissions unchanged. New visibility admissions also
  // retain explicitly provided display reasoning when a server returns JSON.
  const onThinking = request.profile.providerThinkingDisplayPolicy === 'provider-visible/v1'
    && request.profile.providerThinkingDisplay === true ? text => { if (text) emit({ kind: 'thinking', text }); } : undefined;
  try {
    if (binding.protocol === 'anthropic-messages') {
      return withFailure(parseAnthropicBuffered(bodyText, request, { captureReplay, onThinking }), binding, 'buffered', 'protocol_invalid');
    }
    if (binding.protocol === 'openai-responses') {
      return withFailure(parseResponsesBuffered(bodyText, request, { captureReplay, onThinking }), binding, 'buffered', 'protocol_invalid');
    }
    return withFailure(parseOpenAIBuffered(bodyText, request, { captureReplay, binding, onThinking }), binding, 'buffered', 'protocol_invalid');
  } catch (error) {
    if (error instanceof ProtocolError && error.streamError) {
      const result = { ...terminalResult(error.streamError.failureKind), kind: error.streamError.kind };
      return withFailure(result, binding, 'buffered', 'provider_error',
        error.streamError.diagnostic ? { providerError: error.streamError.diagnostic } : {});
    }
    return withFailure(terminalResult('invalid_response'), binding, 'buffered', protocolCode(error));
  }
}

// Diagnostics are observational. Neither body identifiers nor correlation
// headers change retry behavior, except for the existing context-overflow rule.
function classifyHttpError(response, body) {
  const status = response.status;
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
  if (status === 408) return retryableResult('request_timeout', retryAfterMs);
  if (status === 429) return retryableResult('rate_limit', retryAfterMs);
  if (status >= 500 && status <= 599) return retryableResult('server_error', retryAfterMs);
  if (status === 403) return { kind: 'policy_abort', text: '', toolCalls: [], usage: emptyUsage(), usageReported: false };
  if (status === 400 && (body?.error?.code === 'context_length_exceeded' || body?.error?.type === 'context_length_exceeded')) {
    return { kind: 'context_overflow', text: '', toolCalls: [], usage: emptyUsage(), usageReported: false };
  }
  return terminalResult('client_error');
}

async function readHttpError(response, maxBytes) {
  const contextCheck = response.status === 400;
  // Keep the original 400 compatibility check. For other statuses this is
  // optional evidence; a stalled error body must not delay retries.
  if (!contextCheck && !response.body?.getReader) return null;
  try {
    return parseModelJson(await readBoundedText(response, contextCheck ? maxBytes : Math.min(maxBytes, 8192),
      undefined, contextCheck ? undefined : AbortSignal.timeout(200)));
  } catch { return null; }
}

function httpGatewayDiagnostic(response, body) {
  const diagnostic = {};
  const error = body?.error && typeof body.error === 'object' ? body.error : body;
  if (MODEL_GATEWAY_ERROR_CODES.includes(error?.code)
    || Number.isInteger(error?.code) && error.code >= 400 && error.code <= 599) diagnostic.code = error.code;
  if (MODEL_GATEWAY_ERROR_TYPES.includes(error?.type)) diagnostic.type = error.type;
  const requestId = ['x-request-id', 'request-id', 'x-ksc-request-id']
    .map(header => response.headers.get(header)).find(isModelGatewayRequestId);
  if (requestId) diagnostic.requestId = requestId;
  return Object.keys(diagnostic).length ? diagnostic : null;
}

function terminalResult(failureKind) {
  return { kind: 'provider_terminal_error', text: '', toolCalls: [], usage: emptyUsage(), usageReported: false, failureKind };
}

// A closed enum, rather than exception messages, crosses the model boundary.
// This is diagnostic evidence only; original classification/retry policy stays intact.
function protocolCode(error) {
  return (error instanceof ProtocolError || error instanceof SseFramingError) && MODEL_FAILURE_CODES.includes(error.code)
    ? error.code : 'protocol_invalid';
}
function withFailure(result, binding, phase, code, fields = {}) {
  if (!['provider_terminal_error', 'provider_retryable_error', 'policy_abort', 'malformed_tool_call'].includes(result.kind)
    && !(result.kind === 'output_limit' && code === 'reasoning_repetition')
    && !(result.kind === 'context_overflow' && fields.gateway)) return result;
  const protocol = ['openai-chat', 'openai-responses', 'anthropic-messages'].includes(binding?.protocol) ? binding.protocol : 'unknown';
  return { ...result, failureDiagnostic: { contract: fields.gateway ? 'model-failure-diagnostic/v4'
    : fields.providerError ? 'model-failure-diagnostic/v3' : fields.usageConflict
    ? 'model-failure-diagnostic/v2' : 'model-failure-diagnostic/v1', protocol, phase, code, ...fields } };
}

function retryableResult(failureKind, retryAfterMs = null) {
  const result = { kind: 'provider_retryable_error', text: '', toolCalls: [], usage: emptyUsage(), usageReported: false, failureKind };
  if (Number.isFinite(retryAfterMs) && retryAfterMs != null && retryAfterMs >= 0) {
    result.retryAfterMs = retryAfterMs;
  }
  return result;
}

function clearTimer(timer) {
  if (timer) clearTimeout(timer);
}

// Cancel an unconsumed response body so the underlying connection is released
// (e.g. a 429 whose body was never read). Safe to call on a consumed/locked/
// errored body: a cancel that cannot proceed, or rejects because the stream
// was aborted, is swallowed so it never surfaces as an unhandled rejection.
function cancelBody(response) {
  try {
    const result = response?.body?.cancel?.();
    if (result && typeof result.then === 'function') result.catch(() => {});
  } catch { /* already locked/consumed */ }
}

// Read a response body as strict UTF-8 text, failing on overflow rather than
// truncating a prefix (a JSON prefix + overflow suffix must not masquerade as a
// complete response). Reads to EOF before sealing. Throws OverflowError on
// overflow; propagates abort and bad-UTF-8 errors for the caller to classify.
async function readBoundedText(response, maxBytes, observeBytes, signal) {
  const body = response.body;
  if (body == null) return '';
  const reader = body.getReader ? body.getReader() : null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  const chunks = [];
  if (reader) {
    const abort = () => { void reader.cancel().catch(() => {}); };
    try {
      signal?.throwIfAborted();
      signal?.addEventListener('abort', abort, { once: true });
      while (true) {
        const { value, done } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        if (!value) continue;
        if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new ProtocolError('body requires bytes');
        total += value.byteLength;
        observeBytes?.(value.byteLength);
        if (total > maxBytes) throw new OverflowError();
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join('');
    } finally {
      signal?.removeEventListener('abort', abort);
      reader.releaseLock?.();
    }
  }
  // Async-iterable fallback.
  for await (const value of body) {
    if (!value) continue;
    if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new ProtocolError('body requires bytes');
    total += value.byteLength;
    observeBytes?.(value.byteLength);
    if (total > maxBytes) throw new OverflowError();
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}
