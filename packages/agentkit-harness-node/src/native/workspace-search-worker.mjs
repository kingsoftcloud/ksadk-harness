import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicErrorMessage } from '@kingsoftcloud/agentkit-harness-core/error-presentation';
import { splitlines } from './workspace-editing.mjs';
import { escapeRegex, fnmatch, isInside, workspaceRelative } from './workspace-paths.mjs';

const skippedDirectories = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);
const maxFileBytes = 1024 * 1024;
const timedOut = Symbol('timed out');

async function readText(file, root, signal) {
  if (!isInside(await realpath(file), root) || signal.aborted) return;
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (signal.aborted) return;
    const info = await fd.stat();
    if (!info.isFile() || info.size > maxFileBytes || signal.aborted) return;
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let offset = 0;
    while (offset < buffer.length && !signal.aborted) {
      const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
      offset += bytesRead;
    }
  } finally {
    await fd.close();
  }
}

export async function searchWorkspace({ args, root, base }, { read = readText, fileTimeoutMs = 1000 } = {}) {
  const { query, path, glob } = args;
  let pattern;
  try {
    pattern = new RegExp(args.is_regex ? query.trim() : escapeRegex(query.trim()), args.case_sensitive ? '' : 'i');
  } catch (error) {
    return { ok: false, error_code: 'invalid_search_pattern', error_message: publicErrorMessage(error) };
  }
  const limit = Math.max(1, Math.min(Number(args.max_results) || 100, 5000));
  const context = Math.max(0, Math.min(Number(args.context_lines) || 0, 20));
  const results = [];
  const deadline = performance.now() + 27_000;
  let skippedSlow = 0;
  let stalledIo = 0;
  let truncated = false;

  async function bounded(action) {
    const controller = new AbortController();
    let timer;
    const result = action(controller.signal).catch(() => undefined).finally(() => {
      if (controller.signal.aborted) stalledIo--;
    });
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        skippedSlow++;
        stalledIo++;
        controller.abort();
        resolve(timedOut);
      }, fileTimeoutMs);
    });
    try {
      return await Promise.race([result, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function inspect(file) {
    const path = workspaceRelative(root, file);
    if (glob && !fnmatch(path, glob) && !fnmatch(basename(file), glob)) return false;
    const text = await bounded(signal => read(file, root, signal));
    if (typeof text !== 'string') return false;
    const lines = splitlines(text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!pattern.test(line)) continue;
      if (results.length >= limit) return true;
      results.push({ path, line: i + 1, text: line, snippet: line,
        context_before: lines.slice(Math.max(0, i - context), i),
        context_after: lines.slice(i + 1, i + 1 + context) });
    }
    return false;
  }

  const info = await bounded(() => lstat(base));
  if (!info) return { ok: false, error_code: 'workspace_path_not_found', error_message: `workspace path not found: ${path}` };
  if (info === timedOut) return { ok: false, error_code: 'workspace_search_timeout', error_message: 'workspace search path did not respond' };
  // Stop before slow operations can fill the separate process's default
  // four-thread I/O pool. The parent reaps outstanding reads when we return.
  const budgetUsed = () => stalledIo >= 3 || performance.now() >= deadline;
  if (info.isFile()) truncated = await inspect(base);
  else if (info.isDirectory()) {
    const dirs = [base];
    search: while (dirs.length) {
      if (budgetUsed()) { truncated = true; break; }
      const dir = dirs.pop();
      const entries = await bounded(async signal => {
        if (await realpath(dir) !== dir || signal.aborted) return;
        return readdir(dir, { withFileTypes: true });
      });
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (budgetUsed()) { truncated = true; break search; }
        const name = entry.name;
        const child = join(dir, name);
        if (entry.isDirectory() && !skippedDirectories.has(name.toLowerCase())) dirs.push(child);
        else if (entry.isFile() && await inspect(child)) { truncated = true; break search; }
      }
    }
  }
  return { ok: true, query, searched_path: path, results, match_count: results.length,
    truncated: truncated || skippedSlow > 0, context_lines: context, search_backend: 'node',
    ...(skippedSlow > 0 ? { skipped_slow_paths: skippedSlow } : {}) };
}

if (process.send && process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.once('message', input => {
    void searchWorkspace(input).then(result => process.send(result), () => process.exit(1));
  });
}
