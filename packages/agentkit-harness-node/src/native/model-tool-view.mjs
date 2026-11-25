// Model-facing view of a tool result.
//
// Tool receipts are durable records: they carry fields the kernel needs for
// recovery, audit and verification (timestamps, digests, resource reports,
// backend identity). The model needs only the observation. This projection is
// applied when a request is put on the wire; stored receipts are not changed.
// It is a pure function of the receipt text, so a request prefix stays
// byte-identical across model calls and remains cacheable.
export const MODEL_TOOL_VIEW = 'agentkit.model-tool-view/v1';

/** Receipt fields that only the Host and kernel read. */
const HOST_ONLY_FIELDS = new Set(['controls', 'backend', 'sandbox_id', 'workspace_observation', 'mtime_ns', 'size_bytes',
  'preview_chars', 'read_range', 'absolute_path', 'diff_sha256', 'lint_model', 'process_timeout_seconds', 'schemaVersion', 'contract']);

function isRepositoryMetadata(entry) {
  return entry && typeof entry.path === 'string' && (entry.path === '.git' || entry.path.startsWith('.git/'));
}
function emptyField(key, value) {
  if (key === 'ok') return value === true;
  if (key === 'exit_code') return false;
  return value === false || value === null || value === '' || Array.isArray(value) && value.length === 0
    || typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** Return the text the model sees for one tool result. Non-JSON text passes through. */
export function modelToolView(text) {
  if (typeof text !== 'string' || !text) return text;
  // Re-serializing must not change an integer's digits (e.g. 9007199254740993
  // would become ...992). Such receipts pass through verbatim.
  let receipt, inexact = false;
  try {
    receipt = JSON.parse(text, (key, value, context) => {
      const source = context?.source;
      if (typeof value === 'number' && typeof source === 'string' && /^-?\d+$/.test(source) && JSON.stringify(value) !== source) inexact = true;
      return value;
    });
  } catch { return text; }
  if (inexact) return text;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return text;
  const view = { ...receipt };
  for (const key of Object.keys(view)) if (HOST_ONLY_FIELDS.has(key)) delete view[key];
  // The command text is already in the model's own tool call.
  if (typeof view.command === 'string' && ('stdout' in view || 'stderr' in view || 'exit_code' in view)) delete view.command;
  // Paging handles matter only while a command is still running.
  if (view.status !== 'running') {
    delete view.instruction; delete view.stdout_cursor; delete view.stderr_cursor;
    if ('exit_code' in view) delete view.task_id;
  }
  if (Array.isArray(view.entries)) {
    const omitted = view.entries.filter(isRepositoryMetadata).length;
    view.entries = view.entries.filter(entry => !isRepositoryMetadata(entry))
      .map(entry => entry && typeof entry.path === 'string' ? entry.path + (entry.type === 'directory' ? '/' : '') : entry);
    if (omitted) view.git_entries_omitted = omitted;
  }
  for (const [key, value] of Object.entries(view)) if (emptyField(key, value)) delete view[key];
  // A successful file read is shown as text with a one-line header.
  if (typeof view.content === 'string' && typeof view.path === 'string' && view.ok !== false && !view.errors && !view.code) {
    const range = Number.isSafeInteger(view.start_line)
      ? ` lines ${view.start_line}-${view.end_line} of ${view.total_lines ?? view.line_count}` : '';
    const flags = [view.truncated && 'truncated', view.partial && 'partial'].filter(Boolean).join(', ');
    return `[${view.path}${range}${flags ? ` (${flags})` : ''}]\n${view.content}`;
  }
  return JSON.stringify(view);
}
