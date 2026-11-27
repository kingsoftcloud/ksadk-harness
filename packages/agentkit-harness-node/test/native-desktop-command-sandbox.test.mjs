import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DESKTOP_WORKSPACE_SHELL, shellCommandArgv } from '../src/native/command-shell.mjs';

test('macOS workspace shell confines effects from commands and subprocesses', { skip: process.platform !== 'darwin' }, t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'harness-desktop-sandbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), outside = join(root, 'outside');
  mkdirSync(workspace); mkdirSync(outside); symlinkSync(outside, join(workspace, 'linked'));
  const execute = command => {
    const [program, ...args] = shellCommandArgv(command, DESKTOP_WORKSPACE_SHELL, { workspaceRoot: workspace, cwd: workspace });
    return spawnSync(program, args, { cwd: workspace, encoding: 'utf8' });
  };
  assert.equal(execute('printf confined > local.txt').status, 0);
  assert.equal(readFileSync(join(workspace, 'local.txt'), 'utf8'), 'confined');
  assert.notEqual(execute("/bin/bash -c 'printf denied > ../outside/direct.txt'").status, 0);
  assert.notEqual(execute('printf denied > linked/symlink.txt').status, 0);
  assert.equal(existsSync(join(outside, 'direct.txt')), false);
  assert.equal(existsSync(join(outside, 'symlink.txt')), false);
  assert.throws(() => shellCommandArgv(':', DESKTOP_WORKSPACE_SHELL, { workspaceRoot: workspace, cwd: outside }));
});
