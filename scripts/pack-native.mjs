import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { verifyPackageFiles } from '../packages/agentkit-harness-node/src/package-integrity.mjs';
import { validatePackageArchive } from './native-package-archive.mjs';
import { collectDependencyEvidence } from './native-registry-evidence.mjs';

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
    validatePackageArchive(readFileSync(path), packed.files.map(file => file.path));
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
const dependencies = await collectDependencyEvidence({ root, packages: packages.map(item => item.name.split('/')[1]), directory });
writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 'agentkit.native-packages/v1', sourceCommit, packages, ...dependencies }, null, 2) + '\n');
console.log(JSON.stringify({ directory, packages: packages.map(({ fileHashes, ...item }) => ({ ...item, files: Object.keys(fileHashes).length })),
  dependencyArchives: Object.keys(dependencies.dependencyPackages).length }, null, 2));
