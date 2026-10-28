import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const permitted = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
const packages = [
  { path: 'packages/agentkit-harness-core', name: '@kingsoftcloud/agentkit-harness-core',
    dependencies: ['ajv', 'ajv-draft-04', 'ajv-formats'], builtins: false },
  { path: 'packages/agentkit-harness-node', name: '@kingsoftcloud/agentkit-harness-node',
    dependencies: ['@kingsoftcloud/agentkit-harness-core', '@astral-sh/ruff-wasm-nodejs', 'parse5', 'playwright-core', 'pngjs', 'diff'], builtins: true },
  { path: 'packages/agentkit-harness-ui', name: '@kingsoftcloud/agentkit-harness-ui',
    dependencies: ['react', 'react-dom'], builtins: false, source: true },
];
const results = [];
for (const item of packages) {
  const directory = join(root, item.path), metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  assert.equal(metadata.name, item.name); assert.equal(metadata.license, 'Apache-2.0');
  for (const name of Object.keys({ ...metadata.dependencies, ...metadata.peerDependencies, ...metadata.optionalDependencies }))
    assert.ok(item.dependencies.includes(name), `Unexpected public dependency: ${name}`);
  const files = [];
  async function visit(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(path, entry.name), `${prefix}${entry.name}/`);
      else files.push(`${prefix}${entry.name}`);
    }
  }
  const sourceRoots = item.source ? ['src'] : item.builtins ? ['dist', 'src'] : ['dist'];
  for (const sourceRoot of sourceRoots) await visit(join(directory, sourceRoot), sourceRoot + '/');
  assert.ok(files.includes((item.source ? 'src' : 'dist') + '/index.mjs'));
  let imports = 0;
  for (const file of files.filter(name => name.endsWith('.mjs'))) {
    const code = await readFile(join(directory, file), 'utf8');
    // Generated ESM has no computed loader. Source adapters may use explicit,
    // host-bound dynamic transports; static imports must stay inside the package.
    if (file.startsWith('dist/')) assert.doesNotMatch(code, /\b(?:import|require)\s*\(/, `Dynamic dependency in ${item.name}/${file}`);
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const specifiers = source.statements.flatMap(statement =>
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text] : []);
    for (const specifier of specifiers) {
      imports++;
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(join(directory, file)), specifier), tail = relative(directory, target);
        assert.ok(tail && !isAbsolute(tail) && tail !== '..' && !tail.startsWith('../'), `Escaping relative import ${file}: ${specifier}`);
      } else if (specifier === item.name || specifier.startsWith(item.name + '/')) {
        const key = specifier === item.name ? '.' : '.' + specifier.slice(item.name.length);
        assert.ok(Object.hasOwn(metadata.exports, key), `Undeclared self import ${specifier}`);
      } else assert.ok(item.dependencies.some(name => specifier === name || specifier.startsWith(`${name}/`))
        || item.builtins && permitted.has(specifier), `Forbidden import ${specifier} in ${item.name}`);
    }
  }
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: directory, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const contents = JSON.parse(packed.stdout)[0];
  for (const file of contents.files) assert.ok(/^(?:dist\/|src\/|markdown\/(?:source|build|dist)\/|LICENSE$|ZCode-LICENSE$|NOTICE$|THIRD_PARTY_NOTICES\.md$|README\.md$|package\.json$)/.test(file.path)
    && !/(?:^|\/)(?:\.env|config\.ya?ml|credentials|node_modules|test|tests|\.artifacts)(?:$|\/|\.)/.test(file.path),
  `Unexpected packed content ${file.path}`);
  assert.ok(contents.files.some(file => file.path === 'LICENSE'));
  if (item.source) {
    for (const path of ['markdown/dist/markdown.mjs', 'markdown/dist/markdown.css', 'markdown/dist/THIRD_PARTY_LICENSES.txt'])
      assert.ok(contents.files.some(file => file.path === path), `missing UI artifact ${path}`);
    assert.equal(metadata.exports['./command-output'], './src/command-output.mjs');
  }
  if (item.builtins) {
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])
      assert.ok(contents.files.some(file => file.path === `src/native/local-process-bin/${target}/launcher`), `missing launcher ${target}`);
    assert.ok(contents.files.some(file => file.path === 'src/native/workspace-patch-worker.mjs'));
    assert.ok(contents.files.some(file => file.path === 'dist/native-command-plan.mjs'));
  }
  results.push({ name: item.name, imports, files: contents.files.length, unpackedSize: contents.unpackedSize });
}
console.log(JSON.stringify({ status: 'passed', packages: results }, null, 2));
