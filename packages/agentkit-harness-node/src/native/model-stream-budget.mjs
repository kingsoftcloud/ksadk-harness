import { ProtocolError } from './model-normalize.mjs';

export class ModelStreamLimitError extends ProtocolError {}

// Count assembled payload bytes only. Provider envelopes, keepalives and
// repeated terminal snapshots do not add to the retained content.
export function createModelStreamBudget(maxOutputBytes, maxToolBytes) {
  let outputBytes = 0;
  const toolBytes = new WeakMap();
  const retain = (bytes) => {
    if (outputBytes + bytes > maxOutputBytes) {
      throw new ModelStreamLimitError('assembled model output exceeded the byte limit', 'stream_output_limit');
    }
    outputBytes += bytes;
  };
  return {
    output(text) { retain(Buffer.byteLength(text)); },
    // Indexed items also retain state when their payload is empty.
    slot() { retain(128); },
    tool(call, fragment) {
      const bytes = Buffer.byteLength(fragment);
      const total = (toolBytes.get(call) ?? 0) + bytes;
      if (total > maxToolBytes) {
        throw new ModelStreamLimitError('assembled tool input exceeded the byte limit', 'tool_argument_limit');
      }
      retain(bytes);
      toolBytes.set(call, total);
    },
  };
}
