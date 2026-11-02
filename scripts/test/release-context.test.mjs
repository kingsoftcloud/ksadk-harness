import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyReleaseContext } from '../verify-release-context.mjs';
const sha = 'a'.repeat(40);
const valid = () => ({ repository: 'kingsoftcloud/ksadk-harness', eventName: 'release', ref: 'refs/tags/v0.0.7',
  sha, tagCommit: sha, versions: ['0.0.7', '0.0.7', '0.0.7'],
  release: { tag_name: 'v0.0.7', target_commitish: sha, draft: false, prerelease: false, published_at: '2026-11-02T00:00:00Z' } });
test('both automatic release and manual retries require the same immutable published release', () => {
  for (const eventName of ['release', 'workflow_dispatch']) assert.equal(verifyReleaseContext({ ...valid(), eventName }).version, '0.0.7');
});
for (const [name, change] of Object.entries({ branch: { ref: 'refs/heads/main' }, event: { eventName: 'push' },
  foreignRepository: { repository: 'other/harness' }, movedTag: { tagCommit: 'b'.repeat(40) },
  packageMismatch: { versions: ['0.0.6', '0.0.7', '0.0.7'] }, missingRelease: { release: null } }))
  test(`publishing rejects ${name}`, () => assert.throws(() => verifyReleaseContext({ ...valid(), ...change })));
for (const [key, value] of Object.entries({ draft: true, prerelease: true, published_at: null, target_commitish: 'main', tag_name: 'v0.0.6' }))
  test(`publishing rejects invalid release ${key}`, () => {
    const context = valid(); context.release[key] = value; assert.throws(() => verifyReleaseContext(context));
  });
