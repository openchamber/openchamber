import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, wait } from './cdp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let chrome;
try {
  chrome = resolveChrome(process.env.OPENCHAMBER_TEST_CHROME);
} catch (error) {
  if (process.env.OPENCHAMBER_TEST_CHROME) throw error;
}

// Real CSS layout catches the unbounded viewport that happy-dom cannot measure.
test('JSON tree stays bounded and its tail remains reachable', { skip: !chrome && 'Set OPENCHAMBER_TEST_CHROME to run the browser regression', timeout: 120_000 }, async (t) => {
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/json-tree-'));
  writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><body><div id="host" style="height:520px;width:320px;overflow:auto"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { JsonTreeView } from '@/components/ui/JsonTreeView';
    import { I18nContext } from '@/lib/i18n/react-context';
    import { dict } from '@/lib/i18n/messages/en';
    import '@/index.css';

    const host = document.getElementById('host');
    const root = createRoot(host);
    const i18n = { locale: 'en', direction: 'ltr', locales: ['en'], setLocale() {}, label: locale => locale, t: key => dict[key] };
    let revision = 0;
    function renderFixture(count, maxHeight = '100%', fill = true) {
      host.style.height = fill ? '520px' : 'auto';
      const data = Array.from({ length: count }, (_, i) => 'item-' + i + ' ' + 'x'.repeat(90));
      root.render(<I18nContext.Provider value={i18n}><JsonTreeView key={++revision} className={fill ? 'h-full' : undefined} jsonString={JSON.stringify(data)} maxHeight={maxHeight} /></I18nContext.Provider>);
    }
    Object.assign(window, { renderFixture });
  `);

  const server = await createServer({
    configFile: false,
    root: fixture,
    logLevel: 'error',
    css: { postcss: repo },
    resolve: { alias: { '@': path.join(repo, 'packages/ui/src'), '@openchamber/sdk': path.join(repo, 'packages/sdk/src/index.ts') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo, fixture] } },
  });
  let browser;
  let client;
  try {
    await server.listen();
    const port = await reservePort();
    browser = launchChrome({ chrome, port, profileDir: path.join(fixture, 'profile'), headless: true, extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const target = await createPageTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    let navigations = 0;
    client.on('Page.frameNavigated', ({ frame }) => {
      if (!frame.parentId) navigations += 1;
    });
    await client.send('Page.bringToFront');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await client.send('Page.navigate', { url: server.resolvedUrls.local[0] });

    const evaluate = async (expression) => {
      const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, { timeoutMs: 20_000 });
      assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
      return result.result.value;
    };
    const fixtureReady = () => evaluate(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 15_000;
      const check = () => {
        if (window.renderFixture) resolve();
        else if (performance.now() > deadline) reject(new Error('Fixture did not load'));
        else requestAnimationFrame(check);
      };
      check();
    })`);
    // A reload can land while the page is being waited on; wait again then.
    const waitForFixture = async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await fixtureReady();
        } catch (error) {
          if (attempt >= 5 || !/navigated|destroyed/i.test(String(error?.message))) throw error;
          await wait(500);
        }
      }
    };
    await waitForFixture();
    // The first render pulls in modules the dev server had not seen yet, and
    // Vite's dependency optimizer may reload the page once for them, taking
    // `renderFixture` away mid-test. Render once and wait until a render
    // passes without a reload before measuring anything.
    for (let attempt = 0; ; attempt += 1) {
      const before = navigations;
      await evaluate('window.renderFixture(300)').catch(() => {});
      await wait(1_500);
      if (navigations === before) break;
      assert.ok(attempt < 3, 'the fixture page kept reloading');
      await waitForFixture();
    }

    const settle = () => evaluate(`new Promise(resolve => {
      let frames = 0;
      const check = () => ++frames === 5 ? resolve() : requestAnimationFrame(check);
      requestAnimationFrame(check);
    })`);
    const metrics = () => evaluate(`(() => {
      const host = document.getElementById('host');
      const scroller = host.querySelector('[dir="ltr"]');
      const hostBox = host.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      return { height: scroller.clientHeight, scrollHeight: scroller.scrollHeight, rows: scroller.querySelectorAll('div.whitespace-nowrap').length, fits: box.top >= hostBox.top && box.bottom <= hostBox.bottom + 1, toolbarVisible: [...host.querySelectorAll('button')].filter(b => /All/.test(b.textContent)).every(b => { const r = b.getBoundingClientRect(); return r.top >= hostBox.top && r.bottom <= hostBox.bottom; }) };
    })()`);
    // The virtualizer measures rows as they mount, so the true end can move
    // for a few frames after the first jump; scroll to it again until the last
    // row shows or the attempts run out.
    const assertTail = async (count) => {
      let visible = false;
      for (let attempt = 0; attempt < 20 && !visible; attempt += 1) {
        await evaluate(`document.querySelector('#host [dir="ltr"]').scrollTop = 1e8`);
        await settle();
        visible = await evaluate(`(() => {
          const scroller = document.querySelector('#host [dir="ltr"]');
          const row = [...scroller.querySelectorAll('div.whitespace-nowrap')].find(e => e.textContent.includes('item-${count - 1} '));
          if (!row) return false;
          const box = scroller.getBoundingClientRect(), tail = row.getBoundingClientRect();
          return tail.top >= box.top && tail.bottom <= box.bottom;
        })()`);
      }
      assert.equal(visible, true, `item ${count - 1} must be visible at the scroll end`);
    };

    for (const count of [197, 198, 199, 26_000]) {
      await t.test(`${count} entries at phone width`, async () => {
        await evaluate(`window.renderFixture(${count})`);
        await settle();
        const initial = await metrics();
        assert.ok(initial.height > 0 && initial.height < 520, JSON.stringify(initial));
        assert.equal(initial.fits, true, 'the tree must fit below its toolbar');
        assert.equal(initial.toolbarVisible, true);
        if (count >= 199) assert.ok(initial.rows < 200, `mounted ${initial.rows} rows`);
        await assertTail(count);
      });
    }

    await t.test('collapse, expand, resize and visibility keep the large tree bounded', async () => {
      await evaluate(`[...document.querySelectorAll('#host button')].find(b => b.textContent.includes('Collapse All')).click()`);
      await settle();
      assert.equal((await metrics()).rows, 1);
      await evaluate(`(() => {
        const button = [...document.querySelectorAll('#host button')].find(b => b.textContent.includes('Expand All'));
        button.focus();
        button.click();
      })()`);
      await settle();
      assert.ok((await metrics()).rows < 200);
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate(`document.getElementById('host').style.height = '300px'`);
      await settle();
      const resized = await metrics();
      assert.ok(resized.height > 0 && resized.height < 300, JSON.stringify(resized));
      assert.equal(resized.fits, true);
      assert.equal(resized.toolbarVisible, true);
      assert.ok(resized.rows < 200);
      assert.equal(await evaluate(`document.activeElement.textContent.includes('Expand All')`), true);
      await assertTail(26_000);
      await evaluate(`document.getElementById('host').style.display = 'none'`);
      await settle();
      await evaluate(`document.getElementById('host').style.display = ''`);
      await settle();
      assert.equal((await metrics()).fits, true);
      assert.ok((await metrics()).rows < 200);
      await assertTail(26_000);
    });

    for (const [maxHeight, cap] of [['400px', 400], ['70vh', 630]]) {
      await t.test(`chat's ${maxHeight} cap stays bounded in an auto-height host`, async () => {
        await evaluate(`window.renderFixture(1000, ${JSON.stringify(maxHeight)}, false)`);
        await settle();
        const current = await metrics();
        assert.ok(current.height > 0 && current.height <= cap, JSON.stringify(current));
        assert.ok(current.rows < 200, `mounted ${current.rows} rows`);
        await assertTail(1000);
      });
    }
  } finally {
    // Bounded teardown: a failing subtest must not leave Chrome or the dev
    // server holding the process open until the runner kills it.
    const within = (promise, milliseconds) => Promise.race([promise, wait(milliseconds)]);
    client?.close();
    if (browser && browser.exitCode === null) {
      const exited = once(browser, 'exit');
      browser.kill('SIGTERM');
      await within(exited, 3_000);
      if (browser.exitCode === null) browser.kill('SIGKILL');
    }
    await within(server.close(), 3_000);
    rmSync(fixture, { recursive: true, force: true });
  }
});
