import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, wait } from './cdp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function createQuotePopoverFixture() {
  const { createServer } = await import('vite');
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/chat-quote-popover-'));
  writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { ChatQuoteMarkPopover } from '@/components/chat/message/ChatQuoteMarkPopover';
    import { I18nContext } from '@/lib/i18n/react-context';
    import { dict } from '@/lib/i18n/messages/en';
    import '@/index.css';

    const root = createRoot(document.getElementById('root'));
    const i18n = { locale: 'en', direction: 'ltr', locales: ['en'], setLocale() {}, label: locale => locale, t: key => dict[key] };
    function SavedQuote({ left }) {
      const [comment, setComment] = React.useState('Short');
      const [editing, setEditing] = React.useState(false);
      return <I18nContext.Provider value={i18n}><ChatQuoteMarkPopover
        anchorRect={new DOMRect(left, 250, 16, 20)} comment={comment} editing={editing}
        onEditingChange={setEditing} onSave={setComment} onRemove={() => {}}
      /></I18nContext.Provider>;
    }
    let revision = 0;
    window.renderSavedQuote = (left, direction) => {
      document.documentElement.dir = direction;
      flushSync(() => root.render(<SavedQuote key={++revision} left={left} />));
    };
  `);
  const server = await createServer({
    configFile: false, root: fixture, logLevel: 'error',
    // Concurrent browser suites must not invalidate each other's optimized deps.
    cacheDir: path.join(fixture, '.vite'),
    css: { postcss: repo },
    resolve: { alias: { '@': path.join(repo, 'packages/ui/src'), '@openchamber/sdk': path.join(repo, 'packages/sdk/src/index.ts') } },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'clsx', 'tailwind-merge'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo, fixture] } },
  });
  try {
    await server.listen();
  } catch (error) {
    await server.close();
    rmSync(fixture, { recursive: true, force: true });
    throw error;
  }
  return {
    url: server.resolvedUrls.local[0], fixture,
    async close() {
      await server.close();
      rmSync(fixture, { recursive: true, force: true });
    },
  };
}

async function assertQuotePopoverBounds(client, url) {
  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result.value;
  };
  const until = async (expression) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await wait(25);
    }
    assert.fail(`Timed out waiting for ${expression}`);
  };
  const click = async (selector) => {
    const point = await evaluate(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const assertFits = async (state) => {
    const box = await evaluate(`(() => {
      const popup = document.querySelector('.fixed');
      const rect = popup.getBoundingClientRect();
      const controls = [...popup.querySelectorAll('button, textarea')].map(el => {
        const r = el.getBoundingClientRect(); return { left: r.left, right: r.right };
      });
      return { left: rect.left, right: rect.right, viewport: innerWidth, controls };
    })()`);
    assert.ok(box.left >= 11.9 && box.right <= box.viewport - 11.9, `${state}: ${JSON.stringify(box)}`);
    assert.ok(box.controls.every(control => control.left >= box.left && control.right <= box.right + 0.1), `${state}: a control is clipped`);
  };
  await client.send('Page.enable');
  await client.send('Page.navigate', { url });
  await until(`location.href === ${JSON.stringify(url)} && typeof window.renderSavedQuote === "function"`);
  for (const width of [320, 390, 1024]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    for (const direction of ['ltr', 'rtl']) {
      for (const left of [12, width - 28]) {
        await evaluate(`window.renderSavedQuote(${left}, ${JSON.stringify(direction)})`);
        await until(`!!document.querySelector('button[title="Edit comment"]')`);
        await assertFits(`${width}px ${direction} saved preview`);
        for (let edit = 0; edit < 2; edit++) {
          await click('button[title="Edit comment"]');
          await until('document.querySelector("textarea")?.value === "Short"');
          await assertFits(`${width}px ${direction} edit ${edit + 1}`);
          await click('button[title="Save comment"]');
          await until(`!!document.querySelector('button[title="Edit comment"]')`);
          await assertFits(`${width}px ${direction} saved edit ${edit + 1}`);
        }
      }
    }
  }
}

let chrome;
try {
  chrome = resolveChrome(process.env.OPENCHAMBER_TEST_CHROME);
} catch (error) {
  if (process.env.OPENCHAMBER_TEST_CHROME) throw error;
}
test('saved quote comments stay on screen through repeated editing', {
  skip: !chrome && 'Set OPENCHAMBER_TEST_CHROME to run the browser regression', timeout: 120_000,
}, async () => {
  const fixture = await createQuotePopoverFixture();
  let browser;
  let client;
  try {
    const port = await reservePort();
    browser = launchChrome({ chrome, port, profileDir: path.join(fixture.fixture, 'profile'), headless: true, extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const target = await createPageTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await assertQuotePopoverBounds(client, fixture.url);
  } finally {
    client?.close();
    if (browser && browser.exitCode === null) {
      const exited = once(browser, 'exit');
      browser.kill('SIGTERM');
      await Promise.race([exited, wait(3_000)]);
      if (browser.exitCode === null) browser.kill('SIGKILL');
    }
    await fixture.close();
  }
});
