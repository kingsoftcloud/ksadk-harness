import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyPackageFiles } from '../src/package-integrity.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'package-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'package'); mkdirSync(join(directory, 'lib'), { recursive: true });
  const files = { 'index.mjs': 'export const value = 1;\n', 'lib/data.txt': 'release data' };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, name), bytes);
  const pins = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
  assert.equal(verifyPackageFiles(directory, pins), 2);
  return { root, directory, pins };
}

test('exact release files reject additions, missing files and modified bytes', t => {
  const { directory, pins } = fixture(t);
  writeFileSync(join(directory, 'extra.mjs'), 'extra');
  assert.throws(() => verifyPackageFiles(directory, pins), /Unexpected package file/);
  rmSync(join(directory, 'extra.mjs'));
  writeFileSync(join(directory, 'index.mjs'), 'tampered');
  assert.throws(() => verifyPackageFiles(directory, pins), /stale or modified/);
  rmSync(join(directory, 'index.mjs'));
  assert.throws(() => verifyPackageFiles(directory, pins), /missing/);
});

test('unregistered links and registered files through a linked parent are rejected', t => {
  const { root, directory, pins } = fixture(t);
  const outside = join(root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'data.txt'), readFileSync(join(directory, 'lib/data.txt')));
  symlinkSync(join(outside, 'data.txt'), join(directory, 'extra-link'));
  assert.throws(() => verifyPackageFiles(directory, pins), /link is not allowed/);
  rmSync(join(directory, 'extra-link'));
  rmSync(join(directory, 'lib'), { recursive: true }); symlinkSync(outside, join(directory, 'lib'), 'dir');
  assert.throws(() => verifyPackageFiles(directory, pins), /link is not allowed/);
});

test('manifest paths cannot authorize files outside the package', t => {
  const { directory, pins } = fixture(t);
  for (const path of ['../outside', '/absolute', 'lib/../index.mjs', 'lib\\data.txt'])
    assert.throws(() => verifyPackageFiles(directory, { ...pins, [path]: 'a'.repeat(64) }), /Invalid package file pin/);
});

test('installed dependencies need their own exact registry file evidence; a dependency directory is never a blanket exclusion', t => {
  const { directory, pins } = fixture(t);
  const writePin = (root, name, text, files) => {
    writeFileSync(join(root, name), text); files[name] = createHash('sha256').update(text).digest('hex');
  };
  writePin(directory, 'package.json', JSON.stringify({ dependencies: { dependency: '1.0.0' } }), pins);
  const dependency = join(directory, 'node_modules/dependency'); mkdirSync(dependency, { recursive: true });
  const files = {};
  writePin(dependency, 'package.json', JSON.stringify({ name: 'dependency', version: '1.0.0' }), files);
  writePin(dependency, 'index.mjs', 'export const value = 1;', files);
  assert.throws(() => verifyPackageFiles(directory, pins), /Unexpected package directory/);
  const options = { dependencyPackages: { 'dependency@1.0.0': { files } } };
  assert.equal(verifyPackageFiles(directory, pins, options), 3);
  writeFileSync(join(dependency, 'extra.mjs'), 'unregistered');
  assert.throws(() => verifyPackageFiles(directory, pins, options), /Unexpected package file/);
  rmSync(join(dependency, 'extra.mjs'));
  writeFileSync(join(dependency, 'index.mjs'), 'tampered');
  assert.throws(() => verifyPackageFiles(directory, pins, options), /stale or modified/);
});
