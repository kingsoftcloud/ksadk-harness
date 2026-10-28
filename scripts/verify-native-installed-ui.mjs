import { mkdtemp, readFile, writeFile, copyFile, rm, mkdir } from 'node:fs/promises';
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
try {
  const dependencies = Object.fromEntries(manifest.packages.map(item => [item.name, 'file:' + resolve(packagesDir, item.filename)]));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'native-installed-ui-proof', private: true,
    type: 'module', dependencies: { ...dependencies, react: '18.3.1', 'react-dom': '18.3.1' } }));
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false']);
  await copyFile(join(root, 'tests/fixtures/installed-task-ui.mjs'), join(directory, 'probe.mjs'));
  const result = run(process.execPath, ['probe.mjs']);
  const evidence = JSON.parse(result.trim());
  await mkdir(join(root, '.artifacts'), { recursive: true });
  await writeFile(join(root, '.artifacts/installed-ui-proof.json'), JSON.stringify({ ...evidence, packages: manifest.packages }, null, 2) + '\n');
  console.log(result.trim());
} finally { await rm(directory, { recursive: true, force: true }); }
