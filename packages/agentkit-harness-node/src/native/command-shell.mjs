import { isAbsolute, relative, resolve, sep } from 'node:path';

export const LOCAL_COMMAND_SHELL = 'bash-execution/v1';
export const ISOLATED_COMMAND_SHELL = 'bubblewrap-workspace/v1';

/** A missing policy belongs to a persisted legacy request. Never reinterpret
 * it under a new shell during supervision/recovery. No PATH-based fallback.
 */
export function shellCommandArgv(command, policy = null, { workspaceRoot, cwd } = {}) {
  if (policy === null) return ['/bin/sh', '-c', command];
  if (policy === LOCAL_COMMAND_SHELL) return ['/bin/bash', '-c', command];
  if (policy !== ISOLATED_COMMAND_SHELL) throw Error('unsupported_command_shell');
  if (process.platform !== 'linux' || typeof workspaceRoot !== 'string' || typeof cwd !== 'string'
    || !isAbsolute(workspaceRoot) || !isAbsolute(cwd) || resolve(workspaceRoot) !== workspaceRoot
    || resolve(cwd) !== cwd
    || (workspaceRoot !== '/data/workspace' && !workspaceRoot.startsWith('/data/workspace/')))
    throw Error('isolated_command_workspace_invalid');
  const within = relative(workspaceRoot, cwd);
  if (within === '..' || within.startsWith('..' + sep) || isAbsolute(within))
    throw Error('isolated_command_cwd_outside_workspace');

  // The managed image supplies Debian's usr-merged filesystem. Only the
  // workspace and disposable tmpfs are writable. Neither the state volume nor
  // the engine's PID namespace or deployment credential mounts are visible.
  return ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--unshare-net', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--dir', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', '/etc/passwd', '/etc/passwd', '--ro-bind', '/etc/group', '/etc/group',
    '--bind', workspaceRoot, workspaceRoot, '--chdir', cwd,
    '--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'CI', '1', '--', '/bin/bash', '-c', command];
}
