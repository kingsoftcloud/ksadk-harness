/** Compact receipts from the admitted local command tool. All other payloads
 * keep their original framing and fields, including workspace and MCP data. */
export function modelToolView(text, toolName, tools) {
  if (typeof text !== 'string' || !text) return text;
  if (toolName !== 'run_command' || !tools?.some(tool => tool.name === toolName
    && tool.backgroundCommandPolicy === 'owned-command-launch/v1'
    && tool.workspaceChangePolicy === 'observed-command/v1'
    && tool.permissions?.includes('sandbox:execute'))) return text;
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
  if (inexact || receipt?.backend !== 'sandbox/local_process') return text;
  // Output stays cursor-readable after the process exits. Preserve the task ID,
  // cursors and paging instruction along with status and truncation evidence.
  const { command, controls, sandbox_id, ...view } = receipt;
  return JSON.stringify(view);
}
