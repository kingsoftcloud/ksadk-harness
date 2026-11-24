import type { Message, ToolCall } from './contracts.mjs';

type CommandCheck = { command: string; cwd: string; exitCode: number };

// Recognize explicit check invocations. Shell pipelines and arbitrary command
// chains can hide a failing exit code, so their outer status cannot qualify.
const checkRunners = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test(?::[\w-]+)?|lint|check)(?:\s|$)/,
  /^(?:node|bun|deno)\s+(?:--test\b|(?:[\w./-]+\/)?(?:test[-\w.]*|[\w.-]+\.test)\.[cm]?[jt]s)(?:\s|$)/,
  /^(?:python3?\s+-m\s+)?pytest(?:\s|$)/,
  /^(?:npx\s+(?:--no-install\s+)?)?playwright\s+test(?:\s|$)/,
];
const explicitExit = /^([^;&|<>\r\n]+)[ \t]+>[ \t]*[\w./-]+[ \t]+2>&1[ \t]*;[ \t]*echo "EXIT=\$\?"(?:[ \t]*;[^\r\n]*)?$/;

function observedCheck(call: ToolCall, message: Message): CommandCheck | null {
  const value = call.arguments.command;
  if (typeof value !== 'string' || value.length > 4096 || call.arguments.background === true
    || message.toolOutcome && message.toolOutcome !== 'ok') return null;
  let receipt;
  try { receipt = JSON.parse(message.content); } catch { return null; }
  if (!receipt || !['sandbox/local_process', 'sandbox/e2b'].includes(receipt.backend)
    || receipt.ok !== true || receipt.evidence_incomplete !== false || receipt.command !== value
    || (receipt.status !== undefined && !['completed', 'failed'].includes(receipt.status))
    || !Number.isSafeInteger(receipt.exit_code) || receipt.exit_code < 0) return null;

  const cd = /^cd[ \t]+([-\w./]+)[ \t]*&&[ \t]*/.exec(value.trim());
  const shell = value.trim().slice(cd?.[0].length ?? 0);
  const captured = explicitExit.exec(shell);
  const command = captured ? captured[1]!.trim() : shell;
  if (/[;&|<>\r\n\x60$]/.test(command) || !checkRunners.some(pattern => pattern.test(command))) return null;
  const exitCode = captured
    ? Number(typeof receipt.stdout === 'string' ? /^EXIT=(\d+)\r?(?:\n|$)/.exec(receipt.stdout)?.[1] : undefined)
    : receipt.exit_code;
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) return null;
  const cwd = cd?.[1] ?? (typeof call.arguments.cwd === 'string' ? call.arguments.cwd : '.');
  return { command, cwd, exitCode };
}

/** These are repair signals from committed tool results. They never qualify
 * formal acceptance or infer a failed check from assistant prose. */
export function failedDeliveryCommands(messages: Message[]): CommandCheck[] {
  const pending = new Map<string, ToolCall>(), latest = new Map<string, CommandCheck>();
  for (const message of messages) {
    // A fresh turn may point at another task, even in the same workspace.
    // Durable resume of the current Run retains these original messages.
    if (message.history) continue;
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) if (call.name === 'run_command') pending.set(call.callId, call);
    } else if (message.role === 'tool' && message.name === 'run_command' && message.callId) {
      const call = pending.get(message.callId);
      if (!call) continue;
      pending.delete(message.callId);
      const check = observedCheck(call, message);
      if (check) latest.set(JSON.stringify([check.cwd, check.command]), check);
    }
  }
  return [...latest.values()].filter(check => check.exitCode !== 0).slice(-8);
}
