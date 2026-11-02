import { publicFailureContent, redactDiagnosticText } from '@kingsoftcloud/agentkit-harness-core/error-presentation';

function diagnosticContent(content) {
  if (typeof content === 'string') return redactDiagnosticText(content, 1024);
  if (Array.isArray(content)) return content.map(diagnosticContent);
  if (!content || typeof content !== 'object') return content;
  // Text blocks and nested MCP envelopes are diagnostic content on this path;
  // do not traverse call arguments, receipts, media bytes or locators as text.
  return { ...content,
    ...(typeof content.text === 'string' ? { text: redactDiagnosticText(content.text, 1024) } : {}),
    ...(Object.hasOwn(content, 'content') ? { content: diagnosticContent(content.content) } : {}) };
}

/** One public boundary for failed, uncertain and approval-required results.
 * Successful tool data is not diagnostic input. Keep timing, thrown errors,
 * receiver, lifecycle callbacks and effect/interaction identities unchanged.
 */
export function publicToolResult(result) {
  if (!result || typeof result !== 'object' || result.status === 'ok') return result;
  const projected = publicFailureContent(result);
  if (Object.hasOwn(projected, 'content')) return { ...projected, content: diagnosticContent(projected.content) };
  // Authorizers may return a top-level decision rather than a ToolResult.
  // The Kernel persists JSON content; absence is null, never undefined. This
  // does not infer executed:false or change the original interaction identity.
  return projected.status === 'approval_required' ? { ...projected, content: null } : projected;
}

export function publicToolExecution(execute) {
  return function (...args) {
    const result = execute.apply(this, args);
    return result && typeof result.then === 'function'
      ? result.then(publicToolResult) : publicToolResult(result);
  };
}
