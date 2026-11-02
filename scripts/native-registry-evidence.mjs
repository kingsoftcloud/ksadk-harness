import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { validatePackageArchive } from './native-package-archive.mjs';
import { verifyPackageFiles } from '../packages/agentkit-harness-node/src/package-integrity.mjs';

export function registryURL(name, version) {
  assert.match(name, /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i, 'Invalid registry package name');
  assert.match(version, /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i, 'Invalid registry version');
  return `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
}

export async function readRegistryPackage(name, version, fetchImpl = fetch) {
  const response = await fetchImpl(registryURL(name, version), { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return null;
  assert.equal(response.status, 200, `Cannot verify registry metadata for ${name}@${version}`);
  const metadata = await response.json();
  assert.ok(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'Malformed registry metadata');
  return metadata;
}

export function assertIntegrity(bytes, integrity) {
  assert.match(integrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/, 'Missing or unsupported archive integrity');
  assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), integrity, 'Registry archive integrity mismatch');
}

/** Resolve the runtime/optional/peer closure with Node's ancestor lookup,
 * preserving different nested versions rather than keying only by name.
 */
export function lockedDependencyClosure(lock, roots) {
  const entries = lock.packages, pending = [...roots], seen = new Set(), result = [];
  function resolve(from, name) {
    let cursor = from;
    while (true) {
      if (posix.basename(cursor) !== 'node_modules') {
        const path = posix.join(cursor, 'node_modules', name);
        if (entries[path]) return path;
      }
      if (!cursor || cursor === '.') break;
      cursor = posix.dirname(cursor);
      if (cursor === '.') cursor = '';
    }
    return null;
  }
  while (pending.length) {
    const location = pending.shift();
    if (seen.has(location)) continue;
    seen.add(location);
    const entry = entries[location]; assert.ok(entry, 'Dependency is absent from lock: ' + location);
    if (entry.link) { pending.push(entry.resolved); continue; }
    if (!roots.includes(location)) {
      const name = location.slice(location.lastIndexOf('node_modules/') + 13);
      assert.ok(entry.resolved && entry.integrity, 'Dependency has no locked registry evidence: ' + name);
      result.push({ name, location, ...entry });
    }
    const optional = { ...entry.optionalDependencies, ...Object.fromEntries(Object.entries(entry.peerDependenciesMeta ?? {}).filter(([, value]) => value.optional)) };
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies })) {
      const dependency = resolve(location, name);
      if (!dependency && Object.hasOwn(optional, name)) continue;
      assert.ok(dependency, 'Dependency cannot be resolved from lock: ' + name);
      pending.push(dependency);
    }
  }
  return result;
}

export function validateRegistryArchive(expected, metadata, bytes) {
  assert.ok(metadata, 'Registry version is missing');
  assert.equal(metadata.name, expected.name, 'Registry package name mismatch');
  assert.equal(metadata.version, expected.version, 'Registry package version mismatch');
  assert.equal(metadata.dist?.integrity, expected.integrity, 'Registry integrity differs from locked archive');
  const url = new URL(metadata.dist.tarball);
  assert.ok(url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && !url.username && !url.password && !url.search && !url.hash,
    'Registry archive must use the public npm endpoint');
  if (expected.resolved) assert.equal(url.href, expected.resolved, 'Registry archive differs from lock');
  assertIntegrity(bytes, expected.integrity);
  return validatePackageArchive(bytes);
}

export async function collectDependencyEvidence({ root, packages, directory, fetchImpl = fetch }) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
  const closure = lockedDependencyClosure(lock, packages.map(name => `packages/${name}`));
  const dependencyPackages = {};
  mkdirSync(directory, { recursive: true });
  for (const expected of closure) {
    const key = `${expected.name}@${expected.version}`;
    if (dependencyPackages[key]) continue;
    const metadata = await readRegistryPackage(expected.name, expected.version, fetchImpl);
    assert.ok(metadata, 'Locked dependency is missing from registry: ' + key);
    assert.equal(metadata.dist?.integrity, expected.integrity, 'Registry dependency differs from lock: ' + key);
    const url = new URL(metadata.dist.tarball);
    assert.ok(url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && !url.username && !url.password && !url.search && !url.hash,
      'Dependency archive must use the public npm endpoint');
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200, 'Cannot download locked dependency: ' + key);
    const bytes = Buffer.from(await response.arrayBuffer());
    const names = validateRegistryArchive(expected, metadata, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const filename = `dependency-${digest}.tgz`; writeFileSync(join(directory, filename), bytes);
    const extracted = mkdtempSync(join(tmpdir(), 'native-dependency-evidence-'));
    try {
      execFileSync('tar', ['-xzf', join(directory, filename), '-C', extracted]);
      const packageRoot = join(extracted, 'package');
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json')));
      assert.equal(manifest.name, expected.name, 'Archive package name differs from registry');
      assert.equal(manifest.version, expected.version, 'Archive version differs from registry');
      const files = Object.fromEntries(names.map(name => [name, createHash('sha256').update(readFileSync(join(packageRoot, name))).digest('hex')]));
      verifyPackageFiles(packageRoot, files);
      dependencyPackages[key] = { name: expected.name, version: expected.version, integrity: expected.integrity,
        tarball: url.href, sha256: digest, filename, files };
    } finally { rmSync(extracted, { recursive: true, force: true }); }
  }
  return { dependencyPackages, dependencyLocations: Object.fromEntries(closure.map(item => [item.location, `${item.name}@${item.version}`])) };
}

/** Verify every installed package, including hoisted and nested copies, against
 * independent registry archives. npm's root shims/lock are installer metadata.
 */
export function verifyInstalledDependencyTree(directory, manifest) {
  const pins = { ...manifest.dependencyPackages, ...Object.fromEntries(manifest.packages.map(item =>
    [`${item.name}@${item.version}`, { name: item.name, version: item.version, files: item.fileHashes }])) };
  const verified = [];
  function visitModules(path) {
    for (const entry of readdirSync(path)) {
      if (entry === '.bin' || entry === '.package-lock.json') continue;
      const target = join(path, entry), stat = lstatSync(target);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Installed dependency is not a regular directory');
      const names = entry.startsWith('@') ? readdirSync(target).map(name => `${entry}/${name}`) : [entry];
      for (const name of names) {
        const folder = join(path, name), info = lstatSync(folder);
        assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Installed dependency is a link');
        const metadata = JSON.parse(readFileSync(join(folder, 'package.json'))), key = `${name}@${metadata.version}`;
        const pin = pins[key];
        assert.ok(pin?.files && metadata.name === name, 'Installed dependency has no registry/archive evidence: ' + key);
        verifyPackageFiles(folder, pin.files, { dependencyPackages: pins });
        verified.push({ name, version: metadata.version, directory: folder });
        if (readdirSync(folder).includes('node_modules')) visitModules(join(folder, 'node_modules'));
      }
    }
  }
  visitModules(join(directory, 'node_modules'));
  return verified;
}
