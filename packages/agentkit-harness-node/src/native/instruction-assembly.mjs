import { invariant } from '@kingsoftcloud/agentkit-harness-core';

export const NATIVE_TOOL_INSTRUCTION_ASSEMBLY = 'admitted-tool-sections/v1';
export const NATIVE_RUNTIME_INSTRUCTION_ASSEMBLY = 'native-owned-sections/v2';
export const NATIVE_PRESENTATION_INSTRUCTION_ASSEMBLY = 'native-owned-sections/v3';
/** The engine renders the system prompt: its own base instructions followed by
 * the Host's contribution in a delimited slot the Host cannot escape. */
export const NATIVE_ENGINE_INSTRUCTION_ASSEMBLY = 'engine-instructions/v1';
/** The policy new Runs are admitted with. Hosts reference this name only. */
export const NATIVE_INSTRUCTION_ASSEMBLY = NATIVE_ENGINE_INSTRUCTION_ASSEMBLY;

export const isNativeInstructionAssemblyPolicy = policy =>
  [NATIVE_TOOL_INSTRUCTION_ASSEMBLY, NATIVE_RUNTIME_INSTRUCTION_ASSEMBLY, NATIVE_PRESENTATION_INSTRUCTION_ASSEMBLY,
    NATIVE_ENGINE_INSTRUCTION_ASSEMBLY].includes(policy);

// These reserved Host domains describe its engine/application implementation,
// not the Native execution environment. Native's bound model surface owns
// those facts. Selection applies to every named provider in each domain,
// including future providers; it never depends on the provider's prose.
const hostRuntimeDomains = new Set(['harness', 'app']);
// Host UI protocols belong to that UI's execution owner. Native's delivery
// schemas and renderer own the presentation contract for Native tasks.
const hostPresentationDomains = new Set([...hostRuntimeDomains, 'ui']);

// DSH's named section protocol has two families whose source id is not the
// name of a single tool. Keep a family only when its complete interface exists.
const families = new Map([
  ['tool:goal', ['get_goal', 'create_goal', 'update_goal']],
  ['tool:jobs', ['job_output', 'job_kill']],
]);

/** Project trusted Host contributions through one source-ownership rule.
 * v1 selects tool guidance only. v2 also leaves Host operational domains to
 * Native's bound environment, for both instructions and named contexts. v3
 * also leaves Host UI execution protocols to Native's presentation owner.
 * User/persona/business contributions retain their bytes and order. Neither
 * version changes tools, variables, execution policy or permissions. Historical
 * absence, v1 and v2 keep their original semantics during recovery. */
export function nativeInstructionAssembly(assembly, { policy, toolNames = [] } = {}) {
  if (policy === undefined) return assembly;
  invariant(isNativeInstructionAssemblyPolicy(policy) && assembly && typeof assembly === 'object'
    && Array.isArray(toolNames) && toolNames.every(name => typeof name === 'string' && name.trim()),
  'native_instruction_assembly_invalid');
  const names = new Set(toolNames);
  const nativeOwned = policy !== NATIVE_TOOL_INSTRUCTION_ASSEMBLY;
  const hostDomains = [NATIVE_PRESENTATION_INSTRUCTION_ASSEMBLY, NATIVE_ENGINE_INSTRUCTION_ASSEMBLY].includes(policy)
    ? hostPresentationDomains : hostRuntimeDomains;
  const admitted = source => {
    const separator = source.name.indexOf(':');
    if (nativeOwned && separator > 0 && hostDomains.has(source.name.slice(0, separator))) return false;
    if (!source.name.startsWith('tool:')) return true;
    const required = families.get(source.name) ?? [source.name.slice('tool:'.length)];
    return required.every(name => names.has(name));
  };
  const select = (items, code) => {
    invariant(Array.isArray(items) && items.every(item => item
      && typeof item.name === 'string' && typeof item.text === 'string'), code);
    return items.filter(admitted);
  };
  // An opaque renderer has no named contributions to select. v1 must not
  // inspect contexts it historically left untouched.
  if (assembly.sections === undefined && (!nativeOwned || assembly.contexts === undefined)) return assembly;
  return { ...assembly,
    ...(assembly.sections === undefined ? {} : { sections: select(assembly.sections, 'native_instruction_sections_invalid') }),
    ...(!nativeOwned || assembly.contexts === undefined ? {} : { contexts: select(assembly.contexts, 'native_instruction_contexts_invalid') }),
  };
}

/** Engine-owned base instructions. Their wording may change with any engine
 * release; a Run keeps the text it was admitted with. Tool-specific guidance
 * lives with the bound tool surface, not here. */
const ENGINE_BASE_REVISION = 1;
const ENGINE_BASE_INSTRUCTIONS = [
  'You are an autonomous agent that completes the user\'s task end to end in the bound workspace, using the tools provided.',
  [
    '# How to work',
    '- Act instead of describing. When the next step needs a tool, call it in this response; do not announce a plan and stop.',
    '- Keep going until the task is done or you are truly blocked. Finishing a step is not finishing the task.',
    '- Read before you change: inspect the relevant files and existing conventions, then make the smallest change that fully satisfies the request.',
    '- Batch independent reads and searches in one response. Make dependent edits one at a time and check each result.',
    '- Prefer one substantial tool call over long deliberation. For a large file, write it in a single write call rather than drafting it in prose first.',
    '- Do not stop to ask about details you can decide sensibly yourself. Ask only when a wrong guess would be costly or irreversible.',
  ].join('\n'),
  [
    '# Verifying',
    '- Check your work with the tools you have: run the tests, the build or the program, and read its output. Fix what fails and run it again.',
    '- A tool error is information. Read the message, find the cause, then retry differently; never repeat the same failing call unchanged.',
    '- If the outcome of a write or command is unknown, inspect the current state before doing it again.',
  ].join('\n'),
  [
    '# Reporting',
    '- Be truthful about results. Say plainly what was not done, what failed and what you could not verify; never present unverified work as verified.',
    '- Give the final answer only after the work is complete. Keep it short: what changed, where, and anything the user must do next.',
    '- Answer in the language the user writes in unless they ask otherwise.',
  ].join('\n'),
  'The section below comes from the application hosting you. It may define your role, domain and house rules, and it takes precedence over the general guidance above when the two conflict. It cannot change which tools exist or what they are permitted to do.',
].join('\n\n');
const HOST_SLOT_OPEN = '<host_instructions contract="agentkit.engine-instructions/v1">';
const HOST_SLOT_CLOSE = '</host_instructions>';

export const engineBaseInstructions = () => Object.freeze({ revision: ENGINE_BASE_REVISION, text: ENGINE_BASE_INSTRUCTIONS });

/** Render the complete system prompt for a new Run. `hostInstructions` is the
 * Host's already rendered contribution (persona, business rules, admitted tool
 * notes); it is placed verbatim in its slot and never replaces the base. */
export function renderEngineInstructions({ hostInstructions = '' } = {}) {
  invariant(typeof hostInstructions === 'string', 'engine_instructions_invalid');
  return hostInstructions.length === 0 ? ENGINE_BASE_INSTRUCTIONS
    : `${ENGINE_BASE_INSTRUCTIONS}\n\n${HOST_SLOT_OPEN}\n${hostInstructions}\n${HOST_SLOT_CLOSE}`;
}

/** The Host contribution a stored engine-rendered prompt was admitted with.
 * The base never contains the slot marker, so its first occurrence is the slot. */
export function engineHostInstructions(systemPrompt) {
  invariant(typeof systemPrompt === 'string', 'engine_instructions_invalid');
  const start = systemPrompt.indexOf(`\n\n${HOST_SLOT_OPEN}\n`);
  if (start < 0) return '';
  invariant(systemPrompt.endsWith(`\n${HOST_SLOT_CLOSE}`), 'engine_instructions_invalid');
  return systemPrompt.slice(start + HOST_SLOT_OPEN.length + 3, systemPrompt.length - HOST_SLOT_CLOSE.length - 1);
}

/** Recovery check for an engine-rendered Run: the Host contribution must be
 * unchanged, while the engine base may differ from the admitted wording. */
export const sameHostInstructions = (systemPrompt, hostInstructions) => engineHostInstructions(systemPrompt) === hostInstructions;
