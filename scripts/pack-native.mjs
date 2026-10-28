import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.artifacts/packages'); mkdirSync(directory, { recursive: true });
const packages = [];
for (const name of ['agentkit-harness-core', 'agentkit-harness-node', 'agentkit-harness-ui']) {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
    { cwd: join(root, 'packages', name), encoding: 'utf8' }));
  const path = join(directory, packed.filename);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  const filename = packed.filename.replace(/\.tgz$/, `-${digest.slice(0, 16)}.tgz`);
  renameSync(path, join(directory, filename));
  packages.push({ name: packed.name, version: packed.version, filename, sha256: digest, integrity: packed.integrity });
}
writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 'agentkit.native-packages/v1', packages }, null, 2) + '\n');
console.log(JSON.stringify({ directory, packages }, null, 2));
