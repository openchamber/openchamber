import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, wait } from './cdp.mjs';
import { createFixtureDir, serveFixture } from './fixture-page.mjs';

let chrome;
try {
  chrome = resolveChrome(process.env.OPENCHAMBER_TEST_CHROME);
} catch (error) {
  if (process.env.OPENCHAMBER_TEST_CHROME) throw error;
}

test('chat Markdown tables expand into spare transcript width and show hidden-edge fades', {
  skip: !chrome && 'Set OPENCHAMBER_TEST_CHROME to run this browser regression',
  timeout: 120_000,
}, async () => {
  const fixture = createFixtureDir('markdown-table');
  writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><body><div id="app"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), String.raw`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { MarkdownTable } from '@/components/chat/markdown/MarkdownTable';
    import { MarkdownPresentationContext } from '@/components/chat/markdown/MarkdownPresentationContext';
    import { ChatTranscriptContext } from '@/components/chat/column/ChatTranscriptContext';
    import { I18nContext } from '@/lib/i18n/react-context';
    import { dict } from '@/lib/i18n/messages/en';
    import '@/index.css';

    const headings = Array.from({ length: 12 }, (_, i) => 'Descriptive column ' + (i + 1));
    const values = Array.from({ length: 12 }, (_, i) => 'Entry ' + (i + 1) + ' in the table');
    const makeNode = () => ({ type: 'element', tagName: 'table', properties: {}, children: [] });
    const nodes = [makeNode(), makeNode(), makeNode(), makeNode(), makeNode()];
    const i18n = { locale: 'en', direction: 'ltr', locales: ['en'], setLocale() {}, label: x => x, t: key => dict[key] ?? key };
    const presentation = { settled: true, chatTableExpansion: true, tableWidthScope: undefined };
    const root = createRoot(document.getElementById('app'));

    function Table({ node, dir }) {
      return <MarkdownTable node={node} dir={dir}>
        <thead><tr>{headings.map((text, i) => <th key={i}>{text}</th>)}</tr></thead>
        <tbody><tr>{values.map((text, i) => <td key={i}>{text}</td>)}</tr></tbody>
      </MarkdownTable>;
    }

    function renderFixture(dir = 'ltr', width = 1150, tableDir = undefined) {
      flushSync(() => root.render(
        <I18nContext.Provider value={i18n}>
          <MarkdownPresentationContext.Provider value={presentation}>
            <div id="viewport" dir={dir} data-scrollbar="chat" style={{ width, height: 620, padding: 16, overflow: 'auto', border: '1px solid gray', boxSizing: 'border-box' }}>
              <ChatTranscriptContext.Provider value={true}>
                <div data-message-id="answer">
                  <div className="chat-message-column">
                    <div className="message-content-text leading-relaxed overflow-hidden">
                      <div className="markdown-content">
                        <p id="prose">Text before the wide table must keep its width.</p>
                        <div id="main"><Table node={nodes[0]} dir={tableDir} /></div>
                        <div id="sibling"><Table node={nodes[1]} /></div>
                        <blockquote id="quote"><Table node={nodes[2]} /></blockquote>
                        <ul><li id="list-item"><Table node={nodes[3]} /></li></ul>
                        <details id="disclosure" open><summary>More</summary><Table node={nodes[4]} /></details>
                      </div>
                    </div>
                  </div>
                </div>
              </ChatTranscriptContext.Provider>
            </div>
          </MarkdownPresentationContext.Provider>
        </I18nContext.Provider>
      ));
    }
    Object.assign(window, { renderFixture });
  `);

  const server = await serveFixture({ root: fixture });
  let browser;
  let client;
  try {
    const port = await reservePort();
    browser = launchChrome({ chrome, port, profileDir: path.join(fixture, 'profile'), headless: true, extraArgs: ['--disable-dev-shm-usage'] });
    const target = await createPageTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Page.bringToFront');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await client.send('Page.navigate', { url: server.url });

    const evaluate = async (expression) => {
      const response = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, { timeoutMs: 30_000 });
      assert.equal(response.exceptionDetails, undefined, response.exceptionDetails?.exception?.description);
      return response.result.value;
    };
    const settle = () => evaluate(`new Promise(resolve => {
      let frames = 0;
      const tick = () => ++frames >= 5 ? resolve(true) : requestAnimationFrame(tick);
      requestAnimationFrame(tick);
    })`);
    const waitReady = () => evaluate(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 20000;
      const poll = () => {
        if (window.renderFixture) resolve(true);
        else if (performance.now() > deadline) reject(new Error('Fixture not ready'));
        else requestAnimationFrame(poll);
      };
      poll();
    })`);
    const metrics = () => evaluate(`(() => {
      const table = document.querySelector('#main [data-streamdown="table-wrapper"]');
      const other = document.querySelector('#sibling [data-streamdown="table-wrapper"]');
      const viewport = document.querySelector('#viewport');
      const overlay = table?.querySelector('.overlay-scrollbar-wrapper');
      const scroller = table?.querySelector('.overlay-scrollbar-container');
      const bounds = el => {
        const r = el?.getBoundingClientRect();
        return r ? { left: r.left, right: r.right, width: r.width } : null;
      };
      return {
        viewport: bounds(viewport),
        wrapper: bounds(table),
        overlay: bounds(overlay),
        toolbar: bounds(table?.querySelector('[data-streamdown="table-controls"]')),
        prose: bounds(document.querySelector('#prose')),
        expanded: table?.dataset.tableExpanded ?? null,
        start: table?.dataset.tableOverflowStart ?? null,
        end: table?.dataset.tableOverflowEnd ?? null,
        scrollWidth: scroller?.scrollWidth ?? 0,
        clientWidth: scroller?.clientWidth ?? 0,
        toggle: Boolean(table?.querySelector('[data-table-width-toggle]')),
        siblingExpanded: other?.dataset.tableExpanded ?? null,
        quoteToggle: Boolean(document.querySelector('#quote [data-table-width-toggle]')),
        listToggle: Boolean(document.querySelector('#list-item [data-table-width-toggle]')),
        disclosureToggle: Boolean(document.querySelector('#disclosure [data-table-width-toggle]')),
        listItem: bounds(document.querySelector('#list-item')),
        listTable: bounds(document.querySelector('#list-item [data-streamdown="table-wrapper"]')),
        disclosure: bounds(document.querySelector('#disclosure')),
        disclosureTable: bounds(document.querySelector('#disclosure [data-streamdown="table-wrapper"]')),
        fadeEnd: getComputedStyle(overlay, '::after').content,
      };
    })()`);

    // A first Vite dependency scan can reload the page. Retry the fixture after it settles.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await waitReady();
      await evaluate('window.renderFixture()');
      await wait(1200);
      if (await evaluate('Boolean(document.querySelector("#main [data-table-width-toggle]"))')) break;
      assert.notEqual(attempt, 3, 'wide table never mounted with its expansion control');
    }
    await settle();

    const collapsed = await metrics();
    assert.equal(collapsed.toggle, true, JSON.stringify(collapsed));
    assert.equal(collapsed.quoteToggle, false, 'quoted tables stay within their block');
    assert.equal(collapsed.listToggle, false, 'a table in a list item stays within its item');
    assert.equal(collapsed.disclosureToggle, false, 'a table in a disclosure stays within it');
    assert.ok(collapsed.listTable.left >= collapsed.listItem.left - 1 && collapsed.listTable.right <= collapsed.listItem.right + 1, JSON.stringify(collapsed));
    assert.ok(collapsed.disclosureTable.left >= collapsed.disclosure.left - 1 && collapsed.disclosureTable.right <= collapsed.disclosure.right + 1, JSON.stringify(collapsed));
    assert.equal(collapsed.expanded, null);
    assert.equal(collapsed.start, null);
    assert.equal(collapsed.end, 'true', 'a clipped table shows an end fade');
    assert.equal(collapsed.fadeEnd, '""', 'the end fade is painted');
    assert.ok(collapsed.overlay.width < collapsed.viewport.width - 100, JSON.stringify(collapsed));
    assert.ok(collapsed.scrollWidth > collapsed.clientWidth + 150);

    await evaluate('document.querySelector("#main [data-table-width-toggle]").click()');
    await settle();
    const expanded = await metrics();
    assert.equal(expanded.expanded, 'true', JSON.stringify(expanded));
    assert.ok(expanded.overlay.width > collapsed.overlay.width + 150, JSON.stringify(expanded));
    assert.ok(expanded.overlay.left >= expanded.viewport.left - 1, 'expanded table stays inside the panel start');
    assert.ok(expanded.overlay.right <= expanded.viewport.right + 1, 'expanded table stays inside the panel end');
    assert.equal(expanded.toolbar.width, collapsed.toolbar.width, 'controls stay aligned with message text');
    assert.equal(expanded.prose.width, collapsed.prose.width, 'prose keeps its original measure');
    assert.equal(expanded.siblingExpanded, null, 'expanding one table leaves siblings collapsed');
    assert.equal(expanded.end, 'true', 'the wide table still shows a fade if columns remain hidden ' + JSON.stringify(expanded));

    await evaluate(`(() => {
      const scroller = document.querySelector('#main .overlay-scrollbar-container');
      scroller.scrollLeft = scroller.scrollWidth;
    })()`);
    await settle();
    const scrolled = await metrics();
    assert.equal(scrolled.start, 'true', 'scrolling reveals the start fade');
    assert.equal(scrolled.end, null, 'the end fade vanishes when the last column is visible');

    await evaluate('document.querySelector("#main [data-table-width-toggle]").click()');
    await settle();
    const restored = await metrics();
    assert.equal(restored.expanded, null);
    assert.ok(Math.abs(restored.overlay.width - collapsed.overlay.width) < 2, 'collapse restores message width');

    await evaluate('window.renderFixture("rtl")');
    await settle();
    const rtl = await metrics();
    assert.equal(rtl.toggle, true);
    await evaluate('document.querySelector("#main [data-table-width-toggle]").click()');
    await settle();
    const rtlExpanded = await metrics();
    assert.equal(rtlExpanded.expanded, 'true');
    assert.ok(rtlExpanded.overlay.left >= rtlExpanded.viewport.left - 1, 'RTL expanded table stays inside the panel');
    assert.ok(rtlExpanded.overlay.right <= rtlExpanded.viewport.right + 1, 'RTL expanded table stays inside the panel');
    assert.equal(rtlExpanded.prose.width, rtl.prose.width);

    // A right-to-left table grows from its own start edge; the frame must still
    // land inside the panel, in an LTR and in an RTL chat.
    const scrollMain = (to) => evaluate(`(() => {
      const scroller = document.querySelector('#main .overlay-scrollbar-container');
      scroller.scrollLeft = ${to === 'end' ? '-scroller.scrollWidth' : '0'};
    })()`);
    for (const chatDir of ['ltr', 'rtl']) {
      await evaluate(`window.renderFixture(${JSON.stringify(chatDir)}, 1150, 'rtl')`);
      await settle();
      const rtlTable = await metrics();
      assert.equal(rtlTable.toggle, true, JSON.stringify(rtlTable));
      if (rtlTable.expanded !== 'true') {
        await evaluate('document.querySelector("#main [data-table-width-toggle]").click()');
        await settle();
      }
      const grown = await metrics();
      assert.equal(grown.expanded, 'true', JSON.stringify(grown));
      assert.ok(grown.overlay.left >= grown.viewport.left - 1, `RTL table in ${chatDir} chat keeps its frame start inside the panel: ${JSON.stringify(grown)}`);
      assert.ok(grown.overlay.right <= grown.viewport.right + 1, `RTL table in ${chatDir} chat keeps its frame end inside the panel: ${JSON.stringify(grown)}`);
      await scrollMain('start');
      await settle();
      const atStart = await metrics();
      assert.equal(atStart.start, null, 'no start fade at the RTL table start');
      assert.equal(atStart.end, 'true', 'hidden RTL columns show an end fade');
      await scrollMain('end');
      await settle();
      const atEnd = await metrics();
      assert.equal(atEnd.start, 'true', 'scrolled RTL table shows a start fade');
      assert.equal(atEnd.end, null, 'the RTL end fade clears at the last column');
    }

    await evaluate('window.renderFixture("ltr", 720)');
    await settle();
    assert.equal((await metrics()).toggle, false, 'no expansion when the chat is not wider than the message');
  } finally {
    const within = (promise, milliseconds) => Promise.race([promise, wait(milliseconds)]);
    client?.close();
    if (browser && browser.exitCode === null) {
      const exited = once(browser, 'exit');
      browser.kill('SIGTERM');
      await within(exited, 3000);
      if (browser.exitCode === null) browser.kill('SIGKILL');
    }
    await within(server.close(), 3000);
    rmSync(fixture, { recursive: true, force: true });
  }
});
