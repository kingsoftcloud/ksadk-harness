// Shared OpenAI-compatible provider error classification for JSON and SSE.
// HTTP transport status is handled separately. Never infer retries from raw
// messages or retain provider bytes; unknown/malformed envelopes fail closed.
const RETRYABLE_ERROR_CODES = new Set([
  'rate_limit_error', 'rate_limit_exceeded', 'overloaded_error', 'server_error',
  'api_error', 'service_unavailable_error', 'server_is_overloaded', 'timeout_error',
  'MODEL_PROVIDER_RATE_LIMIT', 'MODEL_PROVIDER_UNAVAILABLE',
]);
const TERMINAL_ERROR_CODES = new Set([
  'invalid_request_error', 'invalid_api_key', 'authentication_error',
  'permission_error', 'not_found_error', 'request_too_large', 'billing_error',
  'insufficient_quota', 'MODEL_PROVIDER_AUTHENTICATION', 'MODEL_PROVIDER_PERMISSION',
  'MODEL_PROVIDER_INVALID_REQUEST', 'MODEL_PROVIDER_NOT_FOUND',
  'MODEL_PROVIDER_QUOTA_EXHAUSTED',
]);

export function classifyOpenAIProviderError(error) {
  const invalid = { kind: 'provider_terminal_error', failureKind: 'invalid_response' };
  if (!error || typeof error !== 'object' || Array.isArray(error)) return invalid;
  const codes = [error.code, error.type].filter(value => value != null);
  if (codes.some(value => typeof value !== 'string')) return invalid;
  // A permanent quota/auth/request failure must never be retried just because
  // a generic outer type also says rate_limit_error or server_error.
  if (codes.some(value => TERMINAL_ERROR_CODES.has(value))) {
    return { kind: 'provider_terminal_error', failureKind: 'client_error' };
  }
  const code = codes.find(value => RETRYABLE_ERROR_CODES.has(value));
  if (code) return { kind: 'provider_retryable_error',
    failureKind: ['rate_limit_error', 'rate_limit_exceeded', 'MODEL_PROVIDER_RATE_LIMIT'].includes(code) ? 'rate_limit'
      : code === 'timeout_error' ? 'request_timeout' : 'server_error' };
  return invalid;
}
