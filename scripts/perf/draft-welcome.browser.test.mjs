import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, wait } from './cdp.mjs';
import { createFixtureDir, serveFixture } from './fixture-page.mjs';

const LEAD_TEMPLATE = 'What will this lead take on in {project}?';
const PLAIN_TEMPLATE = 'What are we building in {project} today?';
const COMMA_TEMPLATE = 'Noch etwas in {project}, bevor das Jahr endet?';

async function createDraftFixture() {
  const fixture = createFixtureDir('draft-welcome');
  writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html lang="en" class="mobile-pointer"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="root" class="flex h-dvh flex-col overflow-hidden"></main><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { DraftWelcome } from '@/components/chat/column/DraftWelcome';
    import { renderDraftTitle } from '@/components/chat/composer/input/ComposerDraftTitle';
    import { I18nProvider } from '@/lib/i18n';
    import { useProjectsStore } from '@/stores/useProjectsStore';
    import { useUIStore } from '@/stores/useUIStore';
    import { useSessionUIStore } from '@/sync/session-ui-store';
    import '@/index.css';

    const params = new URLSearchParams(location.search);
    const labels = [params.get('project'), 'Notes'];
    const projects = labels.map((label, i) => ({ id: String(i), label, path: '/project-' + i, addedAt: 1, lastOpenedAt: 1 }));
    useUIStore.getState().setDraftStartersVisible(false);
    useProjectsStore.setState({ projects, activeProjectId: projects[0].id });
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projects[0].id, lead: params.get('lead') === '1' });
    window.chooseProject = (i) => useSessionUIStore.getState().setNewSessionDraftTarget({ projectId: projects[i].id, directoryOverride: projects[i].path });
    // The desktop heading above the composer renders the same name through renderDraftTitle.
    const desktopHeading = <h1 className="text-3xl">{renderDraftTitle('Where do we start in ' + labels[0] + '?', labels[0])}</h1>;
    createRoot(document.getElementById('root')).render(<I18nProvider>{params.get('view') === 'desktop' ? desktopHeading : <DraftWelcome />}</I18nProvider>);
  `);
  // The plain draft heading picks a random line; pin it to one that ends in words.
  writeFileSync(path.join(fixture, 'easter-egg-copy.ts'), `
    const line = new URLSearchParams(location.search).get('template') ?? ${JSON.stringify(PLAIN_TEMPLATE)};
    const draftTitle = new Proxy({}, { get: () => [line] });
    const copy = { draftTitle };
    export const useEasterEggCopy = () => copy;
  `);
  return { fixture, ...await serveFixture({ root: fixture, aliases: [{ find: '@/lib/easter-eggs/easterEggCopy', replacement: path.join(fixture, 'easter-egg-copy.ts') }] }) };
}

async function assertHeadingFits(client, url, project, { lead = true, template = lead ? LEAD_TEMPLATE : PLAIN_TEMPLATE, switchProjects = false, widthChars } = {}) {
  const headingFor = (name) => template.replace('{project}', name);
  const suffix = template.slice(template.indexOf('{project}') + '{project}'.length);
  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result.value;
  };
  const loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `${url}?project=${encodeURIComponent(project)}&lead=${lead ? 1 : 0}&template=${encodeURIComponent(template)}` });
  await loaded;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(await evaluate('Boolean(document.querySelector("h1"))'))) await wait(50);
  if (widthChars) {
    // Exactly two lines of the unspaced name fit. Without a no-break tail the question mark gets a third line.
    await evaluate(`(() => {
      const heading = document.querySelector('h1');
      heading.style.fontFamily = 'monospace';
      heading.style.letterSpacing = '0';
      heading.parentElement.style.inlineSize = 'calc(${widthChars}ch + 2 * ' + getComputedStyle(heading.parentElement).paddingLeft + ')';
      heading.parentElement.style.font = getComputedStyle(heading).font;
    })()`);
  }
  const measureHeading = `document.fonts.ready.then(() => {
    const heading = document.querySelector('h1');
    const column = heading.parentElement;
    const padded = column.getBoundingClientRect();
    const { paddingLeft, paddingRight } = getComputedStyle(column);
    const range = document.createRange();
    range.selectNodeContents(heading);
    const text = range.getBoundingClientRect();

    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    const characters = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const { index } of node.data.matchAll(/\\S/g)) characters.push({ node, index });
    }
    const rect = ({ node, index }) => {
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      return range.getBoundingClientRect();
    };
    const sameLine = (a, b) => a.top < b.bottom && b.top < a.bottom;
    const [previous, last] = characters.slice(-2).map(rect);
    // Punctuation right after the name, such as the comma in ", bevor das Jahr endet?".
    const nameEnd = characters.length - ${JSON.stringify(suffix.replace(/\s/g, ''))}.length;
    const headingBox = heading.getBoundingClientRect();
    const scroller = column.getBoundingClientRect();
    return {
      // Words after the name (" today?") may wrap to the next line; only punctuation that touches the name stays with it.
      closingPunctuationWithName: ${JSON.stringify(/^\p{P}/u.test(suffix))} ? sameLine(rect(characters[nameEnd - 1]), rect(characters[nameEnd])) : true,
      startReachable: headingBox.top >= scroller.top - 1,
      scrollable: column.scrollHeight <= column.clientHeight || getComputedStyle(column).overflowY === 'auto',
      heading: heading.textContent,
      fits: text.left >= padded.left + parseFloat(paddingLeft) - 1 && text.right <= padded.right - parseFloat(paddingRight) + 1,
      textBounds: [text.left, text.right],
      punctuationOnLastLine: previous.top < last.bottom && last.top < previous.bottom,
      pageOverflows: document.documentElement.scrollWidth > innerWidth,
    };
  })`;
  const assertLayout = (layout) => {
    assert.equal(layout.heading, headingFor(project));
    assert.ok(layout.fits, `the heading text ${layout.textBounds} must fit inside the padded column: ${layout.heading}`);
    assert.ok(layout.punctuationOnLastLine, `the final punctuation must share a line with the preceding text: ${layout.heading}`);
    assert.ok(layout.closingPunctuationWithName, `punctuation right after the name must share a line with it: ${layout.heading}`);
    assert.ok(layout.startReachable && layout.scrollable, `a heading taller than the draft area starts inside it and scrolls: ${layout.heading}`);
    assert.equal(layout.pageOverflows, false, 'the page must not scroll horizontally');
  };
  assertLayout(await evaluate(measureHeading));
  if (!switchProjects) return;

  const motion = await evaluate(`(async () => {
    const heading = document.querySelector('h1');
    const height = () => heading.getBoundingClientRect().height;
    const frame = () => new Promise(requestAnimationFrame);
    const frameLimit = 120;
    const shortHeading = ${JSON.stringify(headingFor('Notes'))};
    // Punctuation right after the name rides inside the name's box; the words after it are their own text.
    const suffix = ${JSON.stringify(suffix.replace(/^\s*\p{P}+(?=\s)/u, '') || suffix)};
    // The suffix is visible when no clipping box that holds it ends before it does.
    const suffixVisible = () => {
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
      let node = null;
      for (let next = walker.nextNode(); next; next = walker.nextNode()) if (next.data.endsWith(suffix.trim())) node = next;
      if (!node) return false;
      const range = document.createRange();
      range.setStart(node, Math.max(0, node.data.length - suffix.trim().length));
      range.setEnd(node, node.data.length);
      const text = range.getBoundingClientRect();
      if (text.width === 0) return false;
      for (let box = node.parentElement; box && box !== heading.parentElement; box = box.parentElement) {
        if (getComputedStyle(box).overflowX === 'visible') continue;
        const bounds = box.getBoundingClientRect();
        if (text.left < bounds.left - 1 || text.right > bounds.right + 1 || text.top < bounds.top - 1 || text.bottom > bounds.bottom + 1) return false;
      }
      return true;
    };
    let suffixHidden = 0;
    // The width morph animates only after it has seen the name's first layout, which a
    // ResizeObserver reports after the frame's animation callbacks; switch after that frame.
    await frame();
    await frame();
    const startHeight = height();
    window.chooseProject(1);
    for (let i = 0; heading.textContent !== shortHeading && i < frameLimit; i++) await frame();
    for (let i = 0; i < frameLimit && heading.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'); i++) {
      if (!suffixVisible()) suffixHidden++;
      await frame();
    }
    await Promise.all(heading.getAnimations({ subtree: true }).map(animation => animation.finished));
    const shortHeight = height();
    let maxHeight = 0;
    let animated = false;
    window.chooseProject(0);
    for (let i = 0; i < frameLimit; i++) {
      await frame();
      if (heading.textContent === shortHeading) continue;
      if (!suffixVisible()) suffixHidden++;
      maxHeight = Math.max(maxHeight, height());
      const animation = heading.getAnimations({ subtree: true }).find(animation => animation.playState === 'running');
      if (!animation) break;
      const [from, to] = animation.effect.getKeyframes().map(frame => parseFloat(frame.width));
      const width = animation.effect.target.getBoundingClientRect().width;
      animated ||= width > from && width < to;
    }
    await frame();
    return { animated, suffixHidden, fits: maxHeight <= Math.max(startHeight, shortHeight) };
  })()`);
  assert.ok(motion.animated, 'the name width animates on a project switch');
  assert.ok(motion.fits, 'the heading gains no extra line during the width animation');
  // A punctuation-only ending rides with the last grapheme inside the clipped box; words stay outside it.
  if (!lead) assert.equal(motion.suffixHidden, 0, `the text after the name stays visible while the name width animates: ${JSON.stringify(suffix)}`);
  assertLayout(await evaluate(measureHeading));
}

// A font whose letters are taller than the heading's line (Noto Sans SC, Segoe UI at 1.2) must keep the
// tails of p, y and g. A line height of 1 makes every font that tall.
async function assertNameTailsVisible(client, url, { view, switchProjects = false }) {
  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result.value;
  };
  const loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `${url}?project=mpv-lazy&lead=0&view=${view}&template=${encodeURIComponent(PLAIN_TEMPLATE)}` });
  await loaded;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(await evaluate('Boolean(document.querySelector("h1 span"))'))) await wait(50);
  const result = await evaluate(`document.fonts.ready.then(async () => {
    const heading = document.querySelector('h1');
    heading.style.lineHeight = '1';
    const frame = () => new Promise(requestAnimationFrame);
    // Pixels of the name's glyphs cut off by a box that clips vertically; 0 when every tail shows.
    const cutOff = () => {
      // Read the baseline from the text's own box; inserting a marker would restart the width animation.
      const name = heading.querySelector('span');
      const style = getComputedStyle(name);
      const context = document.createElement('canvas').getContext('2d');
      context.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
      const metrics = context.measureText(name.textContent);
      const range = document.createRange();
      range.selectNodeContents(name);
      const baseline = [...range.getClientRects()].at(-1).bottom - metrics.fontBoundingBoxDescent;
      const inkBottom = baseline + metrics.actualBoundingBoxDescent;
      let cut = 0;
      for (let box = name; box !== heading.parentElement; box = box.parentElement) {
        if (getComputedStyle(box).overflowY === 'visible') continue;
        cut = Math.max(cut, inkBottom - box.getBoundingClientRect().bottom);
      }
      return { cut, morphing: name.hasAttribute('data-width-morphing') };
    };
    const samples = [cutOff()];
    if (${switchProjects}) {
      await frame();
      await frame();
      for (const project of [1, 0]) {
        window.chooseProject(project);
        for (let i = 0; i < 120; i++) {
          await frame();
          samples.push(cutOff());
          if (i > 2 && !heading.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running')) break;
        }
      }
    }
    return { maxCut: Math.max(...samples.map((sample) => sample.cut)), morphFrames: samples.filter((sample) => sample.morphing).length };
  })`);
  assert.ok(result.maxCut < 0.5, `the project name loses ${result.maxCut}px of its letters in the ${view} heading`);
  if (switchProjects) assert.ok(result.morphFrames > 0, 'the name width animates on a project switch');
}

let chrome;
try {
  chrome = resolveChrome(process.env.OPENCHAMBER_TEST_CHROME);
} catch (error) {
  if (process.env.OPENCHAMBER_TEST_CHROME) throw error;
}

test('a new-session heading shows a long project name and the text after it inside the phone column, with every letter tail', {
  skip: !chrome && 'Set OPENCHAMBER_TEST_CHROME to run the browser regression', timeout: 120_000,
}, async () => {
  const fixture = await createDraftFixture();
  let browser;
  let client;
  try {
    const port = await reservePort();
    browser = launchChrome({ chrome, port, profileDir: path.join(fixture.fixture, 'profile'), headless: true, extraArgs: ['--lang=en-US', '--no-sandbox', '--disable-dev-shm-usage'] });
    const target = await createPageTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await assertHeadingFits(client, fixture.url, 'EPUB File Reader with Markdown Annotations', { switchProjects: true });
    await assertHeadingFits(client, fixture.url, 'A'.repeat(34), { widthChars: 17 });
    await assertHeadingFits(client, fixture.url, 'EPUB File Reader with Markdown Annotations', { lead: false, switchProjects: true });
    await assertHeadingFits(client, fixture.url, 'A'.repeat(34), { lead: false, template: COMMA_TEMPLATE, widthChars: 17 });
    await assertHeadingFits(client, fixture.url, 'EPUB File Reader with Markdown Annotations', { lead: false, template: COMMA_TEMPLATE, switchProjects: true });
    // A short draft area, such as a phone in landscape: a tall heading must stay reachable.
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 300, deviceScaleFactor: 1, mobile: true });
    await assertHeadingFits(client, fixture.url, 'project-'.repeat(32), { lead: false });
    await assertNameTailsVisible(client, fixture.url, { view: 'compact', switchProjects: true });
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await assertNameTailsVisible(client, fixture.url, { view: 'desktop' });
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
