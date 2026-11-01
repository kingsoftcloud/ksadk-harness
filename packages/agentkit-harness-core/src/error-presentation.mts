/** Public diagnostic projection shared by adapters and browser presentation.
 * Apply before bounding so a truncated credential cannot escape recognition.
 * This is for diagnostics only; successful file/terminal content is not input.
 */
export function redactDiagnosticText(input: unknown, maxChars = 2048): string {
  const text = typeof input === 'string' ? input : '';
  const credential = '(?:authorization|proxy-authorization|api[_-]?key|access[_-]?key(?:[_-]?(?:id|secret))?|secret(?:[_-]?key)?|password|passwd|token|access[_-]?token|refresh[_-]?token|session[_-]?(?:id|token)|client[_-]?secret|cookie|set-cookie|signature|KSSAccessKeyId|KSSSecurityToken)';
  const cleaned = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, '[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/<>"']*@/gi, '$1[redacted]@')
    .replace(new RegExp(`(["']?${credential}["']?\\s*[=:]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s&,;<>]+)`, 'gi'), '$1[redacted]')
    .replace(/\b(?:sk|ak|tok)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? Math.min(maxChars, 8192) : 2048;
  return cleaned.length <= limit ? cleaned : cleaned.slice(0, Math.max(0, limit - 1)) + '…';
}

export function publicErrorMessage(error: unknown, fallback = 'Tool operation failed.'): string {
  const message = error && typeof error === 'object' && 'message' in error ? (error as { message?: unknown }).message : error;
  return redactDiagnosticText(message, 1024) || fallback;
}

export function publicErrorCode(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(code)
    && redactDiagnosticText(code) === code ? code : fallback;
}

/** Project diagnostic fields without rewriting receipts, locators or inputs. */
export function publicFailureContent<T extends Record<string, unknown>>(content: T): T {
  const result = { ...content };
  for (const key of ['message', 'error_message', 'errorMessage', 'detail'] as const) {
    if (typeof result[key] === 'string') (result as Record<string, unknown>)[key] = redactDiagnosticText(result[key], 1024);
  }
  for (const key of ['code', 'error_type'] as const) {
    if (typeof result[key] === 'string') (result as Record<string, unknown>)[key] = publicErrorCode({ code: result[key] }, 'TOOL_OPERATION_FAILED');
  }
  return result;
}
