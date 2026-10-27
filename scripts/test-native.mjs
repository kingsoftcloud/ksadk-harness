import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../packages/agentkit-harness-node/test/', import.meta.url));
const tests = readdirSync(directory).filter(name => name.endsWith('.test.mjs')
  && name !== 'native-browser-playwright-live.test.mjs').map(name => directory + name).sort();
if (!tests.length) throw Error('Native test suite is empty');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...tests], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
