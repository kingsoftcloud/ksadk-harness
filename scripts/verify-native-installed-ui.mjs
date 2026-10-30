import { mkdtemp, readFile, writeFile, copyFile, rm, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
function packLocal(name) {
  const source = resolve(root, 'node_modules', name);
  const result = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
    cwd: source, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60000,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  if (result.status !== 0) throw Error(`npm pack ${name} failed: ${result.stdout}\n${result.stderr}`);
  const metadata = JSON.parse(result.stdout)[0];
  return 'file:' + join(directory, metadata.filename);
}
try {
  const dependencies = Object.fromEntries(manifest.packages.map(item => [item.name, 'file:' + resolve(packagesDir, item.filename)]));
  // The proof must stay reproducible when the npm cache contains tarballs but
  // not registry metadata (as on a fresh GitHub Actions cache). Pack the
  // already-installed peer/runtime fixtures locally instead of reaching npmjs.
  const publicNames = new Set(manifest.packages.map(item => item.name));
  const packed = new Set();
  function packDependency(name) {
    if (publicNames.has(name) || packed.has(name)) return;
    const packageJson = JSON.parse(readFileSync(resolve(root, 'node_modules', name, 'package.json'), 'utf8'));
    dependencies[name] = packLocal(name); packed.add(name);
    for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      for (const dependency of Object.keys(packageJson[group] ?? {})) packDependency(dependency);
  }
  for (const item of manifest.packages) {
    const directoryName = item.name.slice(item.name.lastIndexOf('/') + 1);
    const packageJson = JSON.parse(readFileSync(join(root, 'packages', directoryName, 'package.json'), 'utf8'));
    for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      for (const dependency of Object.keys(packageJson[group] ?? {})) packDependency(dependency);
  }
  packDependency('react'); packDependency('react-dom');
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'native-installed-ui-proof', private: true,
    type: 'module', dependencies }));
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false']);
  await copyFile(join(root, 'tests/fixtures/installed-task-ui.mjs'), join(directory, 'probe.mjs'));
  const result = run(process.execPath, ['probe.mjs']);
  const evidence = JSON.parse(result.trim());
  await mkdir(join(root, '.artifacts'), { recursive: true });
  await writeFile(join(root, '.artifacts/installed-ui-proof.json'), JSON.stringify({ ...evidence, packages: manifest.packages }, null, 2) + '\n');
  console.log(result.trim());
} finally { await rm(directory, { recursive: true, force: true }); }
