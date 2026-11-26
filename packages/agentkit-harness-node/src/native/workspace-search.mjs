import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./workspace-search-worker.mjs', import.meta.url));
const failed = (code, message) => ({ ok: false, error_code: code, error_message: message });

export function runWorkspaceSearch(input, signal) {
  const canceled = () => failed('canceled', 'workspace search canceled');
  if (signal?.aborted) return Promise.resolve(canceled());
  // Keep filesystem stalls and expensive regex evaluation off the Harness
  // event loop. A stuck filesystem read can outlive termination of a worker
  // thread, so this process has its own I/O pool and can be detached on timeout.
  const child = fork(worker, { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { SystemRoot: process.env.SystemRoot }, windowsHide: true });
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill('SIGKILL');
      child.channel?.unref();
      child.unref();
      resolve(value);
    };
    const abort = () => finish(canceled());
    const unavailable = () => finish(failed('workspace_search_failed', 'workspace search worker stopped; retry with a narrower path'));
    const timer = setTimeout(() => finish(failed('workspace_search_timeout', 'workspace search timed out; retry with a narrower path')), 30_000);
    child.once('message', finish);
    child.once('error', unavailable);
    child.once('exit', unavailable);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else child.send(input, error => { if (error) unavailable(); });
  });
}
