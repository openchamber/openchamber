import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, wait } from './cdp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCALES = ['en', 'ar', 'de', 'es', 'fr', 'he', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'tr', 'uk', 'zh-CN', 'zh-TW'];
// The app draws in the system font, so the same row measures differently on
// every host: CI's Ubuntu falls back to DejaVu Sans, a much wider face than the
// Noto Sans of a developer's Linux. The fixture draws in fonts pdfjs-dist already
// ships to the UI, so the measurement is the same everywhere: Liberation Sans for
// an Arial-width system font, and its bold cut drawn at normal weight to stand in
// for a wide one such as DejaVu Sans.
const STANDARD_FONTS = path.join(
  path.dirname(createRequire(path.join(repo, 'packages/ui/package.json')).resolve('pdfjs-dist/package.json')),
  'standard_fonts',
);
const TEST_FONTS = [
  { family: 'OC Test Liberation Sans', painted: 'Liberation Sans', file: path.join(STANDARD_FONTS, 'LiberationSans-Regular.ttf') },
  { family: 'OC Test Wide Sans', painted: 'Liberation Sans', file: path.join(STANDARD_FONTS, 'LiberationSans-Bold.ttf') },
];
const NARROW_WIDTHS = [360, 375, 390];
// The row's own width above which a paused goal shows its token count again (28rem).
const WIDE_WIDTH = 768;

/**
 * A paused goal's row on a phone holds the objective, the hint that the goal
 * stays paused while the user chats and Resume on one line. A token count with
 * a budget once shared that line and cut the hint down to "Paused w…", so the
 * explanation was gone exactly where a tooltip cannot bring it back. A narrow
 * row now leaves the count to the goal dialog. This renders the real
 * SessionGoalRow with the UI stylesheet in the phone layout, with a long
 * objective and a token budget, in every locale and in a normal and a wide
 * font, and reads whether the hint and Resume are whole. Only the row's data
 * hooks and its action are stubbed, so the row's own markup and classes are
 * what is measured. Scripts Liberation Sans lacks still come from the host.
 */

async function createGoalRowFixture() {
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/session-goal-row-'));
  // Served from the fixture itself: a linked worktree resolves pdfjs-dist into
  // another checkout, outside the server's allowed paths, and a Windows path
  // does not form a URL.
  for (const font of TEST_FONTS) copyFileSync(font.file, path.join(fixture, path.basename(font.file)));
  const fontStyle = `<style>${TEST_FONTS.map((font) => `@font-face{font-family:"${font.family}";font-weight:400;src:url("/${path.basename(font.file)}") format("truetype")}`).join('')}</style>`;
  writeFileSync(path.join(fixture, 'index.html'), `<!doctype html><html class="mobile-pointer"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${fontStyle}</head><body><div id="root" style="margin:0 12px"></div><script type="module" src="/fixture.tsx"></script></body></html>`);
  writeFileSync(path.join(fixture, 'goal-stub.ts'), `
    const goal = {
      id: 'goal', objective: 'Write a twelve-chapter illustrated guide to sourdough baking in docs/, one markdown file per chapter',
      status: 'paused', tokensUsed: 123418, tokenBudget: 2000000,
    };
    export const useSessionGoal = () => ({ goal, enabled: true });
    export const useGoalObjectiveContent = () => goal.objective;
    export const useSessionStatus = () => ({ type: 'idle' });
    export const setSessionGoalStatus = async () => {};
  `);
  const imports = LOCALES.map((locale, index) => `import { dict as d${index} } from '@/lib/i18n/messages/${locale}';`).join('\n');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { SessionGoalRow } from '@/components/chat/SessionGoalRow';
    import { I18nContext } from '@/lib/i18n/react-context';
    import { formatTemplate } from '@/lib/i18n/format';
    import '@/index.css';
    ${imports}

    const dicts = { ${LOCALES.map((locale, index) => `'${locale}': d${index}`).join(', ')} };
    const root = createRoot(document.getElementById('root'));
    let revision = 0;
    window.renderGoalRow = (locale, font) => {
      document.documentElement.style.setProperty('--font-sans', JSON.stringify(font));
      const direction = locale === 'ar' || locale === 'he' ? 'rtl' : 'ltr';
      document.documentElement.dir = direction;
      document.documentElement.lang = locale;
      const i18n = { locale, direction, locales: [locale], setLocale() {}, label: (value) => value, t: (key, params) => formatTemplate(dicts[locale][key], params) };
      flushSync(() => root.render(<I18nContext.Provider key={++revision} value={i18n}><SessionGoalRow sessionId="ses_fixture" directory="/repo" /></I18nContext.Provider>));
    };
    window.measureGoalRow = () => {
      const row = document.querySelector('[role=group]');
      const [, , hint, usage] = row.children;
      const resumeLabel = dicts[document.documentElement.lang]['chat.goal.action.resume'];
      const button = [...row.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === resumeLabel);
      if (!button) return { resumeLabel, resumeFound: false };
      const label = [...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      const labelRange = document.createRange();
      labelRange.selectNodeContents(label);
      const labelBox = labelRange.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(hint);
      const rowBox = row.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      const hintBox = hint.getBoundingClientRect();
      const usageBox = usage.getBoundingClientRect();
      const usageText = document.createRange();
      usageText.selectNodeContents(usage);
      const rtl = document.documentElement.dir === 'rtl';
      return {
        hint: hint.textContent,
        expectedHint: dicts[document.documentElement.lang]['chat.goal.row.pausedHint'],
        hintText: text.getBoundingClientRect().width,
        hintBox: hintBox.width,
        hintBesideResume: rtl ? hintBox.left >= buttonBox.right - 0.5 : hintBox.right <= buttonBox.left + 0.5,
        usage: usage.textContent,
        usageShown: usageBox.width > 0,
        usageWhole: usageText.getBoundingClientRect().width <= usageBox.width + 0.01,
        resumeFound: true,
        resumeLabelWhole: labelBox.width > 0 && labelBox.left >= buttonBox.left - 0.5 && labelBox.right <= buttonBox.right + 0.5 && button.scrollWidth <= button.clientWidth,
        resumeInside: buttonBox.left >= rowBox.left - 0.5 && buttonBox.right <= rowBox.right + 0.5,
        overflow: row.scrollWidth - row.clientWidth,
      };
    };
  `);
  const stub = path.join(fixture, 'goal-stub.ts');
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false, root: fixture, logLevel: 'error',
    // Concurrent browser suites must not invalidate each other's optimized deps.
    cacheDir: path.join(fixture, '.vite'),
    css: { postcss: repo },
    resolve: {
      alias: [
        { find: /^@\/hooks\/useSessionGoal$/, replacement: stub },
        { find: /^@\/sync\/sync-context$/, replacement: stub },
        { find: /^@\/lib\/sessionGoalActions$/, replacement: stub },
        { find: '@openchamber/sdk', replacement: path.join(repo, 'packages/sdk/src/index.ts') },
        { find: '@', replacement: path.join(repo, 'packages/ui/src') },
      ],
    },
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

async function assertHintFits(client, url) {
  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result.value;
  };
  const until = async (expression) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await wait(50);
    }
    assert.fail(`Timed out waiting for ${expression}`);
  };

  const paintedFonts = async () => {
    const { root } = await client.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[role=group] > :nth-child(3)' });
    const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
    return fonts.map((font) => `${font.familyName}${font.isCustomFont ? ' (web font)' : ''}`);
  };

  await client.send('Page.enable');
  await client.send('DOM.enable');
  await client.send('CSS.enable');
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  for (const width of [...NARROW_WIDTHS, WIDE_WIDTH]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: true });
    await client.send('Page.navigate', { url });
    await until('typeof window.renderGoalRow === "function"');
    for (const font of TEST_FONTS) {
      const loaded = await evaluate(`document.fonts.load('16px "${font.family}"').then((faces) => faces.length)`);
      assert.ok(loaded > 0, `the test font ${font.file} did not load`);
    }
    for (const font of TEST_FONTS) {
      for (const locale of LOCALES) {
        await evaluate(`window.renderGoalRow(${JSON.stringify(locale)}, ${JSON.stringify(font.family)})`);
        await evaluate('document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))))');
        const row = await evaluate('window.measureGoalRow()');
        const where = `${locale} in ${font.family} at ${width}px: ${JSON.stringify(row)}`;
        if (!['ar', 'he', 'ja', 'ko', 'zh-CN', 'zh-TW'].includes(locale)) {
          assert.deepEqual(await paintedFonts(), [`${font.painted} (web font)`], `the hint is drawn in the test font, ${where}`);
        }
        assert.ok(row.resumeFound, `Resume shows its localized label, ${where}`);
        assert.ok(row.resumeLabelWhole, `Resume's label shows whole beside its icon, ${where}`);
        assert.ok(row.expectedHint && row.hint === row.expectedHint, `the localized hint renders, ${where}`);
        assert.ok(row.hintText <= row.hintBox + 0.01, `the paused hint shows whole, ${where}`);
        assert.ok(row.hintBesideResume, `the hint sits beside Resume, ${where}`);
        assert.ok(row.resumeInside, `Resume stays inside the row, ${where}`);
        assert.equal(row.overflow, 0, `the row does not overflow, ${where}`);
        if (width === WIDE_WIDTH) {
          assert.ok(row.usageShown && row.usageWhole, `a wide row shows the whole token count, ${where}`);
        } else {
          assert.equal(row.usageShown, false, `a narrow row leaves the token count to the goal dialog, ${where}`);
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
test('a paused goal row shows the whole hint and Resume on a 360-390 px phone, and its token count on a wide row, in every locale and a wide font', {
  skip: !chrome && 'Set OPENCHAMBER_TEST_CHROME to run the browser regression', timeout: 480_000,
}, async () => {
  const fixture = await createGoalRowFixture();
  let browser;
  let client;
  try {
    const port = await reservePort();
    browser = launchChrome({ chrome, port, profileDir: path.join(fixture.fixture, 'profile'), headless: true, extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const target = await createPageTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await assertHintFits(client, fixture.url);
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
