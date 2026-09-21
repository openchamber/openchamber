// Run against an isolated server with fold-resize.txt in its selected project:
// node scripts/test-mobile-workspace-resize.mjs http://127.0.0.1:3000 /tmp/fold-proof
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, wait } from './perf/cdp.mjs';

const [url, output] = process.argv.slice(2);
assert(url && output, 'Provide an isolated server URL and an evidence directory');
await mkdir(output, { recursive: true });
const profileDir = await mkdtemp(join(tmpdir(), 'oc-fold-resize-'));
const port = await reservePort();
const chrome = launchChrome({ chrome: resolveChrome(), profileDir, port, headless: true });
let client;
const results = [];
try {
  client = new CdpClient((await createPageTarget(port)).webSocketDebuggerUrl);
  await client.connect();
  const evaluate = (expression) => evaluateValue(client, expression);
  const until = async (expression) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await wait(200);
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const resize = async (width, height) => {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await wait(800);
  };
  await resize(620, 840);
  await client.send('Page.navigate', { url: new URL('/mobile.html', url).href });
  await until(`!!document.querySelector('[aria-label="Open workspace panel"]')`);
  await evaluate(`document.querySelector('[aria-label="Open workspace panel"]').click()`);
  await until('!!document.querySelector("[aria-label=Files]")');
  await evaluate('document.querySelector("[aria-label=Files]").click()');
  await until('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="fold-resize.txt")');
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="fold-resize.txt").click()');
  await until('!!document.querySelector("#mobile-surface-root .cm-content")');
  // Disable autosave through the actual toolbar before inserting the draft.
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")?.startsWith("Auto-save"))?.click()');
  await until(`!!document.querySelector('[aria-label="Manual save"]')`);
  await evaluate('window.resizeEditor=document.querySelector("#mobile-surface-root .cm-content"); resizeEditor.focus()');
  await client.send('Input.insertText', { text: 'UNSAVED_FOLD_DRAFT ' });
  await until('resizeEditor.textContent.includes("UNSAVED_FOLD_DRAFT")');
  for (const [name, width, height] of [
    ['before', 620, 840],
    ['keyboard-open', 620, 500],
    ['keyboard-closed', 620, 840],
    ['folded-phone', 390, 840],
    ['phone-keyboard', 390, 500],
    ['unfolded', 620, 840],
    ['rotated', 840, 620],
    ['landscape-keyboard', 840, 380],
  ]) {
    await resize(width, height);
    const state = await evaluate(`({
      width: innerWidth, height: innerHeight,
      sameEditor: resizeEditor === document.querySelector('#mobile-surface-root .cm-content'),
      connected: resizeEditor.isConnected,
      focused: document.activeElement === resizeEditor,
      draft: resizeEditor.textContent.includes('UNSAVED_FOLD_DRAFT'),
      fileOpen: !!Array.from(document.querySelectorAll('h2')).find(e=>e.textContent==='fold-resize.txt'),
      tabletSidebar: !!document.querySelector('.oc-mobile-app-shell > aside:first-child')
    })`);
    results.push({ name, ...state });
    const shot = await client.send('Page.captureScreenshot');
    await writeFile(join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
    await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
    assert(state.sameEditor && state.connected && state.focused && state.draft && state.fileOpen, `${name}: ${JSON.stringify(state)}`);
    assert.equal(state.tabletSidebar, Math.min(width, height) >= 600, `${name}: size class must still update`);
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  client?.close();
  chrome.kill();
  await new Promise(resolve => chrome.once('exit', resolve));
  await rm(profileDir, { recursive: true, force: true });
}
