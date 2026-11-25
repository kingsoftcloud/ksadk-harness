import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBoundedProcess, buildScriptEnvironment } from '../src/native/local-process.mjs';
import { localResourceSettings, validLocalResourceProfile } from '../src/native/local-resource-profile.mjs';
import { nativeContextDefaults, bindNativeContext } from '../src/native/context-profile.mjs';

const GIB = 1024 ** 3;

test('local-development/v3 requests no per-command rlimits; earlier profiles and Host overrides keep their values', () => {
  assert.equal(validLocalResourceProfile('local-development/v3'), true);
  const v3 = localResourceSettings({ profile: 'local-development/v3' });
  for (const key of ['cpuSeconds', 'addressSpaceBytes', 'maxProcesses', 'maxOpenFiles', 'maxFileBytes'])
    assert.equal(v3[key], Number.MAX_SAFE_INTEGER, key);
  assert.equal(v3.wallSeconds, 900);
  assert.equal(v3.maxOutputBytes, 1024 ** 2);
  for (const profile of ['bounded/v1', 'local-development/v1', 'local-development/v2'])
    assert.equal(localResourceSettings({ profile }).addressSpaceBytes, GIB, profile);
  assert.equal(localResourceSettings({ profile: 'local-development/v3', settings: { addressSpaceBytes: 2 * GIB } }).addressSpaceBytes, 2 * GIB);
});

test('local-development/v3 commands are not capped at 1 GiB of virtual address space', { skip: process.platform === 'darwin' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-local-v3-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const probe = profile => runBoundedProcess({ cwd: directory, argv: ['/bin/sh', '-c', 'ulimit -v'], env: buildScriptEnvironment(process.env),
    settings: localResourceSettings({ profile }) });
  const bounded = await probe('local-development/v2');
  assert.equal(bounded.stdout.trim(), String(GIB / 1024));
  const unbounded = await probe('local-development/v3');
  assert.equal(unbounded.exitCode, 0);
  assert.notEqual(unbounded.stdout.trim(), String(GIB / 1024));
  assert.ok(unbounded.stdout.trim() === 'unlimited' || Number(unbounded.stdout.trim()) > GIB / 1024, unbounded.stdout);
  assert.equal(unbounded.controls.status, 'applied');
});

test('new openai-chat Runs split continuity; admitted Runs keep their placement', () => {
  const description = { protocol: 'openai-chat', modelName: 'fixture', parameters: {}, contextWindow: 1048576, maxOutputTokens: 134144, requestOutputTokens: 8192 };
  const fresh = bindNativeContext({ description, ...nativeContextDefaults(undefined) });
  assert.equal(fresh.policy.continuityPlacement, 'split-after-history/v1');
  const admitted = placement => ({ contextPolicy: { continuityPlacement: placement } });
  const legacy = nativeContextDefaults(admitted('after-history/v1'));
  assert.equal(legacy.orderedContextDefaults, true);
  assert.equal(legacy.splitContinuityDefaults, false);
  assert.equal(bindNativeContext({ description, ...legacy }).policy.continuityPlacement, 'after-history/v1');
  const split = nativeContextDefaults(admitted('split-after-history/v1'));
  assert.equal(bindNativeContext({ description, ...split }).policy.continuityPlacement, 'split-after-history/v1');
});
