import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, chmodSync, statSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const packages = ['agentkit-harness-core', 'agentkit-harness-node', 'agentkit-harness-ui'];
const supporting = ['build-native-harness.mjs', 'build-native-node.mjs', 'build-command-plan.mjs',
  'check-local-process-launcher.mjs'].map(name => `scripts/${name}`);
const skipped = new Set(['node_modules', 'dist', '.artifacts', '.DS_Store']);
const sha = value => createHash('sha256').update(value).digest('hex');
function inventory(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1).flatMap(entry => {
    if (skipped.has(entry.name) || entry.name.endsWith('.tgz')) return [];
    const path = join(directory, entry.name), name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error(`Unexpected source symlink: ${name}`);
    return entry.isDirectory() ? inventory(path, name + '/') : [{ path: name,
      sha256: sha(readFileSync(path)), executable: !!(statSync(path).mode & 0o111) }];
  });
}
const packageFacts = source => packages.map(name => {
  const files = inventory(join(source, 'packages', name));
  return { name, files: files.length, sha256: sha(JSON.stringify(files)) };
});
const snapshotPath = join(root, 'docs/native-source-snapshot.json');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--check') {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  if (JSON.stringify(packageFacts(root)) !== JSON.stringify(snapshot.packages)) throw Error('Native package source snapshot differs');
  for (const file of snapshot.supporting) if (sha(readFileSync(join(root, file.path))) !== file.sha256)
    throw Error(`Build input differs: ${file.path}`);
  console.log('All three Native package source trees and build inputs match the extraction snapshot.');
} else {
  const at = args.indexOf('--source');
  if (at < 0 || !args[at + 1] || args.some((arg, index) => index !== at + 1 && !['--source', '--apply'].includes(arg)))
    throw Error('Usage: node scripts/sync-from-studio.mjs --source <studio-directory> [--apply] | --check');
  const source = realpathSync(resolve(args[at + 1]));
  if (source === realpathSync(root)) throw Error('Source and destination must differ');
  const files = [...packages.flatMap(name => inventory(join(source, 'packages', name)).map(file => `packages/${name}/${file.path}`)), ...supporting];
  // Validate the complete allowlisted input set before copying any file.
  for (const file of files) if (!statSync(join(source, file)).isFile()) throw Error(`Missing build input: ${file}`);
  const changes = files.filter(file => {
    try { return !readFileSync(join(source, file)).equals(readFileSync(join(root, file))); } catch (error) {
      if (error.code === 'ENOENT') return true; throw error;
    }
  });
  console.log(JSON.stringify({ changedFiles: changes.length, files: changes, apply: args.includes('--apply') }, null, 2));
  if (args.includes('--apply')) {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
    if (['main', 'master', ''].includes(branch)) throw Error('Use an extraction branch');
    const dirty = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })
      .split('\0').filter(Boolean).map(row => row.slice(3));
    let previous;
    try { previous = JSON.parse(readFileSync(snapshotPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const unchanged = new Set(packageFacts(root).filter(item => previous?.packages.some(old => old.name === item.name
      && old.sha256 === item.sha256)).map(item => item.name));
    for (const file of changes) if (dirty.includes(file)) {
      const managed = packages.some(name => file.startsWith(`packages/${name}/`) && unchanged.has(name))
        || previous?.supporting.some(old => old.path === file && old.sha256 === sha(readFileSync(join(root, file))));
      if (!managed) throw Error(`Destination has an independent edit: ${file}`);
    }
    for (const file of changes) {
      const target = join(root, file); mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(source, file), target); chmodSync(target, statSync(join(source, file)).mode & 0o777);
    }
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    if (JSON.stringify(packageFacts(source)) !== JSON.stringify(packageFacts(root)))
      throw Error('Destination contains extra source files; review them before recording the snapshot');
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify({ schemaVersion: 'agentkit.native-source-snapshot/v1',
      source: { repository: 'agentkit-studio', revision,
        containsUncommittedChanges: !!execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim() },
      packages: packageFacts(root), supporting: supporting.map(path => ({ path, sha256: sha(readFileSync(join(root, path))) })) }, null, 2) + '\n');
  }
}
