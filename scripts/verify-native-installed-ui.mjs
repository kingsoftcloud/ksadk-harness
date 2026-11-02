import { mkdtemp, readFile, writeFile, copyFile, rm, mkdir } from 'node:fs/promises';
import { readFileSync, cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertIntegrity, verifyInstalledDependencyTree } from './native-registry-evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const packagesDir = join(root, '.artifacts/packages');
const manifest = JSON.parse(await readFile(join(packagesDir, 'manifest.json'), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'native-installed-ui-'));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    timeout: 60000, env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' } });
  if (result.status !== 0) throw Error(`${command} failed: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const dependencies = Object.fromEntries(manifest.packages.map(item => [item.name, 'file:' + resolve(packagesDir, item.filename)]));
  assert.ok(Object.keys(manifest.dependencyPackages ?? {}).length, 'Independent dependency archive evidence is required');
  for (const item of Object.values(manifest.dependencyPackages)) {
    // Install the registry's original bytes; do not re-pack node_modules.
    const path = resolve(packagesDir, item.filename);
    assertIntegrity(readFileSync(path), item.integrity);
    if (dependencies[item.name]) continue;
    dependencies[item.name] = 'file:' + path;
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'native-installed-ui-proof', private: true,
    type: 'module', dependencies }));
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false']);
  const verified = verifyInstalledDependencyTree(directory, manifest);
  // Exercise a real nested layout using a separately verified registry
  // dependency. It must not become a blanket node_modules exclusion.
  const nested = join(directory, 'node_modules/@kingsoftcloud/agentkit-harness-node/node_modules/pngjs');
  mkdirSync(resolve(nested, '..'), { recursive: true });
  cpSync(join(directory, 'node_modules/pngjs'), nested, { recursive: true });
  verifyInstalledDependencyTree(directory, manifest);
  writeFileSync(join(nested, 'unregistered.mjs'), 'tampered');
  assert.throws(() => verifyInstalledDependencyTree(directory, manifest), /Unexpected package file/);
  rmSync(join(nested, 'unregistered.mjs'));
  const metadataPath = join(nested, 'package.json'), original = readFileSync(metadataPath);
  writeFileSync(metadataPath, '{}');
  assert.throws(() => verifyInstalledDependencyTree(directory, manifest), /registry evidence|registry\/archive evidence|stale or modified/);
  writeFileSync(metadataPath, original);
  const nestedVerified = verifyInstalledDependencyTree(directory, manifest);
  run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { verifyPackageFiles } from '@kingsoftcloud/agentkit-harness-node/package-integrity';
    import { redactDiagnosticText } from '@kingsoftcloud/agentkit-harness-core/error-presentation';
    import { redactError } from '@kingsoftcloud/agentkit-harness-ui';
    mkdirSync('integrity-probe'); writeFileSync('integrity-probe/index.mjs', 'export const value=1;');
    const files = { 'index.mjs': createHash('sha256').update('export const value=1;').digest('hex') };
    assert.equal(verifyPackageFiles('integrity-probe', files), 1);
    writeFileSync('integrity-probe/extra.mjs', 'unregistered');
    assert.throws(() => verifyPackageFiles('integrity-probe', files), /Unexpected package file/);
    for (const project of [redactDiagnosticText, redactError])
      assert.doesNotMatch(project('Authorization: Bearer fixtureOnlyValue'), /fixtureOnlyValue/);
  `]);
  await copyFile(join(root, 'tests/fixtures/installed-task-ui.mjs'), join(directory, 'probe.mjs'));
  const result = run(process.execPath, ['probe.mjs']);
  const evidence = JSON.parse(result.trim());
  await mkdir(join(root, '.artifacts'), { recursive: true });
  await writeFile(join(root, '.artifacts/installed-ui-proof.json'), JSON.stringify({ ...evidence, packages: manifest.packages,
    dependencyPackages: manifest.dependencyPackages, verified, nestedVerified }, null, 2) + '\n');
  console.log(JSON.stringify({ ...evidence, verifiedPackages: verified.length, nestedVerifiedPackages: nestedVerified.length }));
} finally { await rm(directory, { recursive: true, force: true }); }
