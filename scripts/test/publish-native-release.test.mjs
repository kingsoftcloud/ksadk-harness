import test from 'node:test';
import assert from 'node:assert/strict';
import { publishRelease, verifyPublishedPackage } from '../publish-native-release.mjs';
import { readRegistryPackage } from '../native-registry-evidence.mjs';
const sha = 'a'.repeat(40), integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
const packages = ['core', 'node', 'ui'].map(part => ({ name: '@kingsoftcloud/agentkit-harness-' + part, version: '0.0.9', integrity }));
const manifest = () => ({ sourceCommit: sha, packages: structuredClone(packages) });
const metadata = item => ({ name: item.name, version: item.version, gitHead: sha, dist: { integrity } });

for (const field of ['gitHead', 'integrity', 'name', 'version']) for (const missing of [false, true])
  test(`an existing registry version with ${missing ? 'missing' : 'different'} ${field} fails before any publication`, async () => {
    let published = 0;
    await assert.rejects(publishRelease({ manifest: manifest(), sourceCommit: sha,
      readRegistry: async name => {
        const item = packages.find(item => item.name === name), value = metadata(item);
        if (name === packages[2].name) {
          const object = field === 'integrity' ? value.dist : value;
          if (missing) delete object[field]; else object[field] = 'mismatch';
        }
        return value;
      }, publish: async () => { published++; } }));
    assert.equal(published, 0);
  });

test('a verified retry reuses all three packages and records their source and archive identity', async () => {
  let publications = 0; const recorded = [];
  const receipts = await publishRelease({ manifest: manifest(), sourceCommit: sha,
    readRegistry: async name => metadata(packages.find(item => item.name === name)),
    publish: async () => { publications++; }, record: values => recorded.push(structuredClone(values)) });
  assert.equal(publications, 0); assert.equal(recorded.length, 3);
  assert.ok(receipts.every(item => item.action === 'reused' && item.sourceCommit === sha && item.integrity === integrity));
});
test('partial publication retries verify existing packages, publish only missing ones and verify after publishing', async () => {
  const published = new Set([packages[0].name]); let checks = 0;
  const receipts = await publishRelease({ manifest: manifest(), sourceCommit: sha,
    readRegistry: async name => { checks++; return published.has(name) ? metadata(packages.find(item => item.name === name)) : null; },
    publish: async item => published.add(item.name) });
  assert.equal(checks, 5); assert.deepEqual(receipts.map(item => item.action), ['reused', 'published', 'published']);
});
test('post-publish source mismatch and missing eventual evidence never report success', async () => {
  let attempts = 0;
  await assert.rejects(publishRelease({ manifest: manifest(), sourceCommit: sha,
    readRegistry: async name => ++attempts <= 3 ? null : { ...metadata(packages.find(item => item.name === name)), gitHead: 'b'.repeat(40) },
    publish: async () => {}, wait: async () => {} }), /source commit/);
  await assert.rejects(publishRelease({ manifest: manifest(), sourceCommit: sha, readRegistry: async () => null,
    publish: async () => {}, wait: async () => {} }), /absent/);
});
test('normal registry propagation beyond one minute can settle without publishing twice', async () => {
  const calls = new Map(), published = new Set(); let waits = 0;
  const receipts = await publishRelease({ manifest: manifest(), sourceCommit: sha,
    readRegistry: async name => {
      const count = (calls.get(name) ?? 0) + 1; calls.set(name, count);
      return published.has(name) && count > 20 ? metadata(packages.find(item => item.name === name)) : null;
    }, publish: async item => { assert.equal(published.has(item.name), false); published.add(item.name); },
    wait: async () => { waits++; } });
  assert.equal(published.size, 3); assert.equal(receipts.length, 3); assert.ok(waits > 12);
});
test('registry/network errors never become an absent version', async () => {
  for (const status of [401, 403, 429, 500, 503])
    await assert.rejects(readRegistryPackage(packages[0].name, '0.0.9', async () => new Response('{}', { status })));
  await assert.rejects(readRegistryPackage(packages[0].name, '0.0.9', async () => { throw Error('network unavailable'); }));
  for (const body of ['null', '[]', '{invalid-json'])
    await assert.rejects(readRegistryPackage(packages[0].name, '0.0.9', async () => new Response(body, { status: 200 })));
  assert.equal(await readRegistryPackage(packages[0].name, '0.0.9', async () => new Response('{}', { status: 404 })), null);
});
test('unmatched candidate source, incomplete package set and absent tested integrity fail closed', async () => {
  for (const change of [{ sourceCommit: 'b'.repeat(40) }, { packages: packages.slice(1) }, { packages: [packages[0], packages[0], packages[2]] }])
    await assert.rejects(publishRelease({ manifest: { ...manifest(), ...change }, sourceCommit: sha,
      readRegistry: async () => { throw Error('must not read registry'); }, publish: async () => { throw Error('must not publish'); } }));
  assert.throws(() => verifyPublishedPackage({ ...packages[0], integrity: undefined }, metadata(packages[0]), sha));
});
