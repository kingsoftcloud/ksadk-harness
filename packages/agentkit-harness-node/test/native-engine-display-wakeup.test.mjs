import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayWakeup } from '../src/native/engine-display-wakeup.mjs';

test('display data wakes only its own Run immediately, without waiting for the poll timeout', async () => {
  const display = createDisplayWakeup(), signal = new AbortController().signal;
  let other = false;
  const a = display.wait('a', 10000, signal), b = display.wait('b', 10000, signal).then(() => { other = true; });
  display.notify('a'); await a;
  assert.equal(other, false);
  display.notify('b'); await b;
  display.notify('a'); // completed waiters were removed
});

test('all concurrent readers wake; abort and idle deadlines remove listeners', async () => {
  const display = createDisplayWakeup(), controller = new AbortController();
  const waits = [display.wait('run', 10000, controller.signal), display.wait('run', 10000, controller.signal)];
  display.notify('run'); await Promise.all(waits);
  const aborted = display.wait('run', 10000, controller.signal);
  controller.abort(new Error('closed'));
  await assert.rejects(aborted, /closed/);
  await display.wait('run', 1, new AbortController().signal);
  display.notify('run');
});
