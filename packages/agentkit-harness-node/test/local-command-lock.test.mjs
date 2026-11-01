import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryLock, createPrivate } from '../src/native/local-command-state.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'native-lock-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return join(root, 'owner.sqlite');
}
function tombstone(path, action) {
  const original = fs.lstatSync;
  fs.lstatSync = (target, ...args) => {
    const stat = original(target, ...args);
    return target === path ? Object.defineProperty(Object.create(stat), 'nlink', { value: 0 }) : stat;
  };
  syncBuiltinESMExports();
  try { return action(); }
  finally { fs.lstatSync = original; syncBuiltinESMExports(); }
}
for (const suffix of ['-journal', '-wal', '-shm']) test(`an unlinked SQLite ${suffix} observation is contention before acquiring a lock`, t => {
  const path = fixture(t), sidecar = path + suffix;
  fs.writeFileSync(sidecar, '', { mode: 0o600 });
  assert.equal(tombstone(sidecar, () => tryLock(path)), null);
  assert.equal(fs.statSync(path).size, 0, 'a transient sidecar must not open or initialize the database');
  fs.rmSync(sidecar);
  const release = tryLock(path);
  assert.equal(typeof release, 'function');
  assert.equal(tryLock(path), null, 'another owner still cannot acquire the live transaction');
  release();
  const reacquired = tryLock(path); assert.equal(typeof reacquired, 'function'); reacquired();
});
test('main database drift and unsafe sidecars remain hard errors', t => {
  const path = fixture(t); createPrivate(path);
  assert.throws(() => tombstone(path, () => tryLock(path)), { code: 'background_state_changed' });
  const target = path + '.target', journal = path + '-journal';
  fs.writeFileSync(target, '', { mode: 0o600 }); fs.symlinkSync(target, journal);
  assert.throws(() => tryLock(path), { code: 'background_state_not_private' });
  fs.rmSync(journal); fs.linkSync(target, journal);
  assert.throws(() => tryLock(path), { code: 'background_state_not_private' });
  fs.rmSync(journal); fs.writeFileSync(journal, '', { mode: 0o644 });
  assert.throws(() => tryLock(path), { code: 'background_state_not_private' });
});
