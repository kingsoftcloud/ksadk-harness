// Controlled pack-install verifier for the Native RPC entry.
//
// Builds and packs BOTH local tarballs (@kingsoftcloud/agentkit-harness-core and
// @kingsoftcloud/agentkit-harness-node), installs them into a fresh temp dir,
// asserts the installed dist imports no Studio/DSH/host code, then drives the
// installed `agentkit-native-rpc` bin over NDJSON stdio against a CONTROLLED
// local openai-chat HTTP fixture. Asserts a happy read+write run reaches
// `completed` and writes the file, and that a retried requestId does NOT re-run
// (idempotency). No npm publish, no cloud, no real credentials.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const corePkg = join(root, 'packages/agentkit-harness-core');
const nodePkg = join(root, 'packages/agentkit-harness-node');
const KEEP = process.env.NATIVE_VERIFY_KEEP === '1';

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...opts });
  if (r.status !== 0) {
    console.error(`command failed (${r.status}): ${cmd} ${args.join(' ')}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
    process.exit(1);
  }
  return r;
}

console.log(JSON.stringify({ stage: 'build' }));
runSync(process.execPath, [join(root, 'scripts/build-native-harness.mjs')]);
runSync(process.execPath, [join(root, 'scripts/build-native-node.mjs')]);

// 1. Pack both tarballs.
const staging = await mkdtemp(join(tmpdir(), 'native-rpc-pack-'));
const pack = (cwd, label) => {
  const r = runSync('npm', ['pack', '--json', '--ignore-scripts', `--pack-destination=${staging}`], { cwd });
  const out = JSON.parse(r.stdout);
  assert.equal(out.length, 1, `${label} pack returned ${out.length} entries`);
  return join(staging, out[0].filename);
};
const coreTarball = pack(corePkg, 'core');
const nodeTarball = pack(nodePkg, 'node');
console.log(JSON.stringify({ stage: 'packed', coreTarball, nodeTarball }));

// 2. Fresh install depending on both local tarballs.
const install = await mkdtemp(join(tmpdir(), 'native-rpc-install-'));
await writeFile(join(install, 'package.json'), JSON.stringify({
  name: 'native-rpc-proof', version: '1.0.0', private: true, type: 'module',
  dependencies: {
    '@kingsoftcloud/agentkit-harness-core': 'file:' + coreTarball,
    '@kingsoftcloud/agentkit-harness-node': 'file:' + nodeTarball,
  },
}, null, 2));
const npmEnv = { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false',
  npm_config_omit_dev: 'true', npm_config_ignore_scripts: 'true' };
runSync('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', '--ignore-scripts', '--workspaces=false'], { cwd: install, env: npmEnv, timeout: 120000 });
console.log(JSON.stringify({ stage: 'install', install }));

// 3. Boundary check on the installed dist: neither package imports Studio/DSH.
const forbidden = /(?:from\s+|require\s*\(\s*)['"][^'"]*(?:\/agentkit-harness\/src\/|\/dsh\/|\/studio\/|global-config|model-service|credentials)[^'"]*['"]/;
const { readdir } = await import('node:fs/promises');
for (const name of ['agentkit-harness-core', 'agentkit-harness-node']) {
  const distDir = join(install, 'node_modules/@kingsoftcloud', name, 'dist');
  assert.ok(existsSync(distDir), `${name} dist missing in install`);
  for (const file of (await readdir(distDir)).filter(f => f.endsWith('.mjs'))) {
    const code = await readFile(join(distDir, file), 'utf8');
    assert.doesNotMatch(code, forbidden, `${name}/${file} imports Studio/DSH/host code`);
  }
}
assert.ok(existsSync(join(install, 'node_modules/@kingsoftcloud/agentkit-harness-node/dist/rpc-entry.mjs')), 'rpc-entry.mjs missing in install');
assert.ok(existsSync(join(install, 'node_modules/.bin/agentkit-native-rpc')), 'bin symlink missing in install');
console.log(JSON.stringify({ stage: 'boundary-checked', install }));

// 4. CONTROLLED openai-chat fixture (test-only, lives only in this verifier).
function toolCall(id, name, args) {
  return { choices: [{ message: { role: 'assistant', content: '', tool_calls:
    [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 } };
}
function final(text) {
  return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 } };
}
const script = [
  toolCall('c1', 'read', { path: 'note.txt' }),
  toolCall('c2', 'write', { path: 'out.txt', content: 'written by installed rpc' }),
  final('done'),
];
let fixtureCalls = 0;
const fixtureServer = createServer((req, res) => {
  fixtureCalls += 1;
  const step = script[Math.min(fixtureCalls - 1, script.length - 1)];
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(step));
});
await new Promise(r => fixtureServer.listen(0, '127.0.0.1', r));
const port = fixtureServer.address().port;
console.log(JSON.stringify({ stage: 'fixture', port }));

// 5. NDJSON client over the installed bin.
const bin = join(install, 'node_modules/@kingsoftcloud/agentkit-harness-node/dist/rpc-entry.mjs');
const wsDir = join(install, 'ws');
await mkdir(wsDir, { recursive: true });
await writeFile(join(wsDir, 'note.txt'), 'hello from note.txt', 'utf8');
const dbPath = join(install, 'run.sqlite');
const ledgerPath = join(install, 'ledger.sqlite');
const env = { ...process.env,
  NATIVE_MODEL_PROTOCOL: 'openai-chat', NATIVE_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`,
  NATIVE_MODEL_API_KEY: 'test-key', NATIVE_MODEL_NAME: 'test-model',
  NATIVE_MODEL_COMPAT: 'controlled/v1', NATIVE_MODEL_MAX_TOKENS: '256', NATIVE_MODEL_REQUEST_TIMEOUT_MS: '3000' };
const proc = spawn(process.execPath, [bin, '--db', dbPath, '--ledger', ledgerPath, '--workspace', wsDir,
  '--permissions', 'workspace:read,workspace:write',
  '--lease-ms', '1000', '--effect-timeout-ms', '8000', '--request-timeout-ms', '3000', '--max-model-calls', '8',
  '--exec-log', join(wsDir, '.native-exec.log')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let stdoutBuf = '', stderrBuf = '';
const waiters = [];
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', d => {
  stdoutBuf += d;
  const i = stdoutBuf.lastIndexOf('\n');
  if (i < 0) return;
  const add = stdoutBuf.slice(0, i); stdoutBuf = stdoutBuf.slice(i + 1);
  for (const line of add.split('\n')) if (line.trim()) {
    const msg = JSON.parse(line);
    const w = waiters.find(w => w.id === msg.id && !w.done);
    if (w) { w.done = true; w.resolve(msg); }
  }
});
proc.stderr.on('data', d => { stderrBuf += d; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function request(req, timeoutMs = 30000) {
  return new Promise((resolveP, reject) => {
    const w = { id: req.id, done: false, resolve: resolveP, reject };
    waiters.push(w);
    const t = setTimeout(() => { if (!w.done) { w.done = true; reject(new Error('request timeout')); } }, timeoutMs);
    w.resolve = m => { clearTimeout(t); resolveP(m); };
    proc.stdin.write(JSON.stringify(req) + '\n');
  });
}
async function pollStatus(runId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request({ jsonrpc: '2.0', id: `poll-${Math.random()}`, method: 'task/status', params: { runId } });
    if (res.error) throw new Error(`status error: ${JSON.stringify(res.error)}`);
    if (predicate(res.result)) return res.result;
    await sleep(50);
  }
  throw new Error(`timed out waiting for run ${runId}`);
}

const results = [];
try {
  const init = await request({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(init.result.protocolVersion, 'agentkit.native-rpc/v1');
  assert.deepEqual(init.result.capabilities.methods, ['initialize', 'task/submit', 'task/status', 'task/subscribe', 'task/cancel', 'task/resume']);

  const submit = await request({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
    params: { requestId: 'happy-1', objective: 'Read then write then finish.' } });
  assert.equal(submit.result.status, 'accepted');
  const r = await pollStatus(submit.result.runId, r => r.terminal);
  assert.equal(r.phase, 'completed', `happy phase ${r.phase} ${r.reason}`);
  assert.equal(await readFile(join(wsDir, 'out.txt'), 'utf8'), 'written by installed rpc');
  assert.equal(fixtureCalls, 3, 'exactly three model calls for the happy run');

  // requestId idempotency: re-submit the same business requestId + params -> completed, no re-run.
  const resubmit = await request({ jsonrpc: '2.0', id: 'req-2', method: 'task/submit',
    params: { requestId: 'happy-1', objective: 'Read then write then finish.' } });
  assert.equal(resubmit.result.status, 'completed', 'a retried requestId must return completed');
  assert.equal(fixtureCalls, 3, 'the retry must not call the model again');
  results.push({ scenario: 'happy+idempotent', phase: r.phase, fixtureCalls, out: 'written by installed rpc' });

  // requestId conflict: same business requestId, different params -> -32001.
  const conflict = await request({ jsonrpc: '2.0', id: 'req-3', method: 'task/submit',
    params: { requestId: 'happy-1', objective: 'different' } });
  assert.equal(conflict.error.code, -32001, 'a conflicting requestId must be rejected');
  results.push({ scenario: 'conflict', errorCode: conflict.error.code });
} finally {
  proc.stdin.end();
  await new Promise(r => proc.once('exit', r));
  await new Promise(r => fixtureServer.close(r));
  if (stderrBuf.trim()) console.error('--- bin stderr ---\n' + stderrBuf);
}

const evidence = { format: 'agentkit.native-rpc-verify/v1', status: 'passed', node: process.version, install, scenarios: results };
if (process.env.NATIVE_RPC_EVIDENCE) {
  const dest = resolve(process.env.NATIVE_RPC_EVIDENCE);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence, null, 2));
if (!KEEP) await rm(staging, { recursive: true, force: true }).catch(() => {});
if (!KEEP) await rm(install, { recursive: true, force: true }).catch(() => {});
console.log('PASS: native-rpc verifier — install boundary, happy run, and requestId idempotency/conflict hold against the packed installation.');
