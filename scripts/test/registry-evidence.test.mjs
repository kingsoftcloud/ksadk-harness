import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { lockedDependencyClosure, validateRegistryArchive, verifyInstalledDependencyTree, assertIntegrity } from '../native-registry-evidence.mjs';

const sri = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
test('runtime closure resolves nested versions, peers and optional absence without including dev dependencies', () => {
  const lock = { packages: {
    'packages/engine': { dependencies: { alpha: '1', beta: '1' }, peerDependencies: { peer: '*' } },
    'node_modules/alpha': { version: '1.0.0', resolved: 'alpha', integrity: 'alpha', dependencies: { shared: '1' }, devDependencies: { unrelated: '1' } },
    'node_modules/beta': { version: '1.0.0', resolved: 'beta', integrity: 'beta', dependencies: { shared: '2' } },
    'node_modules/shared': { version: '1.0.0', resolved: 'shared1', integrity: 'shared1' },
    'node_modules/beta/node_modules/shared': { version: '2.0.0', resolved: 'shared2', integrity: 'shared2' },
    'node_modules/peer': { version: '1.0.0', resolved: 'peer', integrity: 'peer', optionalDependencies: { absent: '*' } },
  } };
  const dependencies = lockedDependencyClosure(lock, ['packages/engine']);
  assert.deepEqual(dependencies.filter(item => item.name === 'shared').map(item => item.version).sort(), ['1.0.0', '2.0.0']);
  assert.equal(dependencies.length, 5);
  delete lock.packages['node_modules/shared'].integrity;
  assert.throws(() => lockedDependencyClosure(lock, ['packages/engine']), /locked registry evidence/);
});

function archive() {
  const header = Buffer.alloc(512), body = Buffer.from('{}'); header.write('package/package.json');
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(510), Buffer.alloc(1024)]));
}
test('dependency evidence binds lock, registry metadata and actual archive bytes before extraction', () => {
  const bytes = archive(), expected = { name: 'dependency', version: '1.0.0', integrity: sri(bytes), resolved: 'https://registry.npmjs.org/dependency/-/dependency-1.0.0.tgz' };
  const metadata = { name: expected.name, version: expected.version, dist: { integrity: expected.integrity, tarball: expected.resolved } };
  assert.deepEqual(validateRegistryArchive(expected, metadata, bytes), ['package.json']);
  for (const change of [{ name: 'other' }, { version: '2.0.0' }, { dist: { ...metadata.dist, integrity: sri(Buffer.from('other')) } },
    { dist: { ...metadata.dist, tarball: 'https://example.invalid/dependency.tgz' } }])
    assert.throws(() => validateRegistryArchive(expected, { ...metadata, ...change }, bytes));
  assert.throws(() => validateRegistryArchive(expected, metadata, Buffer.from('tampered')));
  assert.throws(() => assertIntegrity(bytes, undefined));
});
test('installed original archives require independent evidence for each hoisted and nested version', t => {
  const root = mkdtempSync(join(tmpdir(), 'installed-registry-evidence-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  function create(path, metadata, content) {
    mkdirSync(path, { recursive: true }); const files = { 'package.json': JSON.stringify(metadata), 'index.mjs': content };
    for (const [name, body] of Object.entries(files)) writeFileSync(join(path, name), body);
    return Object.fromEntries(Object.entries(files).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')]));
  }
  const engine = join(root, 'node_modules/engine'), dependency = join(engine, 'node_modules/dependency');
  const own = create(engine, { name: 'engine', version: '1.0.0', dependencies: { dependency: '2.0.0' } }, 'engine');
  const files1 = create(join(root, 'node_modules/dependency'), { name: 'dependency', version: '1.0.0' }, 'one');
  const files2 = create(dependency, { name: 'dependency', version: '2.0.0' }, 'two');
  const manifest = { packages: [{ name: 'engine', version: '1.0.0', fileHashes: own }], dependencyPackages: {
    'dependency@1.0.0': { files: files1 }, 'dependency@2.0.0': { files: files2 } } };
  assert.equal(verifyInstalledDependencyTree(root, manifest).length, 3);
  const withoutNested = structuredClone(manifest); delete withoutNested.dependencyPackages['dependency@2.0.0'];
  assert.throws(() => verifyInstalledDependencyTree(root, withoutNested), /registry evidence/);
  writeFileSync(join(dependency, 'extra'), 'injected');
  assert.throws(() => verifyInstalledDependencyTree(root, manifest), /Unexpected package file/); rmSync(join(dependency, 'extra'));
  writeFileSync(join(dependency, 'index.mjs'), 'mutated');
  assert.throws(() => verifyInstalledDependencyTree(root, manifest), /stale or modified/); writeFileSync(join(dependency, 'index.mjs'), 'two');
  rmSync(join(dependency, 'index.mjs')); assert.throws(() => verifyInstalledDependencyTree(root, manifest), /missing/);
  symlinkSync(join(root, 'node_modules/dependency/index.mjs'), join(dependency, 'index.mjs'));
  assert.throws(() => verifyInstalledDependencyTree(root, manifest), /link is not allowed/);
});
