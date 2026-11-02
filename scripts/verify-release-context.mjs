import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function verifyReleaseContext({ repository, eventName, ref, sha, tagCommit, versions, release }) {
  assert.equal(repository, 'kingsoftcloud/ksadk-harness', 'Unexpected publishing repository');
  assert.ok(['release', 'workflow_dispatch'].includes(eventName), 'Unexpected publishing event');
  assert.match(ref ?? '', /^refs\/tags\/v\d+\.\d+\.\d+$/, 'Publishing requires a version tag, never a branch');
  assert.match(sha ?? '', /^[a-f0-9]{40}$/, 'Missing immutable source commit');
  assert.equal(tagCommit, sha, 'Release tag must resolve to the checked-out commit');
  const tag = ref.slice('refs/tags/'.length), version = tag.slice(1);
  assert.equal(versions.length, 3);
  for (const value of versions) assert.equal(value, version, 'Every package must match the release tag');
  assert.equal(release?.tag_name, tag, 'Published release does not match the tag');
  assert.equal(release?.draft, false, 'Draft releases cannot publish');
  assert.equal(release?.prerelease, false, 'Stable packages require a stable release');
  assert.ok(release?.published_at, 'A published GitHub Release is required');
  assert.equal(release?.target_commitish, sha, 'Release must explicitly identify the immutable source commit');
  return { tag, version, sourceCommit: sha };
}

async function main() {
  const env = process.env;
  const ref = env.GITHUB_REF;
  assert.match(ref ?? '', /^refs\/tags\/v\d+\.\d+\.\d+$/, 'Publishing requires a version tag');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tagCommit = execFileSync('git', ['rev-parse', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  assert.equal(sha, env.GITHUB_SHA, 'Checkout must match the triggering commit');
  const response = await fetch(`https://api.github.com/repos/kingsoftcloud/ksadk-harness/releases/tags/${encodeURIComponent(ref.slice(10))}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, 'Cannot verify published GitHub Release');
  const versions = ['core', 'node', 'ui'].map(part => JSON.parse(readFileSync(`packages/agentkit-harness-${part}/package.json`)).version);
  console.log(JSON.stringify(verifyReleaseContext({ repository: env.GITHUB_REPOSITORY, eventName: env.GITHUB_EVENT_NAME,
    ref, sha, tagCommit, versions, release: await response.json() })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
