import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertIntegrity, readRegistryPackage } from './native-registry-evidence.mjs';

export function verifyPublishedPackage(expected, metadata, sourceCommit) {
  assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/, 'Immutable release source is required');
  assert.ok(metadata, 'Published package is absent');
  assert.equal(metadata.name, expected.name, 'Published package name mismatch');
  assert.equal(metadata.version, expected.version, 'Published package version mismatch');
  assert.equal(metadata.gitHead, sourceCommit, 'Published package source commit is missing or different');
  assert.ok(expected.integrity, 'Tested archive integrity is required');
  assert.equal(metadata.dist?.integrity, expected.integrity, 'Published archive differs from the tested archive');
  return { name: expected.name, version: expected.version, sourceCommit, integrity: expected.integrity };
}

export async function publishRelease({ manifest, sourceCommit, readRegistry, publish, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), record = () => {} }) {
  assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/, 'Immutable release source is required');
  assert.equal(manifest.sourceCommit, sourceCommit, 'Tested packages do not match the release source');
  assert.equal(manifest.packages.length, 3, 'A release requires all three packages');
  assert.equal(new Set(manifest.packages.map(item => item.name)).size, 3, 'Duplicate release package');
  const names = ['core', 'node', 'ui'].map(part => '@kingsoftcloud/agentkit-harness-' + part);
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.sort(), 'Unexpected release package');
  // Preflight every existing version before publishing any package. Only an
  // explicit 404 is absence; network/auth/server failures never mean "new".
  const existing = await Promise.all(manifest.packages.map(item => readRegistry(item.name, item.version)));
  existing.forEach((metadata, i) => { if (metadata !== null) verifyPublishedPackage(manifest.packages[i], metadata, sourceCommit); });
  const receipts = [];
  for (let i = 0; i < manifest.packages.length; i++) {
    const expected = manifest.packages[i];
    if (existing[i] === null) await publish(expected);
    let metadata = existing[i];
    for (let attempt = 0; metadata === null && attempt < 12; attempt++) {
      metadata = await readRegistry(expected.name, expected.version);
      if (metadata === null && attempt < 11) await wait(5000);
    }
    const receipt = { ...verifyPublishedPackage(expected, metadata, sourceCommit), action: existing[i] === null ? 'published' : 'reused' };
    receipts.push(receipt); record(receipts);
  }
  return receipts;
}

async function main() {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(sourceCommit, process.env.GITHUB_SHA, 'Publishing checkout must match GITHUB_SHA');
  const manifestPath = resolve('.artifacts/packages/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  for (const item of manifest.packages) {
    assert.ok(item.filename && !item.filename.includes('/') && !item.filename.includes('\\'), 'Invalid release archive path');
    assertIntegrity(readFileSync(resolve('.artifacts/packages', item.filename)), item.integrity);
  }
  const path = resolve('.artifacts/npm-release-receipt.json');
  const record = packages => writeFileSync(path, JSON.stringify({ sourceCommit, packages }, null, 2) + '\n');
  record([]);
  const receipts = await publishRelease({ manifest, sourceCommit, readRegistry: readRegistryPackage, record,
    publish: item => execFileSync('npm', ['publish', '--workspace', `packages/${item.name.split('/')[1]}`, '--ignore-scripts', '--access', 'public', '--provenance'], { stdio: 'inherit' }) });
  console.log(JSON.stringify({ verified: true, sourceCommit, packages: receipts }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
