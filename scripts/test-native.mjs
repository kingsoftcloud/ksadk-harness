import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../packages/agentkit-harness-node/test/', import.meta.url));
// Real-browser suites depend on a cached Chromium executable and are kept out
// of the deterministic public gate. Run them explicitly with test:browser-live.
const tests = readdirSync(directory).filter(name => name.endsWith('.test.mjs')
  && !name.endsWith('-live.test.mjs')).map(name => directory + name).sort();
if (!tests.length) throw Error('Native test suite is empty');
const concurrency = process.env.TEST_CONCURRENCY || '1';
if (!/^\d+$/.test(concurrency) || Number(concurrency) < 1) throw Error('TEST_CONCURRENCY must be a positive integer');
const result = spawnSync(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...tests], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
