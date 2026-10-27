import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'installed-dir': { type: 'string' }, evidence: { type: 'string' }, label: { type: 'string', default: 'live' } } });
assert.ok(values['installed-dir'], '--installed-dir must name the fresh local tarball installation');
for (const key of ['NATIVE_MODEL_NAME', 'NATIVE_MODEL_BASE_URL', 'NATIVE_MODEL_API_KEY'])
  assert.ok(process.env[key], `${key} must be supplied through the environment`);
const installed = resolve(values['installed-dir']);
for (const name of ['agentkit-harness-core', 'agentkit-harness-node']) {
  const metadata = JSON.parse(await readFile(join(installed, 'node_modules/@kingsoftcloud', name, 'package.json'), 'utf8'));
  assert.equal(metadata.name, `@kingsoftcloud/${name}`);
}
const directory = await mkdtemp(join(tmpdir(), 'native-installed-live-'));
const expected = `Standalone acceptance ${randomUUID()}\nCopy this exact observed file.`;
await writeFile(join(directory, 'input.txt'), expected);
const worker = join(installed, `native-live-worker-${randomUUID()}.mjs`);
await copyFile(new URL('./fixtures/native-installed-live-worker.mjs', import.meta.url), worker);
async function run(mode) {
  const processHandle = spawn(process.execPath, [worker, mode, directory], {
    cwd: installed, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Never echo provider output, input text, or inherited credentials.
  processHandle.stdout.resume(); processHandle.stderr.resume();
  const timer = setTimeout(() => processHandle.kill('SIGKILL'), 180000);
  try { return await new Promise((done, fail) => {
    processHandle.once('error', fail); processHandle.once('exit', (code, signal) => done({ code, signal }));
  }); } finally { clearTimeout(timer); }
}
const first = await run('start');
assert.equal(first.code, 73, 'first process must exit at the committed read checkpoint');
const checkpoint = JSON.parse(await readFile(join(directory, 'restart.json'), 'utf8'));
assert.ok(checkpoint.revision > 0 && checkpoint.eventCursor > 0);
assert.equal((await readFile(join(directory, 'reads.log'), 'utf8')).trim().split('\n').length, 1);
await new Promise(done => setTimeout(done, 2200));
assert.equal((await run('resume')).code, 0, 'new process must attach and complete the same run');
const result = JSON.parse(await readFile(join(directory, 'live-result.json'), 'utf8'));
assert.equal(result.phase, 'completed');
assert.equal(result.readCalls, 1); assert.equal(result.writeCalls, 1);
assert.equal(await readFile(join(directory, 'output.txt'), 'utf8'), expected);
assert.equal(result.registeredPolicy.id, 'example.exact-copy');
assert.equal(result.subscribedCursor, result.committedEvents);
assert.ok(result.committedEvents > checkpoint.eventCursor);
assert.equal((await run('resume')).code, 0);
const terminal = JSON.parse(await readFile(join(directory, 'live-result.json'), 'utf8'));
assert.deepEqual(terminal, result, 'terminal reattachment cannot execute tools or models again');
assert.equal((await readFile(join(directory, 'live.sqlite'))).includes(Buffer.from(process.env.NATIVE_MODEL_API_KEY)), false);
const evidence = { status: 'passed', label: values.label, ...result, processes: 3,
  restart: 'hard process exit after committed read; fresh process continued the same run',
  terminalReattach: 'no new events, model calls or writes', credentialsPersisted: false };
if (values.evidence) {
  const destination = resolve(values.evidence);
  const { dirname } = await import('node:path');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence, null, 2));
