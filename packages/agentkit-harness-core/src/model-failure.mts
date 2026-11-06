import { invariant } from './values.mjs';

/** Observational only: these facts never authorize retries or tool execution. */
export const MODEL_FAILURE_CODES = [
  'host_binding', 'request_invalid', 'http_authentication', 'http_permission', 'http_client',
  'http_server', 'http_rate_limit', 'http_timeout', 'protocol_invalid', 'json_invalid',
  'envelope_invalid', 'provider_error', 'identity_conflict', 'usage_invalid', 'usage_conflict',
  'choice_invalid', 'delta_invalid', 'termination_conflict', 'framing_invalid', 'body_limit',
  'body_encoding', 'transport_error', 'stream_timeout', 'stream_incomplete', 'tool_payload_invalid',
] as const;
/** Closed provider identifiers only; arbitrary provider strings can contain credentials. */
export const MODEL_PROVIDER_ERROR_CODES = Object.freeze([
  'rate_limit_error', 'rate_limit_exceeded', 'overloaded_error', 'server_error',
  'api_error', 'service_unavailable_error', 'server_is_overloaded', 'timeout_error',
  'MODEL_PROVIDER_RATE_LIMIT', 'MODEL_PROVIDER_UNAVAILABLE',
  'invalid_request_error', 'invalid_api_key', 'authentication_error', 'permission_error',
  'not_found_error', 'request_too_large', 'billing_error', 'insufficient_quota',
  'MODEL_PROVIDER_AUTHENTICATION', 'MODEL_PROVIDER_PERMISSION', 'MODEL_PROVIDER_INVALID_REQUEST',
  'MODEL_PROVIDER_NOT_FOUND', 'MODEL_PROVIDER_QUOTA_EXHAUSTED',
] as const);
export const MODEL_PROVIDER_ERROR_TYPES = Object.freeze([...MODEL_PROVIDER_ERROR_CODES,
  'TooManyRequestsError', 'ServiceUnavailableError', 'RequestTimeoutError',
  'UnauthorizedError', 'ForbiddenError', 'InternalServerError', 'BadRequestError',
  'NotFoundError', 'AuthenticationError', 'PermissionDeniedError', 'RateLimitError',
] as const);
export interface ModelProviderErrorDiagnostic {
  category: 'rate_limit' | 'server_error' | 'request_timeout' | 'client_error' | 'invalid_response';
  fingerprint: string;
  code?: typeof MODEL_PROVIDER_ERROR_CODES[number];
  type?: typeof MODEL_PROVIDER_ERROR_TYPES[number];
  status?: number;
}
export interface ModelFailureDiagnostic {
  contract: 'model-failure-diagnostic/v1' | 'model-failure-diagnostic/v2' | 'model-failure-diagnostic/v3';
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'unknown';
  phase: 'binding' | 'request' | 'headers' | 'http-error' | 'stream' | 'buffered';
  code: typeof MODEL_FAILURE_CODES[number];
  frameIndex?: number;
  httpStatus?: number;
  /** Observational only. Raw error messages, headers and bodies are excluded. */
  providerError?: ModelProviderErrorDiagnostic;
  /** Observed counters only, never a replacement for the sealed billable usage. */
  usageConflict?: {
    previousFrameIndex: number;
    previous: ModelUsageCounters;
    reported: ModelUsageCounters;
  };
}
export interface ModelUsageCounters {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}
const usageCounterKeys = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens'];
function validUsageCounters(value: ModelUsageCounters): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'inputTokens') && Object.hasOwn(value, 'outputTokens')
    && Object.keys(value).every(key => usageCounterKeys.includes(key))
    && Object.values(value).every(count => Number.isSafeInteger(count) && count >= 0));
}
export function validateModelFailure(value: ModelFailureDiagnostic | undefined): void {
  if (value === undefined) return;
  invariant(value && ['model-failure-diagnostic/v1', 'model-failure-diagnostic/v2', 'model-failure-diagnostic/v3'].includes(value.contract)
    && Object.keys(value).every(key => ['contract', 'protocol', 'phase', 'code', 'frameIndex', 'httpStatus',
      ...(value.contract === 'model-failure-diagnostic/v2' ? ['usageConflict'] : []),
      ...(value.contract === 'model-failure-diagnostic/v3' ? ['providerError'] : [])].includes(key))
    && ['openai-chat', 'openai-responses', 'anthropic-messages', 'unknown'].includes(value.protocol)
    && ['binding', 'request', 'headers', 'http-error', 'stream', 'buffered'].includes(value.phase)
    && MODEL_FAILURE_CODES.includes(value.code)
    && (value.frameIndex === undefined || value.phase === 'stream' && Number.isSafeInteger(value.frameIndex) && value.frameIndex >= 0)
    && (value.httpStatus === undefined || value.phase === 'http-error' && Number.isSafeInteger(value.httpStatus)
      && value.httpStatus >= 100 && value.httpStatus <= 599), 'invalid_model_failure_diagnostic');
  if (value.contract === 'model-failure-diagnostic/v2') {
    const conflict = value.usageConflict;
    invariant(value.code === 'usage_conflict' && value.protocol === 'openai-chat' && value.phase === 'stream'
      && value.frameIndex !== undefined && conflict
      && Object.keys(conflict).sort().join(',') === 'previous,previousFrameIndex,reported'
      && Number.isSafeInteger(conflict.previousFrameIndex) && conflict.previousFrameIndex >= 0
      && conflict.previousFrameIndex < value.frameIndex
      && validUsageCounters(conflict.previous) && validUsageCounters(conflict.reported)
      && (conflict.previous.inputTokens !== conflict.reported.inputTokens
        || conflict.previous.outputTokens !== conflict.reported.outputTokens), 'invalid_model_failure_diagnostic');
  }
  if (value.contract === 'model-failure-diagnostic/v3') {
    const provider = value.providerError;
    invariant(value.code === 'provider_error' && ['openai-chat', 'openai-responses'].includes(value.protocol)
      && ['stream', 'buffered'].includes(value.phase) && provider && typeof provider === 'object'
      && !Array.isArray(provider) && Object.keys(provider).every(key => ['category', 'fingerprint', 'code', 'type', 'status'].includes(key))
      && ['rate_limit', 'server_error', 'request_timeout', 'client_error', 'invalid_response'].includes(provider.category)
      && typeof provider.fingerprint === 'string' && /^sha256:[0-9a-f]{64}$/.test(provider.fingerprint)
      && (provider.code === undefined || MODEL_PROVIDER_ERROR_CODES.includes(provider.code))
      && (provider.type === undefined || MODEL_PROVIDER_ERROR_TYPES.includes(provider.type))
      && (provider.status === undefined || Number.isInteger(provider.status) && provider.status >= 400 && provider.status <= 599),
    'invalid_model_failure_diagnostic');
  }
  invariant(!value.code.startsWith('http_') || value.phase === 'http-error' && value.httpStatus !== undefined
    && (value.code === 'http_authentication' ? value.httpStatus === 401
      : value.code === 'http_permission' ? value.httpStatus === 403
        : value.code === 'http_rate_limit' ? value.httpStatus === 429
          : value.code === 'http_timeout' ? value.httpStatus === 408
            : value.code === 'http_server' ? value.httpStatus >= 500
              : value.httpStatus >= 300 && value.httpStatus < 500
                && ![401, 403, 408, 429].includes(value.httpStatus)), 'invalid_model_failure_diagnostic');
}
