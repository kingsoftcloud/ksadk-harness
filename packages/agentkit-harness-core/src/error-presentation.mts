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
  return redactDiagnosticText(message, 1024) || redactDiagnosticText(fallback, 1024) || 'Tool operation failed.';
}

export function publicErrorCode(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  const valid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value)
    && redactDiagnosticText(value) === value;
  return valid(code) ? code : fallback === '' || valid(fallback) ? fallback : 'TOOL_OPERATION_FAILED';
}

/** Project diagnostic fields without rewriting receipts, locators or inputs. */
export function publicFailureContent<T extends Record<string, unknown>>(content: T): T {
  // Field names supply the context absent from an otherwise innocuous bare
  // value. Locator identifiers (sessionId, operationKey, etc.) are not secrets.
  const credentialFields = new Set(['password', 'passwd', 'dbpassword', 'databasepassword', 'secret', 'secrets', 'secretkey',
    'secretaccesskey', 'apikey', 'apitoken', 'accesskey', 'accesskeyid', 'accesskeysecret', 'authorization', 'proxyauthorization',
    'cookie', 'setcookie', 'token', 'accesstoken', 'refreshtoken', 'sessiontoken', 'idtoken', 'bearertoken', 'authtoken', 'clientsecret',
    'kssaccesskeyid', 'ksssecuritytoken', 'awsaccesskeyid', 'awssecretaccesskey', 'awssessiontoken', 'xapikey', 'xauthtoken',
    'xamzsecuritytoken', 'csrftoken', 'xcsrftoken', 'credentials', 'privatekey', 'sshprivatekey', 'connectionstring']);
  const isCredential = (key: string) => credentialFields.has(key.replace(/[-_.\s]/g, '').toLowerCase());
  const diagnosticFields = new Set(['message', 'error_message', 'errorMessage', 'error_description', 'detail', 'details', 'error', 'cause', 'stack', 'reason', 'reason_message', 'reasonMessage', 'hint']);
  const codeFields = new Set(['code', 'error_type', 'error_code', 'errorCode']);
  const ancestors = new Set<object>();
  let remaining = 10000;
  function project(value: unknown, diagnostic: boolean, depth: number): unknown {
    if (--remaining < 0 || depth > 32) return '[Diagnostic projection limit]';
    if (typeof value === 'string') return diagnostic ? redactDiagnosticText(value, 1024) : value;
    if (value === null || typeof value !== 'object') return value;
    if (ancestors.has(value)) return '[Circular diagnostic]';
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map(item => project(item, diagnostic, depth + 1));
      // Error.message/stack/cause are non-enumerable, unlike ordinary payloads.
      const keys = new Set(Object.keys(value));
      if (value instanceof Error) for (const key of ['message', 'stack', 'cause', 'code'])
        if (Object.hasOwn(value, key)) keys.add(key);
      const fields = value as Record<string, unknown>;
      const namedCredential = ['name', 'key'].some(key => typeof fields[key] === 'string' && isCredential(fields[key] as string));
      return Object.fromEntries([...keys].map(key => {
        const item = (value as Record<string, unknown>)[key];
        if (isCredential(key) || (namedCredential && key === 'value')) return [key, '[redacted]'];
        // Empty optional diagnostic codes mean "absent" in typed Skill events.
        // They carry no secret and must remain stable execution evidence.
        return [key, codeFields.has(key) && typeof item === 'string' && item !== ''
          ? publicErrorCode({ code: item }, 'TOOL_OPERATION_FAILED')
          : project(item, diagnostic || diagnosticFields.has(key), depth + 1)];
      }));
    } finally { ancestors.delete(value); }
  }
  return project(content, false, 0) as T;
}
