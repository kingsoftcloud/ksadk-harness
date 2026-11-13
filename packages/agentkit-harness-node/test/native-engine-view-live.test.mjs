// Renders the engine's own task view in a real browser, embedded the way a host
// embeds it: a sandboxed iframe (scripts only, opaque origin) fed by postMessage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { resolveNativeBrowserExecutable } from '../src/native/browser-availability.mjs';

const executablePath = resolveNativeBrowserExecutable();
const html = (() => { try { return readFileSync(new URL('../dist/engine-view.html', import.meta.url), 'utf8'); } catch { return null; } })();
const e = (seq, kind, extra = {}) => ({ schema: 'agentkit.engine-event/v1', seq, kind, ...extra });

test('a host embeds the engine view and relays events; the view renders the timeline and reports its size',
  { skip: !executablePath ? 'No installed browser executable' : !html ? 'engine view not built' : false, timeout: 30000 }, async t => {
    const host = `<!doctype html><html><body><iframe id="v" sandbox="allow-scripts" src="/view" style="width:800px;height:600px;border:0"></iframe>
<script>
  window.messages = [];
  const frame = document.getElementById('v');
  window.addEventListener('message', m => { if (m.source === frame.contentWindow) window.messages.push(m.data); });
  window.send = msg => frame.contentWindow.postMessage({ contract: 'agentkit.engine-view/v1', ...msg }, '*');
</script></body></html>`;
    const server = createServer((req, res) => {
      if (req.url === '/view') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(host);
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
    const browser = await chromium.launch({ executablePath, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.messages.some(m => m.type === 'ready'));
    const ready = await page.evaluate(() => window.messages.find(m => m.type === 'ready'));
    assert.equal(ready.contract, 'agentkit.engine-view/v1'); assert.ok(ready.version);
    await page.evaluate(events => window.send({ type: 'events', runId: 'r1', events }), [
      e(1, 'run.started'),
      e(5, 'model.completed', { detail: 'Writing the file now.', calls: [{ callId: 'c1', name: 'write_workspace_file', arguments: { path: 'out.txt', content: 'hi' } }] }),
      e(7, 'tool.completed', { title: 'write_workspace_file', status: 'ok', callId: 'c1', result: { ok: true } }),
    ]);
    const frame = page.frameLocator('#v');
    await frame.getByTestId('harness-timeline').waitFor();
    await frame.getByText('Writing the file now.').waitFor();
    // Replaying an overlapping batch must not duplicate anything.
    await page.evaluate(events => window.send({ type: 'events', runId: 'r1', events }), [
      e(5, 'model.completed', { detail: 'Writing the file now.', calls: [{ callId: 'c1', name: 'write_workspace_file', arguments: { path: 'out.txt' } }] }),
      e(12, 'run.terminal', { title: 'completed', status: 'unverified', detail: 'Created out.txt.' }),
    ]);
    await frame.getByText('Created out.txt.').waitFor();
    assert.equal(await frame.getByText('Writing the file now.').count(), 0);
    await frame.getByTestId('work-history-toggle').click();
    await frame.getByText('Writing the file now.').waitFor();
    assert.equal(await frame.getByText('Writing the file now.').count(), 1);
    await frame.getByText('out.txt', { exact: true }).waitFor();
    await page.waitForFunction(() => window.messages.some(m => m.type === 'height' && m.height > 0));
    if (process.env.ENGINE_VIEW_SCREENSHOT) await page.locator('#v').screenshot({ path: process.env.ENGINE_VIEW_SCREENSHOT });
    assert.deepEqual(errors, []);
  });
