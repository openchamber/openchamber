import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, wait } from './cdp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * A page an agent drew puts a `border` on its pictures, and the `width: 100%`
 * it gives them then resolved to the column width, so the border hung 2px
 * past the frame on each side of a row's last picture. An embedded frame
 * reaches the same place with no styling of the agent's own, through its user
 * agent border. That was enough scroll for a page that otherwise fits to carry
 * a horizontal scrollbar, in the chat and in full screen alike. The base
 * stylesheet sizes media border-box now; this runs the real document builder
 * in a browser and reads whether the page can scroll sideways.
 */

async function createPageFitFixture() {
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/html-render-page-fit-'));
  writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/fixture.ts"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.ts'), `
    import { buildHtmlRenderDocument } from '@/components/chat/message/parts/htmlRender';

    const theme = { appearance: 'light', variables: { '--background': '#fff' } };
    const IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='616' height='900'%3E%3C/svg%3E";
    const COLUMN = '<div class="col"><img src="' + IMAGE + '"></div>';
    const borderedPictures = '<!doctype html><style>'
      + '.row{display:flex;gap:17px}.col{flex:1 1 190px}'
      + 'img{width:100%;display:block;border:1px solid #000}'
      + 'iframe.bare{width:100%;display:block;height:120px}'
      + '</style><div class="row">' + COLUMN + COLUMN + COLUMN + '</div>'
      + '<iframe class="bare"></iframe>';
    const wideBlock = '<!doctype html><div style="width:1200px">wide</div>';

    Object.assign(window, { borderedPictures, wideBlock });

    (window as unknown as {
      measurePage: (html: string, width: number) => Promise<{ clientWidth: number; scrollWidth: number }>;
    }).measurePage = (html, width) => new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'border:0;height:400px;width:' + width + 'px';
      frame.srcdoc = buildHtmlRenderDocument(html, theme as never, {});
      frame.onload = () => requestAnimationFrame(() => requestAnimationFrame(() => {
        const root = frame.contentDocument && frame.contentDocument.documentElement;
        if (!root) { reject(new Error('the frame has no document')); return; }
        resolve({ clientWidth: root.clientWidth, scrollWidth: root.scrollWidth });
        frame.remove();
      }));
      document.body.append(frame);
    });
  `);
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false, root: fixture, logLevel: 'error',
    cacheDir: path.join(fixture, '.vite'),
    css: { postcss: repo },
    resolve: { alias: { '@': path.join(repo, 'packages/ui/src'), '@openchamber/sdk': path.join(repo, 'packages/sdk/src/index.ts') } },
    optimizeDeps: { noDiscovery: true, include: ['zod'] },
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

async function assertPageFits(client, url) {
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
  const measure = (html, width) => evaluate(`window.measurePage(${JSON.stringify(html)}, ${width})`);

  await client.send('Page.enable');
  await client.send('Page.navigate', { url });
  await until('typeof window.measurePage === "function"');

  const bordered = await evaluate('borderedPictures');
  for (const width of [420, 720, 960]) {
    const page = await measure(bordered, width);
    assert.equal(page.scrollWidth, page.clientWidth, `a bordered picture at ${width}px: ${JSON.stringify(page)}`);
  }

  const wide = await evaluate('wideBlock');
  const scrollable = await measure(wide, 720);
  assert.ok(scrollable.scrollWidth > scrollable.clientWidth, `a wide page still scrolls: ${JSON.stringify(scrollable)}`);
}

let chrome;
try {
  chrome = resolveChrome(process.env.OPENCHAMBER_TEST_CHROME);
} catch (error) {
  if (process.env.OPENCHAMBER_TEST_CHROME) throw error;
}
test('bordered pictures and a bare embedded frame stay inside the frame; a wide page still scrolls', {
  skip: !chrome && 'Set OPENCHAMBER_TEST_CHROME to run the browser regression', timeout: 120_000,
}, async () => {
  const fixture = await createPageFitFixture();
  let browser;
  let client;
  try {
    const port = await reservePort();
    browser = launchChrome({ chrome, port, profileDir: path.join(fixture.fixture, 'profile'), headless: true, extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const target = await createPageTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await assertPageFits(client, fixture.url);
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
