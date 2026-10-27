// Controlled standalone verifier for @kingsoftcloud/agentkit-harness-node.
//
// Builds and packs BOTH local tarballs (core + node), installs them into a
// fresh temp directory, copies the example host into that install, and drives
// the real NativeKernel as actual child processes with a controlled (fake)
// model. Asserts cancellation, permission denial, budget exhaustion, and
// crash-after-write recovery with NO replay of the unknown side effect. Also
// asserts workspace path confinement rejects lexical '..' traversal, a
// parent-directory alias symlink, and a direct symlink to an outside file.
//
// No npm publish, no cloud runtime, no real credentials. Evidence JSON carries
// no secrets. The verifier exercises the actual packed kernel and adapters —
// there is no standalone loop and no mocked core.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const corePkg = join(root, 'packages/agentkit-harness-core');
const nodePkg = join(root, 'packages/agentkit-harness-node');
const hostSrc = join(root, 'examples/native-standalone/host.mjs');
const KEEP = process.env.NATIVE_VERIFY_KEEP === '1';

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...opts });
  if (r.status !== 0) {
    console.error(`command failed (${r.status}): ${cmd} ${args.join(' ')}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
    process.exit(1);
  }
  return r;
}

// 1. Build both packages (core: tsc; node: esbuild). Self-contained.
console.log(JSON.stringify({ stage: 'build' }));
runSync(process.execPath, [join(root, 'scripts/build-native-harness.mjs')]);
runSync(process.execPath, [join(root, 'scripts/build-native-node.mjs')]);

// 2. Pack both into a staging dir.
const staging = await mkdtemp(join(tmpdir(), 'native-standalone-pack-'));
const pack = (cwd, label) => {
  const r = runSync('npm', ['pack', '--json', '--ignore-scripts', `--pack-destination=${staging}`], { cwd });
  const out = JSON.parse(r.stdout);
  assert.equal(out.length, 1, `${label} pack returned ${out.length} entries`);
  return join(staging, out[0].filename);
};
const coreTarball = pack(corePkg, 'core');
const nodeTarball = pack(nodePkg, 'node');
console.log(JSON.stringify({ stage: 'packed', coreTarball, nodeTarball }));

// 3. Fresh install dir depending on both local tarballs.
const install = await mkdtemp(join(tmpdir(), 'native-standalone-install-'));
await writeFile(join(install, 'package.json'), JSON.stringify({
  name: 'native-standalone-proof', version: '1.0.0', private: true, type: 'module',
  dependencies: {
    '@kingsoftcloud/agentkit-harness-core': 'file:' + coreTarball,
    '@kingsoftcloud/agentkit-harness-node': 'file:' + nodeTarball,
  },
}, null, 2));
const npmEnv = { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false',
  npm_config_omit_dev: 'true', npm_config_ignore_scripts: 'true' };
console.log(JSON.stringify({ stage: 'install', install }));
runSync('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', '--ignore-scripts', '--workspaces=false'], { cwd: install, env: npmEnv, timeout: 120000 });

// 4. Copy the example host into the install so it resolves the public npm
//    names from node_modules (never Studio/src paths).
const host = join(install, 'host.mjs');
await copyFile(hostSrc, host);

// 5. Boundary check on the INSTALLED dist: neither package imports Studio/DSH.
const forbidden = /(?:from\s+|require\s*\(\s*)['"][^'"]*(?:\/agentkit-harness\/src\/|\/dsh\/|\/studio\/|global-config|model-service|credentials)[^'"]*['"]/;
for (const name of ['agentkit-harness-core', 'agentkit-harness-node']) {
  const distDir = join(install, 'node_modules/@kingsoftcloud', name, 'dist');
  assert.ok(existsSync(distDir), `${name} dist missing in install`);
  const { readdir } = await import('node:fs/promises');
  for (const file of (await readdir(distDir)).filter(f => f.endsWith('.mjs'))) {
    const code = await readFile(join(distDir, file), 'utf8');
    assert.doesNotMatch(code, forbidden, `${name}/${file} imports Studio/DSH/host code`);
  }
}
assert.ok(existsSync(join(install, 'node_modules/@kingsoftcloud/agentkit-harness-core/LICENSE')), 'core LICENSE not packed');
assert.ok(existsSync(join(install, 'node_modules/@kingsoftcloud/agentkit-harness-node/NOTICE')), 'node NOTICE not packed');
console.log(JSON.stringify({ stage: 'boundary-checked', install }));

// 6. Scenario driver.
const proofDir = join(install, 'proof');
await mkdir(proofDir, { recursive: true });
function spawnHost(env, argv, timeoutMs) {
  const child = spawn(process.execPath, [host, ...argv], { cwd: install, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  return new Promise(resolve => child.once('exit', (code, signal) => {
    clearTimeout(timer); resolve({ code, signal, stdout, stderr });
  }));
}
async function readEvidence(p) { return JSON.parse(await readFile(p, 'utf8')); }

const results = [];

// ---- happy: read + write; task verdict stays unverified without a verifier --
{
  const dir = join(proofDir, 'happy'); await mkdir(join(dir, 'ws'), { recursive: true });
  await writeFile(join(dir, 'ws', 'note.txt'), 'hello from note.txt', 'utf8');
  const ev = join(dir, 'evidence.json');
  const r = await spawnHost({ FAKE_SCENARIO: 'happy' }, ['--db', join(dir, 'run.sqlite'), '--workspace', join(dir, 'ws'), '--scenario', 'happy', '--evidence', ev], 30000);
  assert.equal(r.code, 0, `happy exit ${r.code}\n${r.stderr}`);
  const e = await readEvidence(ev);
  assert.equal(e.result.phase, 'completed', `happy phase ${e.result.phase} ${e.result.reason}`);
  assert.equal(e.result.outcome, 'unverified');
  assert.equal(e.result.reason, 'verification_report_missing');
  assert.equal(e.subscription.cursor, e.ledger.eventsCount);
  assert.deepEqual(e.subscription.events, e.ledger.events);
  assert.equal(e.toolExecutions.length, 2);
  assert.equal(await readFile(join(dir, 'ws', 'out.txt'), 'utf8'), 'written by standalone native host');
  results.push({ scenario: 'happy', phase: e.result.phase, outcome: e.result.outcome, toolExecutions: e.toolExecutions.length });
}

// ---- cancel: active model is canceled; receipt is uncertain ----------------
{
  const dir = join(proofDir, 'cancel'); await mkdir(join(dir, 'ws'), { recursive: true });
  await writeFile(join(dir, 'ws', 'note.txt'), 'x', 'utf8');
  const ev = join(dir, 'evidence.json');
  const r = await spawnHost({ FAKE_SCENARIO: 'cancel' }, ['--db', join(dir, 'run.sqlite'), '--workspace', join(dir, 'ws'), '--scenario', 'cancel', '--cancel-after', '200', '--evidence', ev], 30000);
  assert.equal(r.code, 0, `cancel exit ${r.code}\n${r.stderr}`);
  const e = await readEvidence(ev);
  assert.equal(e.result.phase, 'canceled', `cancel phase ${e.result.phase}`);
  assert.equal(e.result.reason, 'user_canceled');
  assert.equal(e.toolExecutions.length, 0);
  // The in-flight model attempt is sealed uncertain, not committed.
  assert.ok(e.ledger.receipts.some(rc => rc.status === 'uncertain'), 'cancel must leave an uncertain receipt');
  results.push({ scenario: 'cancel', phase: e.result.phase, reason: e.result.reason, uncertainReceipts: e.ledger.receipts.filter(rc => rc.status === 'uncertain').length });
}

// ---- deny: write without workspace:write permission is rejected ----------
{
  const dir = join(proofDir, 'deny'); await mkdir(join(dir, 'ws'), { recursive: true });
  await writeFile(join(dir, 'ws', 'note.txt'), 'x', 'utf8');
  const ev = join(dir, 'evidence.json');
  const r = await spawnHost({ FAKE_SCENARIO: 'deny' }, ['--db', join(dir, 'run.sqlite'), '--workspace', join(dir, 'ws'), '--scenario', 'deny', '--permissions', 'workspace:read', '--evidence', ev], 30000);
  assert.equal(r.code, 0, `deny exit ${r.code}\n${r.stderr}`);
  const e = await readEvidence(ev);
  assert.equal(e.result.phase, 'completed', `deny phase ${e.result.phase}`);
  assert.equal(e.toolExecutions.length, 1);
  assert.equal(e.toolExecutions[0].code, 'permission_denied');
  assert.equal(e.toolExecutions[0].required, 'workspace:write');
  // The rejected write never reached the filesystem.
  assert.equal(existsSync(join(dir, 'ws', 'out.txt')), false, 'deny must not write out.txt');
  results.push({ scenario: 'deny', phase: e.result.phase, denied: e.toolExecutions[0].code, wroteOut: existsSync(join(dir, 'ws', 'out.txt')) });
}

// ---- budget: maxModelCalls=1 + reserve rejects the requested tool -----------
{
  const dir = join(proofDir, 'budget'); await mkdir(join(dir, 'ws'), { recursive: true });
  await writeFile(join(dir, 'ws', 'note.txt'), 'x', 'utf8');
  const ev = join(dir, 'evidence.json');
  const r = await spawnHost({ FAKE_SCENARIO: 'budget' }, ['--db', join(dir, 'run.sqlite'), '--workspace', join(dir, 'ws'), '--scenario', 'budget', '--evidence', ev], 30000);
  assert.equal(r.code, 0, `budget exit ${r.code}\n${r.stderr}`);
  const e = await readEvidence(ev);
  assert.equal(e.result.phase, 'failed', `budget phase ${e.result.phase}`);
  assert.equal(e.result.outcome, 'budget_exhausted');
  assert.equal(e.result.reason, 'tool_call_after_finalization_reserve');
  assert.equal(e.toolExecutions.length, 0, 'budget must not execute the unaffordable tool');
  results.push({ scenario: 'budget', phase: e.result.phase, outcome: e.result.outcome, reason: e.result.reason, toolExecutions: e.toolExecutions.length });
}

// ---- restart: crash after the write side effect; resume must NOT replay ----
{
  const dir = join(proofDir, 'restart'); await mkdir(join(dir, 'ws'), { recursive: true });
  await writeFile(join(dir, 'ws', 'note.txt'), 'x', 'utf8');
  const db = join(dir, 'run.sqlite');
  // Process A: writes out.txt, then hard-exits (7) before the receipt commits.
  const a = await spawnHost({ FAKE_SCENARIO: 'restart', NATIVE_CRASH_AFTER_WRITE: '1' }, ['--db', db, '--workspace', join(dir, 'ws'), '--scenario', 'restart', '--crash-after-write', '--evidence', join(dir, 'a.json')], 30000);
  assert.equal(a.code, 7, `restart process A must crash with code 7, got ${a.code}\n${a.stderr}`);
  assert.ok(existsSync(join(dir, 'ws', 'out.txt')), 'process A must have written out.txt before crashing');
  let execLog = await readFile(join(dir, 'ws', '.native-exec.log'), 'utf8');
  let writesBefore = execLog.trim().split('\n').filter(Boolean).filter(line => JSON.parse(line).name === 'write').length;
  assert.equal(writesBefore, 1, 'process A must log exactly one write');
  // Wait past leaseMs (2000) so the crashed lease has expired.
  await new Promise(done => setTimeout(done, 2200));
  // Process B: resume the same run; the in-flight write is recovered unknown.
  const b = await spawnHost({ FAKE_SCENARIO: 'restart' }, ['--db', db, '--workspace', join(dir, 'ws'), '--scenario', 'restart', '--resume', '--evidence', join(dir, 'b.json')], 30000);
  assert.equal(b.code, 0, `restart process B exit ${b.code}\n${b.stderr}`);
  const e = await readEvidence(join(dir, 'b.json'));
  assert.equal(e.result.phase, 'interrupted', `resume phase ${e.result.phase}`);
  assert.equal(e.result.outcome, 'unverified');
  assert.equal(e.result.reason, 'effect_outcome_unknown');
  assert.equal(e.toolExecutions.length, 0, 'resume must NOT replay the write tool');
  // The write receipt is sealed uncertain with effect_outcome_unknown.
  assert.ok(e.ledger.receipts.some(rc => rc.status === 'uncertain' && rc.code === 'effect_outcome_unknown'), 'resume must seal the write as unknown');
  // No second write reached the filesystem or the exec log.
  execLog = await readFile(join(dir, 'ws', '.native-exec.log'), 'utf8');
  const writesAfter = execLog.trim().split('\n').filter(Boolean).filter(line => JSON.parse(line).name === 'write').length;
  assert.equal(writesAfter, 1, 'resume must not append a second write to the exec log');
  assert.equal(await readFile(join(dir, 'ws', 'out.txt'), 'utf8'), 'written by standalone native host', 'out.txt must be unchanged by resume');
  results.push({ scenario: 'restart', processA: { exit: a.code, writes: writesBefore }, processB: { exit: b.code, phase: e.result.phase, reason: e.result.reason, writes: writesAfter, toolExecutions: e.toolExecutions.length } });
}

// ---- symlink/parent-alias confinement: all escapes rejected ---------------
{
  const dir = join(proofDir, 'symlink'); await mkdir(join(dir, 'ws'), { recursive: true });
  await mkdir(join(dir, 'ws', 'subdir'), { recursive: true });
  await writeFile(join(dir, 'ws', 'note.txt'), 'x', 'utf8');
  // A secret file OUTSIDE the workspace.
  const secret = join(dir, 'outside-secret.txt');
  await writeFile(secret, 'TOPSECRET-contents\n', 'utf8');
  // Existing and dangling symlinks must both be rejected, including writes.
  await symlink(secret, join(dir, 'ws', 'escape'));
  await symlink(join(dir, 'escaped.txt'), join(dir, 'ws', 'dangling'));
  // Parent-directory alias: symlink inside ws pointing at ws's parent.
  await symlink(dir, join(dir, 'ws', 'parent'));
  const ev = join(dir, 'evidence.json');
  const r = await spawnHost({ FAKE_SCENARIO: 'symlink' }, ['--db', join(dir, 'run.sqlite'), '--workspace', join(dir, 'ws'), '--scenario', 'symlink', '--evidence', ev], 30000);
  assert.equal(r.code, 0, `symlink exit ${r.code}\n${r.stderr}`);
  const e = await readEvidence(ev);
  assert.equal(e.result.phase, 'completed', `symlink phase ${e.result.phase}`);
  assert.equal(e.toolExecutions.length, 5, 'all read and write escape attempts must be rejected');
  for (const ex of e.toolExecutions) {
    assert.equal(ex.code, 'invalid_path', `escape attempt ${ex.callId} must be rejected as invalid_path, got ${ex.code}`);
    assert.equal(ex.bytes, undefined, `escape attempt ${ex.callId} must not read any bytes`);
  }
  // The secret file is unchanged and never entered the exec log or evidence.
  assert.equal(await readFile(secret, 'utf8'), 'TOPSECRET-contents\n', 'outside secret must be unchanged');
  assert.equal(existsSync(join(dir, 'escaped.txt')), false, 'dangling and parent symlink writes must not create outside files');
  const execLog = await readFile(join(dir, 'ws', '.native-exec.log'), 'utf8');
  assert.doesNotMatch(execLog, /TOPSECRET/, 'exec log must not contain the outside secret');
  assert.doesNotMatch(JSON.stringify(e), /TOPSECRET/, 'evidence must not contain the outside secret');
  results.push({ scenario: 'symlink', phase: e.result.phase, rejected: e.toolExecutions.map(ex => ex.callId), secretLeaked: /TOPSECRET/.test(execLog) });
}

// 7. Final evidence.
const evidence = { format: 'agentkit.native-standalone-verify/v1', status: 'passed', node: process.version,
  install, scenarios: results };
if (process.env.NATIVE_STANDALONE_EVIDENCE) {
  const dest = resolve(process.env.NATIVE_STANDALONE_EVIDENCE);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence, null, 2));

if (!KEEP) await rm(staging, { recursive: true, force: true }).catch(() => {});
if (!KEEP) await rm(install, { recursive: true, force: true }).catch(() => {});
console.log('PASS: native-standalone verifier — cancellation, deny, budget, restart no-replay, and symlink confinement all hold against the packed installation.');
