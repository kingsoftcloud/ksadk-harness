import { invariant } from '@kingsoftcloud/agentkit-harness-core';

export const ENGINE_TOOL_POLICY = 'agentkit.native-agent-policy/v1';

export function admitEngineToolPolicy(value, durableApprovals) {
  if (value === undefined) return null;
  invariant(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['contract', 'mode', 'rules'].includes(key))
    && value.contract === ENGINE_TOOL_POLICY && ['strict', 'custom'].includes(value.mode)
    && value.rules && typeof value.rules === 'object' && !Array.isArray(value.rules),
  'engine_tool_policy_invalid');
  const rules = Object.entries(value.rules);
  invariant(rules.length <= 512 && (value.mode === 'custom' || rules.length === 0)
    && rules.every(([name, action]) => /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(name)
      && ['inherit', 'ask', 'deny'].includes(action)), 'engine_tool_policy_invalid');
  invariant(durableApprovals || value.mode === 'custom' && rules.every(([, action]) => action !== 'ask'),
    'engine_tool_policy_requires_durable_approvals');
  return { mode: value.mode, rules: new Map(rules) };
}

export function restrictEngineTools(definitions, policy, approvalPolicy) {
  if (!policy) return definitions;
  return definitions.flatMap(tool => {
    const action = policy.rules.get(tool.name)
      ?? (tool.readOnly ? 'inherit' : policy.mode === 'strict' ? 'ask' : 'deny');
    if (action === 'deny') return [];
    return [action === 'ask' ? { ...tool, approvalPolicy, hostApprovalRequired: true } : tool];
  });
}
