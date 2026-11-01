import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { verifyPackageFiles } from '../packages/agentkit-harness-node/src/package-integrity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.artifacts/packages'); mkdirSync(directory, { recursive: true });
const packages = [];
for (const name of ['agentkit-harness-core', 'agentkit-harness-node', 'agentkit-harness-ui']) {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
    { cwd: join(root, 'packages', name), encoding: 'utf8' }));
  const path = join(directory, packed.filename);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  const extracted = mkdtempSync(join(tmpdir(), 'native-release-files-'));
  let fileHashes;
  try {
    const paths = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).trim().split('\n');
    if (paths.some(value => !value.startsWith('package/') || value.split('/').includes('..'))) throw Error('Unsafe package archive path');
    execFileSync('tar', ['-xzf', path, '-C', extracted]);
    fileHashes = Object.fromEntries(packed.files.map(file => [file.path,
      createHash('sha256').update(readFileSync(join(extracted, 'package', file.path))).digest('hex')]));
    verifyPackageFiles(join(extracted, 'package'), fileHashes);
  } finally { rmSync(extracted, { recursive: true, force: true }); }
  const filename = packed.filename.replace(/\.tgz$/, `-${digest.slice(0, 16)}.tgz`);
  renameSync(path, join(directory, filename));
  packages.push({ name: packed.name, version: packed.version, filename, sha256: digest, integrity: packed.integrity, fileHashes });
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 'agentkit.native-packages/v1', sourceCommit, packages }, null, 2) + '\n');
console.log(JSON.stringify({ directory, packages }, null, 2));
