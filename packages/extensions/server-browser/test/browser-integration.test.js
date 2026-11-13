import { expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createBrowserManager } from '../src/browser-manager.js';
import { createBrowserRuntime } from '../src/browser-runtime.js';
import { connectCdp } from '../src/cdp-client.js';
import { createChromeProcess, resolveChromePath } from '../src/chrome-process.js';
import { createProfileStore } from '../src/profile-store.js';

const modifiers = Object.freeze({ alt: false, ctrl: false, meta: false, shift: false });

// A 1x1 PNG the fixture serves as every page's /favicon.ico.
const FAVICON_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const close = (server) => new Promise((resolve) => server.close(resolve));

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const html = (body, title) => `<!doctype html>
<html><head><title>${title}</title><style>
body { margin: 0; font-family: sans-serif; min-height: 2400px; }
#surface { position: absolute; left: 10px; top: 10px; width: 130px; height: 44px; }
#name { position: absolute; left: 10px; top: 70px; }
#mark { position: absolute; left: 10px; top: 120px; }
#output { position: absolute; left: 10px; top: 180px; }
#hash { position: absolute; left: 10px; top: 230px; }
</style></head><body>${body}</body></html>`;

const startWebFixture = async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.setHeader('content-type', 'image/png');
      response.end(FAVICON_PNG);
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/selects') {
      response.setHeader('content-security-policy', "default-src 'self'; style-src 'none'; script-src 'unsafe-inline'");
      response.end(html(`
        <input id="name" aria-label="Name" value="initial">
        <select id="native"><option>One</option><option>Two</option></select>
        <select id="listbox" size="2"><option>One</option><option>Two</option></select>
        <button id="custom" role="combobox">Custom menu</button>
      `, 'Select compatibility'));
      return;
    }
    if (request.url === '/next') {
      response.end(html('<h1>Next page</h1><a href="/">Home</a>', 'Next'));
      return;
    }
    if (request.url.startsWith('/api')) {
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ token: 'abc', ok: true }));
      return;
    }
    if (request.url === '/inspect') {
      response.end(html(`
        <button id="surface" onclick="console.error('boom from page'); fetch('/api?token=secret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'hunter2', name: 'ada' }) })">Run</button>
      `, 'Inspect'));
      return;
    }
    if (request.url === '/menu') {
      response.end(html(`
        <div id="surface">Plain area</div>
        <div id="custom" style="position:absolute;left:10px;top:300px;width:130px;height:44px">Custom</div>
        <p id="words" style="position:absolute;left:10px;top:400px">Copy these words</p>
        <script>
          window.clicks = 0;
          window.escapes = 0;
          addEventListener('click', () => { window.clicks += 1; });
          addEventListener('keydown', (event) => { if (event.key === 'Escape') window.escapes += 1; });
          document.querySelector('#custom').addEventListener('contextmenu', (event) => {
            event.preventDefault();
            document.title = 'Custom menu';
          });
        </script>
      `, 'Menu'));
      return;
    }
    if (request.url === '/tabs') {
      response.end(html(`
        <a id="surface" href="/next" target="_blank">Open next</a>
        <button id="mark" onclick="window.open('/next', 'popup')">Open popup</button>
      `, 'Tabs'));
      return;
    }
    if (request.url === '/title') {
      response.end(html('<button id="surface" onclick="document.title = \'Renamed by the page\'">Rename</button>', 'Title before'));
      return;
    }
    if (request.url === '/slow') {
      response.write('<!doctype html><title>Slow</title><p>Still loading');
      const timer = setTimeout(() => response.end('</p>'), 10_000);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    if (request.url === '/login') {
      response.setHeader('set-cookie', 'session=signed-in; Max-Age=86400; Path=/; HttpOnly');
      response.end(html('<script>localStorage.setItem(\'who\', \'ada\')</script><h1>Signed in</h1>', 'Login'));
      return;
    }
    if (request.url === '/whoami') {
      const signedIn = /session=signed-in/.test(request.headers.cookie ?? '');
      response.end(html(`<h1 id="state">${signedIn ? 'cookie present' : 'no cookie'}</h1><p id="agent">${request.headers['user-agent']}</p><p id="stored"></p><script>document.querySelector('#stored').textContent = 'stored ' + localStorage.getItem('who')</script>`, 'Who am I'));
      return;
    }
    if (request.url === '/dialogs') {
      response.end(html(`
        <button id="surface" onclick="document.querySelector('#output').textContent = String(confirm('Delete the draft?'))">Confirm</button>
        <button id="name" onclick="document.querySelector('#output').textContent = String(prompt('Your name?', 'Ada'))">Prompt</button>
        <button id="mark" onclick="alert('first'); alert('second'); document.querySelector('#output').textContent = 'alerts done'">Alerts</button>
        <div id="output">Waiting</div>
      `, 'Dialogs'));
      return;
    }
    if (request.url === '/opens-alert') {
      response.end(html(`<button id="surface" onclick="window.open('/alerts-on-load')">Open</button>`, 'Opens alert'));
      return;
    }
    if (request.url === '/alerts-on-load') {
      response.end(html('<script>alert("hello from the popup")</script><div id="output">Loaded</div>', 'Alerts on load'));
      return;
    }
    if (request.url === '/leave') {
      response.end(html(`
        <script>addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = ''; });</script>
        <input id="surface" value="unsaved">
      `, 'Leave'));
      return;
    }
    if (request.url === '/files') {
      response.end(html(`
        <input id="surface" type="file" accept=".txt" multiple>
        <div id="output">Waiting</div>
        <script>
          const input = document.querySelector('#surface');
          input.addEventListener('change', async () => {
            const read = await Promise.all([...input.files].map(async (file) => file.name + '=' + await file.text()));
            document.querySelector('#output').textContent = read.join(',');
          });
        </script>
      `, 'Files'));
      return;
    }
    if (request.url === '/report') {
      response.setHeader('content-type', 'text/csv');
      response.setHeader('content-disposition', 'attachment; filename="report.csv"');
      response.end('a,b\n1,2\n');
      return;
    }
    if (request.url === '/downloads') {
      response.end(html('<a id="surface" href="/report" download>Report</a>', 'Downloads'));
      return;
    }
    if (request.url === '/tone') {
      response.end(html(`
        <button id="surface" onclick="window.startTone()">Play</button>
        <script>
          window.startTone = () => {
            const context = new AudioContext();
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            gain.gain.value = 0.3;
            oscillator.frequency.value = 440;
            oscillator.connect(gain).connect(context.destination);
            oscillator.start();
            return context.resume();
          };
          window.selfCapture = () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, preferCurrentTab: true })
            .then((stream) => { stream.getTracks().forEach((track) => track.stop()); return 'granted'; }, (error) => error.name);
        </script>
        <iframe id="frame" srcdoc="<script>window.selfCapture = () => navigator.mediaDevices.getDisplayMedia({ video: true, preferCurrentTab: true }).then(() => 'granted', (error) => error.name);</script>"></iframe>
        <div id="tick"></div>
        <script>let tick = 0; setInterval(() => { document.querySelector('#tick').textContent = String(tick++); }, 100);</script>
      `, 'Tone'));
      return;
    }
    if (request.url === '/hang') {
      response.end(html('<button id="hang" onclick="for (;;) {}">Hang</button>', 'Hang'));
      return;
    }
    if (request.url === '/copy') {
      response.end(html(`
        <input id="secret" type="password" value="hunter2">
        <div id="host"></div>
        <iframe id="frame" srcdoc="<textarea id='inner'>frame text</textarea>"></iframe>
        <script>
          document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<input id="shadowed" value="shadow text">';
        </script>
      `, 'Copy'));
      return;
    }
    if (request.url === '/keys') {
      response.end(html(`
        <textarea id="notes"></textarea>
        <form id="form"><input id="field" value="hello world"></form>
        <output id="submits">0</output>
        <script>
          document.querySelector('#form').addEventListener('submit', (event) => {
            event.preventDefault();
            const submits = document.querySelector('#submits');
            submits.textContent = String(Number(submits.textContent) + 1);
          });
        </script>
      `, 'Keys'));
      return;
    }
    response.end(html(`
      <button id="surface" onclick="this.textContent='Surface clicked'">Surface</button>
      <input id="name" aria-label="Name" value="initial">
      <button id="mark" onclick="document.querySelector('#output').textContent=document.querySelector('#name').value">Mark</button>
      <div id="output">Waiting</div>
      <a id="hash" href="#section">Section</a>
      <h1 id="section" style="margin-top:320px">Browser fixture</h1>
    `, 'Fixture'));
  });
  const port = await listen(server);
  return { server, origin: `http://127.0.0.1:${port}` };
};

let chromePath = null;
try {
  chromePath = resolveChromePath();
} catch {}

// Chrome-dependent suites skip instead of failing when the host has none,
// same as the original extension's `node:test` `{ skip }` option; bun:test
// has no equivalent inline per-call skip reason, so `skipIf` stands in.
const noChrome = !chromePath;
const notLinuxChrome = !(chromePath && process.platform === 'linux');

test.skipIf(noChrome)('runs every browser action and the shared surface against real Chrome', async () => {
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());

    const opened = await runtime.perform('browser.open', { url: `${web.origin}/`, viewport: 'desktop' });
    const initial = await runtime.perform('browser.snapshot', {});
    const inspected = await runtime.perform('browser.inspect', { selector: '#name' });
    await runtime.perform('browser.type', { selector: '#name', value: 'Ada', submit: false });
    await runtime.perform('browser.click', { selector: '#mark' });
    const marked = await runtime.perform('browser.snapshot', {});
    const scrolled = await runtime.perform('browser.scroll', { direction: 'bottom' });
    const capture = await runtime.perform('browser.capture', { label: 'fixture' });
    const resized = await runtime.perform('browser.resize', { viewport: 'mobile' });
    await runtime.perform('browser.open', { url: `${web.origin}/next`, tabId: opened.tabId });
    const back = await runtime.perform('browser.back', {});
    const forward = await runtime.perform('browser.forward', {});

    expect(opened.opened).toBe(true);
    expect(opened.url).toBe(`${web.origin}/`);
    expect(initial.text).toMatch(/Browser fixture/);
    expect(inspected.tag).toBe('input');
    expect(marked.text).toMatch(/Ada/);
    expect(scrolled.atBottom).toBe(true);
    expect(Buffer.from(capture.base64, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(resized.viewport).toEqual({ mode: 'mobile', width: 390, height: 844 });
    expect(back.title).toBe('Fixture');
    expect(forward.title).toBe('Next');

    await runtime.perform('browser.back', {});
    await runtime.perform('browser.scroll', { direction: 'top' });
    const frame = await runtime.surfaceFrame({ after: 0, wait: 10_000 });
    await runtime.surfaceInput([
      { type: 'pointer', action: 'down', x: 30, y: 30, button: 0, buttons: 1, modifiers },
      { type: 'pointer', action: 'up', x: 30, y: 30, button: 0, buttons: 0, modifiers },
    ]);
    const afterPointer = await runtime.perform('browser.snapshot', {});
    const page = await runtime.ensurePage();
    const withinDocument = Promise.withResolvers();
    const stopWatchingNavigation = page.cdp.onEvent((event) => {
      if (event.sessionId === page.sessionId && event.method === 'Page.navigatedWithinDocument') withinDocument.resolve();
    });
    await runtime.surfaceInput([
      { type: 'pointer', action: 'down', x: 30, y: 240, button: 0, buttons: 1, modifiers },
      { type: 'pointer', action: 'up', x: 30, y: 240, button: 0, buttons: 0, modifiers },
    ]);
    await withinDocument.promise;
    stopWatchingNavigation();
    expect(runtime.url).toBe(`${web.origin}/#section`);
    await runtime.surfaceResize({ width: 700, height: 500 });
    const afterSurfaceResize = await runtime.perform('browser.snapshot', {});
    const filled = await runtime.perform('browser.resize', { viewport: 'fill' });

    expect(frame.mime).toBe('image/jpeg');
    expect(frame.bytes.length > 100).toBe(true);
    expect(afterPointer.text).toMatch(/Surface clicked/);
    expect(afterSurfaceResize.viewport).toEqual({ mode: 'mobile', width: 390, height: 844 });
    expect(filled.viewport).toEqual({ mode: 'custom', width: 700, height: 500 });

    runtime.surfaceControl('user');
    await expect(runtime.perform('browser.snapshot', {})).rejects.toThrow(/user controls the browser/i);
    runtime.surfaceControl('agent');
    expect((await runtime.perform('browser.snapshot', {})).text).toMatch(/Browser fixture/);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('runs page/evaluate and page/capture, zooms the page, sets its color scheme, and clears its cookies and cache', async () => {
  // Given a throwaway scope and a profile-copy scope, both on the fixture.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/` });

    // When the dock evaluates JavaScript in the page, then it runs in the main world and returns by value.
    expect(await runtime.pageEvaluate('1 + 1')).toBe(2);
    expect(await runtime.pageEvaluate('document.title')).toBe('Fixture');
    expect(await runtime.pageEvaluate('Promise.resolve(21 * 2)')).toBe(42);
    await expect(runtime.pageEvaluate('throw new Error("boom")')).rejects.toThrow(/boom/);

    // When the dock captures the page, then it answers a PNG at the viewport size.
    const capture = await runtime.pageCapture();
    expect(capture.mime).toBe('image/png');
    expect(Buffer.from(capture.base64, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(capture.width > 0 && capture.height > 0).toBe(true);

    // When the dock zooms in, then the page's own stylesheet carries the Chrome zoom step (1.2^level).
    expect(await runtime.pageEvaluate('getComputedStyle(document.documentElement).zoom')).toBe('1');
    await runtime.setZoomLevel(2);
    expect(runtime.zoomLevel).toBe(2);
    expect(await runtime.pageEvaluate('getComputedStyle(document.documentElement).zoom')).toBe(String(1.2 ** 2));
    await expect(runtime.setZoomLevel(6)).rejects.toThrow(/-5 to 5/);
    await runtime.setZoomLevel(0);
    expect(await runtime.pageEvaluate('getComputedStyle(document.documentElement).zoom')).toBe('1');

    // When the dock picks a color scheme, then the page's prefers-color-scheme follows it, and system drops the override.
    const prefersDark = "matchMedia('(prefers-color-scheme: dark)').matches";
    await runtime.setColorScheme('dark');
    expect(runtime.colorScheme).toBe('dark');
    expect(await runtime.pageEvaluate(prefersDark)).toBe(true);
    await runtime.setColorScheme('light');
    expect(await runtime.pageEvaluate(prefersDark)).toBe(false);
    await runtime.setColorScheme('system');
    await expect(runtime.setColorScheme('sepia')).rejects.toThrow(/system, light, or dark/);

    // When the dock clears cookies on a throwaway scope's page, then the server no longer sees it.
    // `/login`'s cookie is HttpOnly, invisible to `document.cookie`; `/whoami`
    // reads it server-side instead. `runtime.command('navigate', …)` reuses
    // the active tab, unlike `browser.open`, which would open a second one.
    await runtime.command('navigate', { url: `${web.origin}/login` });
    await runtime.command('navigate', { url: `${web.origin}/whoami` });
    expect((await runtime.perform('browser.snapshot', {})).text).toMatch(/cookie present/);
    await runtime.pageClear('cookies');
    await runtime.command('navigate', { url: `${web.origin}/whoami` });
    expect((await runtime.perform('browser.snapshot', {})).text).toMatch(/no cookie/);
    await expect(runtime.pageClear('nonsense')).rejects.toThrow(/"cookies" or "cache"/);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('clears cookies on a profile copy without touching the saved profile', async () => {
  // Given a saved profile already signed in, and a chat's copy of it.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-clear-integration-'));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const store = createProfileStore({ root: path.join(scratch, 'store'), keyFile: path.join(scratch, 'key', 'profile.key'), workRoot: path.join(scratch, 'run') });
    const saved = await store.create('Work');
    const profile = { id: saved.id, name: saved.name, checkout: () => store.checkout(saved.id), checkin: (directory, version) => store.checkin(saved.id, directory, version) };
    const seed = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin], profile });
    await seed.perform('browser.open', { url: `${web.origin}/login` });
    await seed.close({ save: true });

    // When the chat's copy clears its cookies, then its own page sees none, but the saved profile keeps its login.
    const copy = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin], profile });
    cleanups.push(() => copy.close());
    await copy.command('navigate', { url: `${web.origin}/whoami` });
    expect((await copy.perform('browser.snapshot', {})).text).toMatch(/cookie present/);
    await copy.pageClear('cookies');
    await copy.command('navigate', { url: `${web.origin}/whoami` });
    expect((await copy.perform('browser.snapshot', {})).text).toMatch(/no cookie/);

    const fresh = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin], profile });
    cleanups.push(() => fresh.close());
    await fresh.perform('browser.open', { url: `${web.origin}/whoami` });
    expect((await fresh.perform('browser.snapshot', {})).text).toMatch(/cookie present/);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('removes the temporary Chrome profile on shutdown', async () => {
  const chrome = createChromeProcess({ chromePath });
  const running = await chrome.ensure();
  const profileDir = running.profileDir;

  await chrome.close();

  expect(fs.existsSync(profileDir)).toBe(false);
  expect(running.process.exitCode === null && running.process.signalCode === null).not.toBe(true);
});

test.skipIf(noChrome)('stops Chrome at once on close even when its page no longer answers', async () => {
  // Given a page stuck in an endless loop, with native select styles that a graceful close would try to undo there.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/hang` });
    await runtime.setNativeSelectCompatibility(true);
    const page = await runtime.ensurePage();
    void page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', { expression: 'document.querySelector("#hang").click()' }).catch(() => {});

    // When the runtime closes, then it finishes well inside the five seconds the host waits before killing the service.
    const started = Date.now();
    await runtime.close();
    const elapsed = Date.now() - started;
    expect(elapsed < 2_500).toBe(true);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('reload reloads the document even when its URL contains a fragment', async () => {
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/#section` });
    await runtime.perform('browser.type', { selector: '#name', value: 'Before reload', submit: false });
    await runtime.perform('browser.click', { selector: '#mark' });
    expect((await runtime.perform('browser.snapshot', {})).text).toMatch(/Before reload/);
    await runtime.command('reload');
    const snapshotText = () => runtime.perform('browser.snapshot', {}).then((snapshot) => snapshot.text, () => '');
    await waitFor(async () => /Waiting/.test(await snapshotText()));
    expect(runtime.url).toBe(`${web.origin}/#section`);
    expect(await snapshotText()).not.toMatch(/Before reload/);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('applies and removes native select compatibility without reloading page state', async () => {
  // Given a CSP-protected page with native, listbox, and custom dropdown controls.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/selects` });
    await runtime.perform('browser.type', { selector: '#name', value: 'Preserved', submit: false });
    const page = await runtime.ensurePage();
    const appearances = async () => {
      const result = await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
        expression: `JSON.stringify({
          native: getComputedStyle(document.querySelector('#native')).appearance,
          listbox: getComputedStyle(document.querySelector('#listbox')).appearance,
          custom: getComputedStyle(document.querySelector('#custom')).appearance,
          value: document.querySelector('#name').value,
        })`,
        returnByValue: true,
      });
      return JSON.parse(result.result.value);
    };
    const before = await appearances();

    // When compatibility is enabled, then only the single-choice native select opts in.
    await runtime.setNativeSelectCompatibility(true);
    const enabled = await appearances();
    expect(enabled.native).toBe('base-select');
    expect(enabled.listbox).toBe(before.listbox);
    expect(enabled.custom).toBe(before.custom);
    expect(enabled.value).toBe('Preserved');

    // When the page navigates and compatibility is disabled, then it follows navigation and reverses without reload.
    await runtime.command('reload');
    let afterReload = null;
    await waitFor(async () => {
      afterReload = await appearances().catch(() => null);
      return afterReload?.value === 'initial' && afterReload.native === 'base-select';
    });
    expect(afterReload.native).toBe('base-select');
    await runtime.perform('browser.type', { selector: '#name', value: 'Still here', submit: false });
    await runtime.setNativeSelectCompatibility(false);
    const disabled = await appearances();
    expect(disabled.native).toBe(before.native);
    expect(disabled.value).toBe('Still here');
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('types editing keys, Enter, select-all, and composed characters like a local keyboard', async () => {
  // Given a page with a textarea and a single-field form.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/keys` });
    const page = await runtime.ensurePage();
    const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
    })).result.value;
    const press = (key, code, pressed = {}) => runtime.surfaceInput(['down', 'up'].map((action) => ({
      type: 'key', action, key, code, modifiers: { ...modifiers, ...pressed },
    })));

    // When the viewer types text, Enter, AltGr and Option characters, and two shortcuts.
    await evaluate('document.querySelector("#notes").focus()');
    await press('a', 'KeyA');
    await press('Enter', 'Enter');
    await press('b', 'KeyB');
    await press('@', 'KeyQ', { ctrl: true, alt: true });
    await press('@', 'Digit2', { alt: true });
    await press('c', 'KeyC', { ctrl: true });
    await press('d', 'KeyD', { alt: true });

    // Then Enter adds a line, composed characters are typed, and shortcuts type nothing.
    expect(await evaluate('document.querySelector("#notes").value')).toBe('a\nb@@');

    // When the caret moves with End and Home, and Meta+A selects the field.
    await evaluate('document.querySelector("#field").focus(); document.querySelector("#field").setSelectionRange(5, 5)');
    const selection = 'JSON.stringify([document.querySelector("#field").selectionStart, document.querySelector("#field").selectionEnd])';
    await press('End', 'End');
    const afterEnd = await evaluate(selection);
    await press('Home', 'Home');
    const afterHome = await evaluate(selection);
    await press('a', 'KeyA', { meta: true });
    const afterSelectAll = await evaluate(selection);
    await press('Enter', 'Enter');

    // When the viewer types punctuation whose character code equals an editing
    // key's code ('.' is Delete's 46, '-' Insert's 45, '%' to '(' the arrows).
    await evaluate('document.querySelector("#notes").value = ""; document.querySelector("#notes").focus()');
    for (const [key, code, shift] of [
      ['.', 'Period'], ['-', 'Minus'], [',', 'Comma'], ['!', 'Digit1', true], ['"', 'Quote', true],
      ['#', 'Digit3', true], ['$', 'Digit4', true], ['%', 'Digit5', true], ['&', 'Digit7', true],
      ["'", 'Quote'], ['(', 'Digit9', true], [')', 'Digit0', true], ['*', 'Digit8', true], ['+', 'Equal', true],
    ]) await press(key, code, shift ? { shift: true } : {});

    // Then every character is typed and nothing is deleted or moved.
    expect(await evaluate('document.querySelector("#notes").value')).toBe('.-,!"#$%&\'()*+');

    // Then each key runs Chrome's default action, and Enter submits the form.
    expect(afterEnd).toBe('[11,11]');
    expect(afterHome).toBe('[0,0]');
    expect(afterSelectAll).toBe('[0,11]');
    expect(await evaluate('document.querySelector("#submits").textContent')).toBe('1');
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('copies the focused selection through shadow roots and same-origin frames but never a password', async () => {
  // Given a page with a password field, an open shadow root, and a same-origin frame.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/copy` });
    const page = await runtime.ensurePage();
    const select = (expression) => page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', { expression });

    // When text is selected in each place, then only readable selections are copied.
    await select('const s = document.querySelector("#host").shadowRoot.querySelector("#shadowed"); s.focus(); s.setSelectionRange(0, 6)');
    expect(await runtime.surfaceClipboard()).toBe('shadow');
    await select('const t = document.querySelector("#frame").contentDocument.querySelector("#inner"); t.focus(); t.setSelectionRange(0, 5)');
    expect(await runtime.surfaceClipboard()).toBe('frame');
    await select('const p = document.querySelector("#secret"); p.focus(); p.select()');
    expect(await runtime.surfaceClipboard()).toBe('');
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('drags across page text to select it like a held mouse button', async () => {
  // Given a page with a heading.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/next` });

    // When the viewer moves with the button held, as hosts report moves, then the text is selected.
    await runtime.surfaceInput([
      { type: 'pointer', action: 'down', x: 2, y: 40, button: 0, buttons: 1, modifiers },
      { type: 'pointer', action: 'move', x: 80, y: 40, button: -1, buttons: 1, modifiers },
      { type: 'pointer', action: 'move', x: 200, y: 40, button: -1, buttons: 1, modifiers },
      { type: 'pointer', action: 'up', x: 200, y: 40, button: 0, buttons: 0, modifiers },
    ]);
    expect(await runtime.surfaceClipboard()).toBe('Next page');
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('replaces a scope whose Chrome stopped with a fresh browser on the next action', async () => {
  // Given a chat whose scope runs a real Chrome.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtimes = [];
    const manager = createBrowserManager({
      createRuntime: () => {
        const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
        runtimes.push(runtime);
        return runtime;
      },
    });
    cleanups.push(() => manager.close());
    const chat = { directory: '/repo', sessionId: 'ses_crash' };
    await manager.perform('browser.open', { url: `${web.origin}/` }, undefined, chat);
    const page = await runtimes[0].ensurePage();

    // When that Chrome exits.
    await page.cdp.send('Browser.close').catch(() => {});
    await waitFor(() => manager.state().notice !== null);

    // Then the old runtime refuses work, and the chat's next action starts a new browser.
    expect(manager.state().scopes).toEqual([]);
    await expect(runtimes[0].perform('browser.snapshot', {})).rejects.toThrow(/stopped unexpectedly|closed/);
    const reopened = await manager.perform('browser.open', { url: `${web.origin}/next` }, undefined, chat);
    expect(reopened.title).toBe('Next');
    expect(runtimes.length).toBe(2);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('tracks title, loading, and history for the dock, and stops a slow load', async () => {
  // Given a page whose title changes when the user clicks it.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/title` });

    // When the user clicks it, then the title follows the page rather than the last agent action.
    await runtime.surfaceInput([
      { type: 'pointer', action: 'down', x: 30, y: 30, button: 0, buttons: 1, modifiers },
      { type: 'pointer', action: 'up', x: 30, y: 30, button: 0, buttons: 0, modifiers },
    ]);
    await waitFor(() => runtime.title === 'Renamed by the page');

    // When the dock navigates and goes back, then history availability follows.
    await runtime.command('navigate', { url: `${web.origin}/next` });
    await waitFor(() => runtime.title === 'Next' && runtime.canGoBack && !runtime.isLoading);
    expect(runtime.canGoForward).toBe(false);
    await runtime.command('back');
    await waitFor(() => runtime.url === `${web.origin}/title` && runtime.canGoForward);

    // When a slow page is stopped, then loading ends without waiting for the server.
    await runtime.command('navigate', { url: `${web.origin}/slow` });
    await waitFor(() => runtime.isLoading);
    await runtime.command('stop');
    await waitFor(() => !runtime.isLoading, 2_000);

    // Then the dock still refuses anything but http(s).
    await expect(runtime.command('navigate', { url: 'file:///etc/passwd' })).rejects.toThrow(/http\(s\)/);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('follows pages the site opens as tabs and returns to the opener when they close', async () => {
  // Given a page with a target=_blank link and a window.open button.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/tabs` });
    const opener = runtime.tabs[0].id;
    const click = (x, y) => runtime.surfaceInput([
      { type: 'pointer', action: 'down', x, y, button: 0, buttons: 1, modifiers },
      { type: 'pointer', action: 'up', x, y, button: 0, buttons: 0, modifiers },
    ]);

    // When the user follows a link on the agent's page, then the new page becomes the active tab and the agent works there.
    await click(30, 30);
    await waitFor(() => runtime.tabs.length === 2 && runtime.url === `${web.origin}/next`);
    expect((await runtime.perform('browser.snapshot', {})).title).toBe('Next');

    // When that tab closes, then its opener comes back.
    await runtime.command('tab-close', { tabId: runtime.tabs.find((tab) => tab.active).id });
    expect(runtime.tabs.map((tab) => [tab.id, tab.active])).toEqual([[opener, true]]);

    // When the page opens a window from script, then it is tracked and brought forward too.
    await click(30, 128);
    await waitFor(() => runtime.tabs.length === 2 && runtime.url === `${web.origin}/next`);

    // When the agent's tab is gone and the dock selects the opener, then the agent works on the tab in front.
    await runtime.command('tab-new');
    expect(runtime.tabs.length).toBe(3);
    expect(runtime.url).toBe('about:blank');
    await runtime.command('tab-select', { tabId: opener });
    expect((await runtime.perform('browser.snapshot', {})).title).toBe('Tabs');
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('lets the agent name tabs by id without moving the viewer off its tab', async () => {
  // Given a new browser, whose first page loads in the blank tab the viewer sees.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    const first = await runtime.perform('browser.open', { url: `${web.origin}/next` });
    const shown = first.tabId;
    expect(runtime.tabs.map((tab) => [tab.id, tab.active])).toEqual([[shown, true]]);
    const before = await runtime.surfaceFrame({ after: 0, wait: 10_000 });
    expect(before).toBeTruthy();

    // When the agent opens another page, then it gets a background tab, the viewer stays put, and actions naming no tab follow the agent there.
    const opened = await runtime.perform('browser.open', { url: `${web.origin}/` });
    expect(opened.tabId).not.toBe(shown);
    expect(opened.title).toBe('Fixture');
    const snapshot = await runtime.perform('browser.snapshot', {});
    expect(snapshot.title).toBe('Fixture');
    expect(snapshot.tabs).toEqual([
      { id: shown, title: 'Next', url: `${web.origin}/next`, active: false },
      { id: opened.tabId, title: 'Fixture', url: `${web.origin}/`, active: true },
    ]);
    expect(runtime.tabs.find((tab) => tab.active).id).toBe(shown);

    // When the viewer switches to another tab, then the agent stays on its own.
    await runtime.command('tab-select', { tabId: opened.tabId });
    await runtime.command('tab-select', { tabId: shown });
    expect((await runtime.perform('browser.snapshot', {})).title).toBe('Fixture');

    // When actions name the background tab, then they run there, and it keeps painting so a capture cannot stall.
    const background = await runtime.agentPage(opened.tabId);
    const visibility = await background.cdp.sendSession(background.sessionId, 'Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true });
    expect(visibility.result.value).toBe('visible');
    await runtime.perform('browser.type', { tabId: opened.tabId, selector: '#name', value: 'from the agent', submit: false });
    await runtime.perform('browser.click', { tabId: opened.tabId, selector: '#mark' });
    expect((await runtime.perform('browser.snapshot', { tabId: opened.tabId })).text).toMatch(/from the agent/);
    const capture = await runtime.perform('browser.capture', { tabId: opened.tabId });
    expect(capture.title).toBe('Fixture');
    expect(capture.base64.length > 100).toBe(true);
    await runtime.perform('browser.open', { tabId: opened.tabId, url: `${web.origin}/title` });
    await runtime.perform('browser.back', { tabId: opened.tabId });
    expect((await runtime.perform('browser.snapshot', { tabId: opened.tabId })).title).toBe('Fixture');
    expect(runtime.url).toBe(`${web.origin}/next`);
    expect(runtime.tabs.find((tab) => tab.active).id).toBe(shown);

    // When an id is not one this browser issued, then the action is refused instead of running elsewhere.
    await expect(runtime.perform('browser.click', { tabId: 'missing', selector: '#mark' })).rejects.toThrow(/no tab "missing"/);

    // Then the viewer's page stayed in front and kept streaming the whole time.
    const page = await runtime.ensurePage();
    const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', { expression, returnByValue: true })).result.value;
    expect(await evaluate('document.visibilityState')).toBe('visible');
    const next = runtime.surfaceFrame({ after: before.sequence, wait: 10_000 });
    await evaluate('document.body.style.background = "rgb(10, 120, 200)"');
    expect(await next).toBeTruthy();
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('closes only the tabs the agent opened, and reports each page\'s icon', async () => {
  // Given a browser whose first page the agent opened, a second agent tab, and a tab the person opened.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    const first = await runtime.perform('browser.open', { url: `${web.origin}/next` });
    const second = await runtime.perform('browser.open', { url: `${web.origin}/` });
    await runtime.command('tab-new');
    const personTab = runtime.tabs.find((tab) => tab.id !== first.tabId && tab.id !== second.tabId).id;

    // Then every loaded page reports its site's icon.
    await waitFor(() => runtime.tabs.filter((tab) => tab.url.startsWith(web.origin)).every((tab) => tab.favicon));
    expect(runtime.tabs.find((tab) => tab.id === first.tabId).favicon).toBe(`data:image/png;base64,${FAVICON_PNG.toString('base64')}`);

    // When the agent closes the person's tab, then it is refused and stays open.
    await expect(runtime.perform('browser.close', { tabId: personTab })).rejects.toThrow(/opened by the user/);
    expect(runtime.tabs.some((tab) => tab.id === personTab)).toBe(true);

    // When it closes without naming a tab, then its most recent tab closes; naming one closes that one.
    expect(await runtime.perform('browser.close', {})).toEqual({ closed: true, tabId: second.tabId });
    expect(await runtime.perform('browser.close', { tabId: first.tabId })).toEqual({ closed: true, tabId: first.tabId });
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([personTab]);

    // When no tab of its own is left, then nothing is closed.
    await expect(runtime.perform('browser.close', {})).rejects.toThrow(/no tab the agent opened/);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('streams frames when the viewer\'s first frame request opens the page', async () => {
  // Given a scope with no page yet, like one opened from the dock for a chat.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());

    // When the viewer asks for a frame first and the page then loads, then frames arrive.
    const frame = runtime.surfaceFrame({ after: 0, wait: 10_000 });
    await runtime.perform('browser.open', { url: web.origin });
    expect(await frame).toBeTruthy();
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('sizes pages in CSS pixels for the viewer and keeps a chosen size fixed', async () => {
  // Given a visible scope in a panel measured at twice the CSS pixel density.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtimes = [];
    const manager = createBrowserManager({
      createRuntime: () => {
        const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
        runtimes.push(runtime);
        return runtime;
      },
    });
    cleanups.push(() => manager.close());
    await manager.setDevicePixelRatio(2);
    await expect(manager.surfaceResize({ width: 1400, height: 1000 })).rejects.toThrow(/no browser scope/i);
    await manager.perform('browser.open', { url: `${web.origin}/` }, undefined, { directory: '/repo', sessionId: 'ses_view' });
    const page = await runtimes[0].ensurePage();
    const innerSize = async () => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
      expression: 'JSON.stringify([innerWidth, innerHeight])',
      returnByValue: true,
    })).result.value;

    // Then the page keeps the desktop size: opening the panel does not lay it out again.
    expect(await innerSize()).toBe('[1440,900]');
    expect(manager.state().scopes[0].viewport).toEqual({ mode: 'fixed', source: 'default', width: 1440, height: 900, mobile: false });

    // When the dock fixes a size, then a later panel resize keeps it.
    await manager.setViewport({ mode: 'fixed', width: 500, height: 400, mobile: false }, manager.state().generation);
    await manager.surfaceResize({ width: 1200, height: 800 });
    expect(await innerSize()).toBe('[500,400]');
    expect(manager.state().scopes[0].viewport).toEqual({ mode: 'fixed', source: 'viewer', width: 500, height: 400, mobile: false });

    // When the dock picks Fill, then the page follows the latest panel size.
    await manager.setViewport({ mode: 'auto', mobile: false }, manager.state().generation);
    expect(await innerSize()).toBe('[600,400]');
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('shows the viewer menu only for right clicks the page leaves alone', async () => {
  // Given a page with history, a plain area, and an element with its own menu.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    // Viewer input goes through the manager, as the service sends it.
    let runtime;
    const manager = createBrowserManager({
      createRuntime: () => (runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] })),
    });
    cleanups.push(() => manager.close());
    const chat = { directory: '/repo', sessionId: 'ses_menu' };
    const first = await manager.perform('browser.open', { url: `${web.origin}/next` }, undefined, chat);
    await manager.perform('browser.open', { url: `${web.origin}/menu`, tabId: first.tabId }, undefined, chat);
    const page = await runtime.ensurePage();
    const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
    })).result.value;
    const menuShown = () => evaluate('document.querySelector("openchamber-menu") !== null');
    const pointer = (action, x, y, button, buttons) => ({ type: 'pointer', action, x, y, button, buttons, modifiers });
    const rightClick = (x, y) => manager.surfaceInput([pointer('down', x, y, 2, 2), pointer('up', x, y, 2, 0)]);
    const leftClick = (x, y) => manager.surfaceInput([pointer('down', x, y, 0, 1), pointer('up', x, y, 0, 0)]);

    // When the page handles its own context menu, then the viewer menu stays away.
    await rightClick(30, 320);
    expect(await menuShown()).toBe(false);
    expect(await evaluate('document.title')).toBe('Custom menu');

    // When the page leaves a right click alone, then the menu appears, and Escape closes it without reaching the page.
    await rightClick(30, 30);
    expect(await menuShown()).toBe(true);
    await manager.surfaceInput(['down', 'up'].map((action) => ({ type: 'key', action, key: 'Escape', code: 'Escape', modifiers })));
    expect(await menuShown()).toBe(false);
    expect(await evaluate('window.escapes')).toBe(0);

    // When the user clicks outside the menu, then it closes and the page never sees that click.
    await rightClick(30, 30);
    await leftClick(600, 500);
    expect(await menuShown()).toBe(false);
    expect(await evaluate('window.clicks')).toBe(0);
    expect(await evaluate('typeof window.openchamberMenu')).toBe('undefined');

    // When Copy is chosen with text selected, then the text waits for the dock's toast.
    await evaluate('getSelection().selectAllChildren(document.querySelector("#words"))');
    await rightClick(30, 30);
    await leftClick(60, 142);
    await waitFor(() => runtime.copyRequest?.text === 'Copy these words');

    // When Back is chosen, then the tab goes back.
    await rightClick(30, 30);
    await leftClick(60, 49);
    await waitFor(() => runtime.url === `${web.origin}/next`);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('captures console and network for the inspector and runs JavaScript in the page', async () => {
  // Given a capture on a page that logs and posts when clicked.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/inspect` });
    const { captureId } = await runtime.inspectorStart();

    // When the user clicks, then the console error and the finished request are captured.
    await runtime.surfaceInput([
      { type: 'pointer', action: 'down', x: 30, y: 30, button: 0, buttons: 1, modifiers },
      { type: 'pointer', action: 'up', x: 30, y: 30, button: 0, buttons: 0, modifiers },
    ]);
    const consoleRows = [];
    const networkRows = new Map();
    let cursor = 0;
    await waitFor(() => {
      const batch = runtime.inspector.events(captureId, cursor);
      cursor = batch.cursor;
      consoleRows.push(...batch.console);
      for (const row of batch.network) networkRows.set(row.id, row);
      return consoleRows.some((row) => row.text === 'boom from page' && row.level === 'error')
        && [...networkRows.values()].some((row) => row.url.includes('/api') && row.state === 'complete');
    });
    const api = [...networkRows.values()].find((row) => row.url.includes('/api'));
    expect(api.url).toMatch(/token=%5BREDACTED%5D/);
    expect(runtime.problemCounts.errors).toBe(1);

    // Then its details redact credentials in both bodies.
    const details = await runtime.inspector.request(captureId, api.id, true);
    expect(details.bodyState).toBe('available');
    expect(JSON.parse(details.requestBody)).toEqual({ password: '[REDACTED]', name: 'ada' });
    expect(JSON.parse(details.responseBody)).toEqual({ token: '[REDACTED]', ok: true });

    // When JavaScript runs in the page, then promises resolve and exceptions come back as errors.
    expect(await runtime.inspector.evaluate(captureId, 'await Promise.resolve(document.title)')).toEqual({ text: 'Inspect', truncated: false, isError: false });
    expect((await runtime.inspector.evaluate(captureId, 'missingName')).isError).toBe(true);

    // When the page itself loads another document, then its problems start over, like the DevTools console.
    await runtime.inspector.evaluate(captureId, 'location.href = "/next"');
    await waitFor(() => runtime.url === `${web.origin}/next`);
    expect(runtime.problemCounts).toEqual({ errors: 0, warnings: 0 });

    // When another tab comes forward, then this capture is gone.
    await runtime.command('tab-new');
    let thrown = null;
    try {
      runtime.inspector.events(captureId, cursor);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('CAPTURE_GONE');
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('moves a throwaway chat\'s login into a new profile once the person approves', async () => {
  // Given a chat in an unbound project, signed into a site in its throwaway browser.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-request-'));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const store = createProfileStore({ root: path.join(scratch, 'store'), keyFile: path.join(scratch, 'key', 'profile.key'), workRoot: path.join(scratch, 'run') });
    const manager = createBrowserManager({
      profiles: store,
      createRuntime: (_scope, profile) => createBrowserRuntime({
        chromePath,
        allowedOrigins: [web.origin],
        profile: profile ? { ...profile, checkout: () => store.checkout(profile.id), checkin: (directory, version) => store.checkin(profile.id, directory, version) } : null,
      }),
    });
    cleanups.push(() => manager.close());
    const chat = { directory: scratch, sessionId: 'ses_login' };
    await manager.perform('browser.open', { url: `${web.origin}/login` }, undefined, chat);

    // When the agent asks to keep the login in "Acme" and the person allows it.
    const asked = manager.requestHelp({ reason: 'Keep the fixture login', timeoutSeconds: 60, kind: 'profile', profileName: 'Acme' }, undefined, chat);
    await waitFor(() => manager.state().help?.kind === 'profile');
    manager.answerProfileRequest(true, {});
    const result = await asked;
    expect(result.outcome).toBe('approved');
    expect(result.profileSaved).toBe(true);

    // Then the project is bound to Acme, and another chat of the project starts signed in.
    expect((await store.resolve(scratch))?.name).toBe('Acme');
    const other = { directory: scratch, sessionId: 'ses_other' };
    await manager.perform('browser.open', { url: `${web.origin}/whoami` }, undefined, other);
    expect((await manager.perform('browser.snapshot', {}, undefined, other)).text).toMatch(/cookie present/);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('keeps a profile\'s login and storage across browsers and hides nothing else behind headless', async () => {
  // Given a saved profile and a site that signs in with a lasting cookie and local storage.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-integration-'));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const store = createProfileStore({ root: path.join(scratch, 'store'), keyFile: path.join(scratch, 'key', 'profile.key'), workRoot: path.join(scratch, 'run') });
    const saved = await store.create('Work');
    const profile = { id: saved.id, name: saved.name, checkout: () => store.checkout(saved.id), checkin: (directory, version) => store.checkin(saved.id, directory, version) };

    // When one browser signs in and closes without saving, then the profile is untouched.
    const discarded = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin], profile });
    await discarded.perform('browser.open', { url: `${web.origin}/login` });
    expect(await discarded.close()).toBe(null);
    expect((await store.get(saved.id)).saved).toBe(false);

    // When one browser signs in and closes saving its copy.
    const first = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin], profile });
    await first.perform('browser.open', { url: `${web.origin}/login` });
    expect(await first.close({ save: true })).toBe(1);
    expect(fs.readdirSync(path.join(scratch, 'run'))).toEqual([]);
    expect((await store.get(saved.id)).saved).toBe(true);

    // Then a later browser on the profile is still signed in, and presents itself as ordinary Chrome.
    const second = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin], profile });
    cleanups.push(() => second.close());
    await second.perform('browser.open', { url: `${web.origin}/whoami` });
    const snapshot = await second.perform('browser.snapshot', {});
    expect(snapshot.text).toMatch(/cookie present/);
    expect(snapshot.text).toMatch(/stored ada/);
    expect(snapshot.text).not.toMatch(/HeadlessChrome/);
    expect(snapshot.tabs.length).toBe(1);

    // And a throwaway browser shares none of it.
    const throwaway = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => throwaway.close());
    await throwaway.perform('browser.open', { url: `${web.origin}/whoami` });
    expect((await throwaway.perform('browser.snapshot', {})).text).toMatch(/no cookie/);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

const click = (runtime, x, y) => runtime.surfaceInput([
  { type: 'pointer', action: 'down', x, y, button: 0, buttons: 1, modifiers },
  { type: 'pointer', action: 'up', x, y, button: 0, buttons: 0, modifiers },
]);

const temporaryDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'server-browser-files-'));

test.skipIf(noChrome)('holds a page\'s dialogs for the dock and the agent instead of hanging', async () => {
  // Given a page with confirm, prompt, and two alerts in a row.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/dialogs` });
    const shown = () => runtime.tabs.find((tab) => tab.active);

    // When the person clicks Confirm, then the dialog is held on the tab and the page waits for it.
    await click(runtime, 30, 30);
    await waitFor(() => shown().dialog !== null);
    expect(shown().dialog).toMatchObject({ type: 'confirm', message: 'Delete the draft?' });

    // Then an agent action on the paused tab fails at once, naming the dialog.
    const started = Date.now();
    await expect(runtime.perform('browser.snapshot', {})).rejects.toThrow(/confirm dialog: "Delete the draft\?"/);
    expect(Date.now() - started).toBeLessThan(2_000);

    // When the panel changes size meanwhile, then the resize does not wait on the paused page.
    const resizing = Date.now();
    // The page follows the panel only in Fill.
    await runtime.configureViewport({ mode: 'auto', source: 'viewer', mobile: false });
    await runtime.surfaceResize({ width: 700, height: 500 });
    expect(Date.now() - resizing).toBeLessThan(2_000);
    await expect(runtime.setZoomLevel(1)).rejects.toThrow(/Answer the dialog/);

    // When the dock presses Cancel on that dialog, then the page runs again with the answer and its new size.
    await runtime.answerDialog({ tabId: shown().id, dialogId: shown().dialog.id, accept: false });
    expect(shown().dialog).toBeNull();
    expect((await runtime.perform('browser.snapshot', {})).text).toMatch(/false/);
    const page = await runtime.ensurePage();
    await waitFor(async () => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', { expression: 'innerWidth', returnByValue: true })).result.value === 700);

    // When an agent click opens a prompt, then the click ends at once naming it, and browser.dialog answers it.
    await expect(runtime.perform('browser.click', { selector: '#name' })).rejects.toThrow(/prompt dialog: "Your name\?"/);
    const answered = await runtime.perform('browser.dialog', { accept: true, promptText: 'Grace' });
    expect(answered).toMatchObject({ answered: { type: 'prompt', message: 'Your name?', defaultPrompt: 'Ada' }, accepted: true });
    expect((await runtime.perform('browser.snapshot', {})).text).toMatch(/Grace/);

    // When a page opens two alerts in a row, then the answer to the first reports the second.
    await expect(runtime.perform('browser.click', { selector: '#mark' })).rejects.toThrow(/alert: "first"/);
    const first = await runtime.perform('browser.dialog', { accept: true });
    expect(first.dialog).toEqual({ type: 'alert', message: 'second' });
    const second = await runtime.perform('browser.dialog', { accept: true });
    expect(second.dialog).toBeUndefined();
    expect((await runtime.perform('browser.snapshot', {})).text).toMatch(/alerts done/);

    // Then an answer with no dialog open, or to a dialog that is gone, is refused.
    await expect(runtime.perform('browser.dialog', { accept: true })).rejects.toThrow(/No dialog is open/);
    await expect(runtime.answerDialog({ tabId: shown().id, dialogId: 1, accept: true })).rejects.toThrow(/no longer open/);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('brings a page that opens with an alert to the front at once, and sets it up once answered', async () => {
  // Given a page whose button opens a page that alerts while it loads.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    // The page follows the panel only in Fill.
    await runtime.configureViewport({ mode: 'auto', source: 'viewer', mobile: false });
    await runtime.surfaceResize({ width: 700, height: 500 });
    await runtime.perform('browser.open', { url: `${web.origin}/opens-alert` });

    // When the person opens it, then its tab comes to the front with the alert held, well before any command times out.
    const started = Date.now();
    await click(runtime, 30, 30);
    await waitFor(() => runtime.tabs.some((tab) => tab.active && tab.dialog?.message === 'hello from the popup'));
    expect(Date.now() - started).toBeLessThan(5_000);

    // When the alert is answered, then the page loads at the viewer's size.
    const shown = runtime.tabs.find((tab) => tab.active);
    await runtime.answerDialog({ tabId: shown.id, dialogId: shown.dialog.id, accept: true });
    const page = await runtime.ensurePage();
    await waitFor(async () => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', { expression: 'innerWidth', returnByValue: true })).result.value === 700);
    expect((await runtime.perform('browser.snapshot', {})).text).toMatch(/Loaded/);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('gives a tab paused on a dialog the color scheme it missed once the dialog is answered', async () => {
  // Given a tab paused on a confirm, and a second tab in front.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/dialogs` });
    const paused = runtime.tabs.find((tab) => tab.active);
    await click(runtime, 30, 30);
    await waitFor(() => runtime.tabs.find((tab) => tab.id === paused.id)?.dialog !== null);
    await runtime.command('tab-new');
    await waitFor(() => runtime.tabs.find((tab) => tab.active)?.id !== paused.id);

    // When the person switches to dark while the first tab is paused.
    await runtime.setColorScheme('dark');

    // Then, once its dialog is answered, the paused tab is dark too.
    const dialog = runtime.tabs.find((tab) => tab.id === paused.id).dialog;
    await runtime.answerDialog({ tabId: paused.id, dialogId: dialog.id, accept: true });
    const page = await runtime.ensurePage();
    const sessionId = await page.cdp.attach(paused.id);
    await waitFor(async () => (await page.cdp.sendSession(sessionId, 'Runtime.evaluate', {
      expression: 'matchMedia("(prefers-color-scheme: dark)").matches', returnByValue: true,
    })).result.value === true);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('asks before leaving a page that wants to stay, from the dock or the agent', async () => {
  // Given a page with a beforeunload handler the person has used.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/leave` });
    await click(runtime, 30, 30);
    const shown = () => runtime.tabs.find((tab) => tab.active);

    // When the dock navigates away, then the command returns and the dialog waits on the tab.
    await runtime.command('navigate', { url: `${web.origin}/next` });
    await waitFor(() => shown().dialog !== null);
    expect(shown().dialog.type).toBe('beforeunload');

    // When the dock chooses to stay, then the page stays.
    await runtime.answerDialog({ tabId: shown().id, dialogId: shown().dialog.id, accept: false });
    expect(runtime.url).toBe(`${web.origin}/leave`);

    // When the agent opens another page in that tab, then it is told about the dialog and leaves with browser.dialog.
    await expect(runtime.perform('browser.open', { tabId: shown().id, url: `${web.origin}/next` })).rejects.toThrow(/"leave this page\?" dialog/);
    await runtime.perform('browser.dialog', { accept: true });
    await waitFor(() => runtime.url === `${web.origin}/next`);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('hands the files a person picked to the page and refuses names outside the request', async () => {
  // Given a page with a file input and a folder for uploads.
  const web = await startWebFixture();
  const files = temporaryDirectory();
  const cleanups = [() => close(web.server), () => fs.promises.rm(files, { recursive: true, force: true })];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin], uploadsDirectory: path.join(files, 'uploads') });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/files` });
    const shown = () => runtime.tabs.find((tab) => tab.active);

    // When the person clicks the file input, then the request is held with what it accepts and where to put files.
    await click(runtime, 30, 30);
    await waitFor(() => shown().fileChooser !== null);
    const chooser = shown().fileChooser;
    expect(chooser).toMatchObject({ multiple: true, accept: '.txt' });
    expect(fs.readFileSync(path.join(files, 'uploads', '.gitignore'), 'utf8')).toBe('*\n');

    // Then a name that is not a file in the request's folder is refused.
    await expect(runtime.answerFileChooser({ tabId: shown().id, chooserId: chooser.id, files: ['../escape.txt'] })).rejects.toThrow(/plain names/);
    await expect(runtime.answerFileChooser({ tabId: shown().id, chooserId: chooser.id, files: ['missing.txt'] })).rejects.toThrow(/was not uploaded/);

    // When the files are in the folder and the dock answers, then the page reads them.
    fs.writeFileSync(path.join(chooser.directory, 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(chooser.directory, 'more.txt'), 'world');
    await runtime.answerFileChooser({ tabId: shown().id, chooserId: chooser.id, files: ['notes.txt', 'more.txt'] });
    expect(shown().fileChooser).toBeNull();
    await waitFor(async () => /notes\.txt=hello,more\.txt=world/.test((await runtime.perform('browser.snapshot', {})).text));

    // When the person opens the chooser again and cancels, then the page gets nothing and the request ends.
    await click(runtime, 30, 30);
    await waitFor(() => shown().fileChooser !== null);
    const second = shown().fileChooser;
    await runtime.answerFileChooser({ tabId: shown().id, chooserId: second.id, files: null });
    expect(shown().fileChooser).toBeNull();
    expect(fs.existsSync(second.directory)).toBe(false);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('keeps what pages download under the site\'s name and tells the agent where', async () => {
  // Given a page with a download link and a downloads folder.
  const web = await startWebFixture();
  const files = temporaryDirectory();
  const cleanups = [() => close(web.server), () => fs.promises.rm(files, { recursive: true, force: true })];
  try {
    const downloadsDirectory = path.join(files, 'downloads');
    fs.mkdirSync(downloadsDirectory);
    fs.writeFileSync(path.join(downloadsDirectory, 'report.csv'), 'older');
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin], downloadsDirectory });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/downloads` });

    // When the link is clicked, then the file lands beside the older one without replacing it.
    await runtime.perform('browser.click', { selector: '#surface' });
    await waitFor(() => runtime.downloads[0]?.state === 'complete');
    const [download] = runtime.downloads;
    expect(download).toMatchObject({ name: 'report (1).csv', url: `${web.origin}/report`, receivedBytes: 8 });
    expect(fs.readFileSync(download.path, 'utf8')).toBe('a,b\n1,2\n');
    expect(fs.readFileSync(path.join(downloadsDirectory, 'report.csv'), 'utf8')).toBe('older');
    expect(fs.readFileSync(path.join(downloadsDirectory, '.gitignore'), 'utf8')).toBe('*\n');
    expect(fs.readdirSync(path.join(downloadsDirectory, '.partial'))).toEqual([]);

    // Then a snapshot tells the agent where the file is.
    const snapshot = await runtime.perform('browser.snapshot', {});
    expect(snapshot.downloads).toEqual([expect.objectContaining({ name: 'report (1).csv', path: download.path, state: 'complete' })]);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('streams the sound of the tab in front only while asked, and pages cannot capture their own tab', async () => {
  // Given a page that plays a tone once clicked.
  const web = await startWebFixture();
  const cleanups = [() => close(web.server)];
  try {
    const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
    cleanups.push(() => runtime.close());
    await runtime.perform('browser.open', { url: `${web.origin}/tone` });
    await click(runtime, 30, 30);

    // The page follows the panel only in Fill.
    await runtime.configureViewport({ mode: 'auto', source: 'viewer', mobile: false });
    await runtime.surfaceResize({ width: 640, height: 480 });
    // The picture shown before the resize; what comes after it is what counts.
    const shown = await runtime.surfaceFrame({ after: 0, wait: 0 });

    // When a viewer asks for sound, then Opus packets of the tab arrive, length-prefixed.
    const batch = await runtime.surfaceAudio({ after: runtime.audioHead, wait: 10_000 });
    expect(batch).toMatchObject({ codec: 'opus', channels: 2 });
    expect([44_100, 48_000]).toContain(batch.sampleRate);
    let offset = 0;
    let count = 0;
    while (offset < batch.bytes.length) {
      const length = batch.bytes.readUInt16BE(offset);
      expect(length).toBeGreaterThan(0);
      offset += 2 + length;
      count += 1;
    }
    expect(offset).toBe(batch.bytes.length);
    expect(count).toBeGreaterThan(0);

    // Then the picture keeps the viewport's size while the tab is captured
    // (Chrome's sharing bar shrinks the real view under the emulated one).
    const pictureSize = (bytes) => {
      for (let at = 2; at + 9 < bytes.length; at += 2 + bytes.readUInt16BE(at + 2)) {
        if (bytes[at + 1] >= 0xc0 && bytes[at + 1] <= 0xc3) return `${bytes.readUInt16BE(at + 7)}x${bytes.readUInt16BE(at + 5)}`;
      }
      return null;
    };
    const sizes = new Set();
    let after = shown?.sequence ?? 0;
    for (const deadline = Date.now() + 2_000; Date.now() < deadline;) {
      const frame = await runtime.surfaceFrame({ after, wait: 1_000 });
      if (!frame) continue;
      after = frame.sequence;
      sizes.add(`${frame.width}x${frame.height} ${pictureSize(frame.bytes)}`);
    }
    expect([...sizes]).toEqual(['640x480 640x480']);

    // Then the page, and a frame in it, cannot capture the tab themselves.
    const page = await runtime.ensurePage();
    const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result.value;
    expect(await evaluate('window.selfCapture()')).toBe('NotAllowedError');
    expect(await evaluate('document.querySelector("#frame").contentWindow.selfCapture()')).toBe('NotAllowedError');
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});

test.skipIf(noChrome)('tells a command Chrome refused from one it did not answer in time, or a closed connection', async () => {
  // Given a connection to Chrome with a short command timeout.
  const chrome = createChromeProcess({ chromePath });
  const running = await chrome.ensure();
  const cdp = await connectCdp(running.endpoint, { commandTimeoutMs: 500 });
  try {
    // When Chrome answers with an error, then the error says Chrome refused.
    await expect(cdp.send('Target.closeTarget', { targetId: 'no-such-target' })).rejects.toMatchObject({ code: 'protocol' });

    // When Chrome gives no answer in time, then the error says so instead: Chrome may still carry it out.
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const sessionId = await cdp.attach(targetId);
    await expect(cdp.sendSession(sessionId, 'Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true }))
      .rejects.toMatchObject({ code: 'timeout' });

    // When the connection is gone, then that is what the error says.
    cdp.close();
    await expect(cdp.send('Browser.getVersion')).rejects.toMatchObject({ code: 'closed' });
  } finally {
    cdp.close();
    await chrome.close();
  }
});

test.skipIf(notLinuxChrome)('runs Chrome headless so it never opens a desktop window', async () => {
  const chrome = createChromeProcess({ chromePath });
  const running = await chrome.ensure();
  try {
    // Chrome rewrites its own command line into one space-separated string.
    const commandLine = fs.readFileSync(`/proc/${running.process.pid}/cmdline`, 'utf8').split(/[\0 ]/);
    expect(commandLine.includes('--headless=new')).toBe(true);
    expect(commandLine.includes('--ozone-platform=headless')).toBe(true);
  } finally {
    await chrome.close();
  }
});
