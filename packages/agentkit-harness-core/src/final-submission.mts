import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { Json, ObjectValue, RunConfiguration, ToolCall, ToolDefinition } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { parseModelJson } from './model-json.mjs';
import { compileWithExactIntegers, removeExactIntegerSchema } from './exact-integer-schema.mjs';
import { RESULT_DELIVERY_POLICY, deliverySchemaForRun, usesHistoricalDeliveryTools, deliveryArtifacts, deliveryManifestChanges,
  currentDeliveryManifest } from './deliverables.mjs';
import type { RunSnapshot } from './contracts.mjs';

export const FINAL_SUBMISSION_TOOL = 'submit_final_output';
const historicalDescription = 'Submit your final answer and optional workspace artifacts together. Use answer for the complete user-facing answer (or the required structured output object). Include only delivery artifacts, excluding references and temporary files. For a runnable web page use kind=web with its relative entry path and project root; documents and source files use kind=file. Omitted artifacts retain an earlier selection, otherwise the delivery is the text answer. This does not execute tools or establish acceptance. No separate declaration is needed.';
const currentDescription = 'Submit your final answer and optional workspace artifacts together. Use answer for the complete user-facing answer (or the required structured output object). Include only delivery artifacts, excluding references and temporary files. For example, {"kind":"file","path":"src/index.js"} uses no root. A runnable web page uses a workspace-relative root, for example {"kind":"web","path":"site/index.html","root":"site"}. Omitted artifacts retain an earlier selection, otherwise the delivery is the text answer. This does not execute tools or establish acceptance. No separate declaration is needed.';
const validator = new Ajv2020({ strict: false, validateFormats: false, ownProperties: true, addUsedSchema: false, passContext: true });
const compiled = new Map<string, { schema: ObjectValue; validate: ValidateFunction }>();

function bounded(value: Json, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(item => bounded(item, depth + 1));
  return !['$ref', '$dynamicRef', '$recursiveRef'].some(key => Object.hasOwn(value, key))
    && Object.values(value).every(item => bounded(item, depth + 1));
}
function compile(schema: ObjectValue): ValidateFunction {
  const key = canonical(schema), cached = compiled.get(key);
  if (cached) return cached.validate;
  schema = copy(schema);
  // Match the reference's bounded, ASCII-escaped JSON including separator spaces.
  let length = 0, quoted = false, escaped = false;
  for (const character of key.split('')) {
    length += character.charCodeAt(0) >= 127 ? 6 : 1;
    if (!quoted && (character === ':' || character === ',')) length++;
    if (escaped) escaped = false;
    else if (quoted && character === '\\') escaped = true;
    else if (character === '"') quoted = !quoted;
  }
  invariant(schema.type === 'object' && length <= 16384 && bounded(schema), 'invalid_final_submission_schema');
  let validate: ValidateFunction;
  try { validate = compileWithExactIntegers(validator, schema); }
  catch { invariant(false, 'invalid_final_submission_schema'); }
  if (compiled.size >= 64) {
    const oldest = compiled.keys().next().value!;
    const record = compiled.get(oldest)!;
    validator.removeSchema(record.schema); removeExactIntegerSchema(validator, record.validate); compiled.delete(oldest);
  }
  compiled.set(key, { schema, validate }); return validate;
}
export function submissionOutputFormat(schema: ObjectValue, payloadKey: string | null): 'text' | 'json_object' | 'json_value' {
  const properties = schema.properties;
  const property = payloadKey === null ? schema
    : properties && typeof properties === 'object' && !Array.isArray(properties) ? properties[payloadKey] : undefined;
  invariant(property && typeof property === 'object' && !Array.isArray(property), 'invalid_final_submission_payload');
  if (property.type === 'object') return 'json_object';
  if (payloadKey && property.type === 'string') return 'text';
  invariant(payloadKey && typeof property.type === 'string'
    && ['integer', 'number', 'boolean', 'array', 'null'].includes(property.type), 'invalid_final_submission_payload');
  return 'json_value';
}
export function validateSubmissionContract(config: RunConfiguration): void {
  const { finalSubmissionSchema: schema, finalSubmissionPayloadKey: key } = config.contract;
  invariant(!config.tools.some(tool => tool.name === FINAL_SUBMISSION_TOOL), 'reserved_final_submission_tool');
  if (config.deliveryScopePolicy === RESULT_DELIVERY_POLICY) compile(finalSubmissionTool(config)!.parameters);
  if (!schema) { invariant(key === null, 'final_submission_schema_missing'); return; }
  compile(schema);
  if (key !== null) invariant(key.trim() && Array.isArray(schema.required) && schema.required.includes(key), 'invalid_final_submission_payload');
  invariant(submissionOutputFormat(schema, key) === config.contract.finalOutputFormat, 'final_submission_format_mismatch');
}
export function finalSubmissionTool(config: RunConfiguration): ToolDefinition | null {
  const atomic = config.deliveryScopePolicy === RESULT_DELIVERY_POLICY;
  const schema = atomic ? { type: 'object', additionalProperties: false, required: ['answer'], properties: {
    answer: config.contract.finalSubmissionSchema ?? { type: 'string' }, artifacts: deliverySchemaForRun(config) } }
    : config.contract.finalSubmissionSchema;
  if (!schema) return null;
  return { name: FINAL_SUBMISSION_TOOL, description: atomic
    ? usesHistoricalDeliveryTools(config) ? historicalDescription : currentDescription
    : 'Submit the final structured answer for host verification. This does not execute a workspace action.',
    parameters: schema, readOnly: true, concurrentSafe: false, permissions: [], timeoutMs: 1,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' };
}
export function finalSubmissionFailure(calls: readonly ToolCall[], config: RunConfiguration): ObjectValue {
  if (calls.length !== 1) return { reason: 'final_submission_batch_invalid', message: 'Call submit_final_output by itself.' };
  const call = calls[0]!;
  const artifacts = call.arguments.artifacts;
  if (config.deliveryScopePolicy === RESULT_DELIVERY_POLICY && Array.isArray(artifacts)) {
    const index = artifacts.findIndex(item => item && typeof item === 'object' && !Array.isArray(item)
      && item.kind === 'file' && Object.hasOwn(item, 'root'));
    if (index >= 0) return { reason: 'invalid_file_delivery_scope', field: `artifacts[${index}].root`,
      message: 'Remove root from file entries. Keep the answer and file paths. Only web entries require root.' };
    const missingRoot = artifacts.findIndex(item => item && typeof item === 'object' && !Array.isArray(item)
      && item.kind === 'web' && !Object.hasOwn(item, 'root'));
    if (missingRoot >= 0) return { reason: 'invalid_web_delivery_scope', field: `artifacts[${missingRoot}].root`,
      message: 'Add root to the web entry. Use the workspace-relative directory containing the page and its assets.' };
  }
  return { reason: 'final_submission_schema_invalid', message: 'Match the submit_final_output schema and use unique workspace-relative artifact paths.' };
}
export function submittedFinalText(call: ToolCall, config: RunConfiguration): string | null {
  const { finalSubmissionSchema: schema, finalSubmissionPayloadKey: key, finalOutputFormat: format } = config.contract;
  if (config.deliveryScopePolicy === RESULT_DELIVERY_POLICY) {
    if (call.name !== FINAL_SUBMISSION_TOOL || call.wireArgumentsInvalid || !compile(finalSubmissionTool(config)!.parameters)(call.arguments)) return null;
    try { if (Object.hasOwn(call.arguments, 'artifacts')) deliveryArtifacts(call.arguments.artifacts); }
    catch { return null; }
    if (!schema) return typeof call.arguments.answer === 'string' ? normalizedFinalText(call.arguments.answer, format) : null;
    const legacy = { ...config }; delete legacy.deliveryScopePolicy;
    return submittedFinalText({ ...call, arguments: call.arguments.answer as ObjectValue }, legacy);
  }
  if (!schema || call.name !== FINAL_SUBMISSION_TOOL || call.wireArgumentsInvalid || !compile(schema)(call.arguments)) return null;
  const output = key === null ? call.arguments : call.arguments[key];
  if (format === 'text') return typeof output === 'string' ? output : null;
  return output === undefined ? null : canonical(output);
}
/** Artifact selection and answer become one committed model-result transition, with no tool effect. */
export function finalDeliveryChanges(snapshot: RunSnapshot, config: RunConfiguration, call?: ToolCall): Partial<RunSnapshot> {
  if (config.deliveryScopePolicy !== RESULT_DELIVERY_POLICY) return {};
  if (call && Object.hasOwn(call.arguments, 'artifacts')) {
    const artifacts = deliveryArtifacts(call.arguments.artifacts), current = currentDeliveryManifest(snapshot);
    return current && canonical(current.artifacts) === canonical(artifacts) ? {} : deliveryManifestChanges(snapshot, artifacts);
  }
  return currentDeliveryManifest(snapshot) ? {} : deliveryManifestChanges(snapshot, []);
}
export function normalizedFinalText(text: string, format: RunConfiguration['contract']['finalOutputFormat']): string {
  if (format === 'text') return text;
  let candidate = text.trim();
  if (candidate.startsWith('```')) {
    const lines = candidate.split(/\r\n|\n|\r/);
    if (lines.length < 3 || lines.at(-1)!.trim() !== '```'
      || !['', 'json'].includes(lines[0]!.slice(3).trim().toLowerCase())) return text;
    candidate = lines.slice(1, -1).join('\n').trim();
  }
  try {
    const value = parseModelJson(candidate);
    return format === 'json_value' || value !== null && typeof value === 'object' && !Array.isArray(value) ? candidate : text;
  } catch { return text; }
}
