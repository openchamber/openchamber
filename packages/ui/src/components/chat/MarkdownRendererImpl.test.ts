import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getDefaultTheme } from '@/lib/theme/themes';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, HTMLElement: browser.HTMLElement,
  HTMLAnchorElement: browser.HTMLAnchorElement, Element: browser.Element, Node: browser.Node, Text: browser.Text,
  SVGElement: browser.SVGElement, MutationObserver: browser.MutationObserver, DOMParser: browser.DOMParser,
  Event: browser.Event,
  Range: browser.Range,
  XMLSerializer: browser.XMLSerializer, IntersectionObserver: browser.IntersectionObserver, ResizeObserver: browser.ResizeObserver });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(globalThis, 'customElements', { configurable: true, value: browser.customElements });
const state = { codeBlockLineWrap: false, tableCellWrap: true, copyMessagesAsPlainText: false, mermaidRenderingMode: 'svg', setCodeBlockLineWrap: () => undefined, setTableCellWrap: () => undefined, openContextFile: (_directory: string, _path: string) => undefined, openContextFileAtLine: (_directory: string, _path: string, _line: number, _column: number) => undefined };
mock.module('@/stores/useUIStore', () => ({ useUIStore: Object.assign((select: (value: typeof state) => never) => select(state), { getState: () => state }) }));
mock.module('@/lib/router/openSessionFromRoute', () => ({ openSessionLink: async () => undefined }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/project' }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ runtime: { isVSCode: false }, editor: undefined }) }));
const openedLinks: string[] = [];
mock.module('./useOpenChatLink', () => ({ useOpenChatLink: () => (href: string) => { openedLinks.push(href); } }));
let currentTheme = getDefaultTheme(false);
mock.module('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => ({ currentTheme }) }));
mock.module('./message/FadeInOnReveal', () => ({ FadeInOnReveal: ({ children }: { children: React.ReactNode }) => children }));

let Renderer: typeof import('./MarkdownRendererImpl');
let I18nProvider: typeof import('@/lib/i18n')['I18nProvider'];
let root: Root;
const host = document.createElement('div');
beforeAll(async () => {
  Renderer = await import('./MarkdownRendererImpl');
  I18nProvider = (await import('@/lib/i18n')).I18nProvider;
  document.body.append(host);
  root = createRoot(host);
});
afterAll(async () => { await act(() => root?.unmount()); browser.happyDOM.abort(); });
const render = async (content: string, isStreaming = false, allowRawHtml = false) => {
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(Renderer.SimpleMarkdownRenderer, { content, allowRawHtml, enableFileReferences: false })));
  });
  void isStreaming;
};

test('renders semantic Markdown through native Streamdown code and table components', async () => {
  await render('**bold**\n\n`inline`\n\n```text\nfirst\nsecond\n```\n\n| name | value |\n| --- | --- |\n| [link](https://example.com) | 2 |');
  expect(host.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
  expect(host.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe('inline');
  expect(host.querySelector('strong')?.textContent).toBe('bold');
  expect(host.querySelector('table a')?.getAttribute('href')).toBe('https://example.com');
  const tableWrapper = host.querySelector('[data-streamdown="table-wrapper"]');
  expect(host.querySelectorAll('[data-streamdown="table-wrapper"]').length).toBe(1);
  expect(tableWrapper?.firstElementChild?.getAttribute('data-streamdown')).toBe('table-controls');
  expect(tableWrapper?.firstElementChild?.classList.contains('justify-end')).toBe(true);
  expect(tableWrapper?.lastElementChild?.querySelector('table')).not.toBeNull();
  expect(Array.from(host.querySelector('pre code')?.children ?? []).map((line) => line.textContent).join('\n')).toBe('first\nsecond');
  expect(host.querySelector('[data-oc-code-source]')?.getAttribute('data-oc-code-source')).toBe('first\nsecond');
});

test('invisible-only blocks leave no paragraphs or arrival wrappers in either render mode', async () => {
  const visible = 'Family: 👨‍👩‍👧, Persian: می‌خواهم';
  for (const mode of ['streaming', 'static'] as const) {
    const draw = (content: string, live = false) => act(async () => root.render(
      React.createElement(I18nProvider, null, React.createElement(Renderer.MarkdownContent, {
        content, mode, isStreaming: live, settled: !live, enableFileReferences: false,
      }))));
    await draw(`Done.\n\n\u200B\n\n\u200C\u200D\n\n${visible}`, mode === 'streaming');
    expect(Array.from(host.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['Done.', visible]);
    for (const block of host.querySelectorAll('[data-oc-markdown-block]')) {
      expect(block.textContent?.length).toBeGreaterThan(0);
    }
    for (const content of ['\u200B', '\uFEFF\n', '\u200B\n\n\u2060']) {
      await draw(content, mode === 'streaming');
      expect(host.querySelectorAll('p, [data-oc-markdown-block]').length).toBe(0);
    }
    await draw('\u200B\nHello');
    expect(host.querySelector('p')?.textContent).toBe('\u200B\nHello');
    await draw('```text\n\u200B\n```');
    expect(host.querySelector('pre code')?.textContent).toBe('\u200B');
    await draw('Done.\n\n\u200B', true);
    await draw('Done.\n\n\u200B\nVisible tail', false);
    expect(Array.from(host.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['Done.', '\u200B\nVisible tail']);
  }
});

test('invisible-block filtering preserves BOM-prefixed text and filters reparsed disclosure suffixes', async () => {
  for (const mode of ['static', 'streaming'] as const) {
    const draw = (content: string) => act(async () => root.render(
      React.createElement(I18nProvider, null, React.createElement(Renderer.MarkdownContent, {
        content, mode, settled: true, enableFileReferences: false,
      }))));
    await draw('\uFEFFX');
    expect(host.querySelector('p')?.textContent).toBe('X');
    await draw('\uFEFFDone.\n\n\u200B');
    expect(Array.from(host.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['Done.']);
    await draw('<details><summary>S</summary>Body</details>\n\u200B\n\nAfter');
    expect(host.querySelector('details summary')?.textContent).toBe('S');
    expect(host.querySelector('details p')?.textContent).toBe('Body');
    expect(Array.from(host.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['Body', 'After']);
    await draw('<details><summary>S</summary>Body</details>\uFEFFX\n\nAfter');
    expect(Array.from(host.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['Body', 'X', 'After']);
    for (const block of host.querySelectorAll('[data-oc-markdown-block]')) {
      expect(block.textContent?.length).toBeGreaterThan(0);
    }
  }
});

test('file navigation respects disabling, stream settlement and selection-ending clicks', async () => {
  const open = spyOn(state, 'openContextFile');
  const content = '[file](/outside/report.ts) and `/outside/inline.ts`\n\n```text\n/outside/code.ts\n```';
  const draw = (enabled: boolean, settled: boolean) => act(() => root.render(React.createElement(I18nProvider, null,
    React.createElement(Renderer.MarkdownContent, { content, directory: '/project', enableFileReferences: enabled, settled }))));
  try {
    for (const [enabled, settled] of [[false, true], [true, false]]) {
      await draw(enabled, settled);
      const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      host.querySelector('a')?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(open.mock.calls).toHaveLength(0);
    }
    await draw(true, true);
    for (let i = 0; i < 50 && !host.querySelector('pre [data-openchamber-file-ref]'); i++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const targets = host.querySelectorAll<HTMLElement>('a, code[data-openchamber-file-ref], pre [data-openchamber-file-ref]');
    expect(targets.length).toBe(3);
    for (const target of targets) {
      const range = document.createRange();
      range.selectNodeContents(target);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      target.click();
      expect(open.mock.calls).toHaveLength(0);
    }
    document.getSelection()?.removeAllRanges();
    host.querySelector<HTMLElement>('a')?.click();
    expect(open.mock.calls).toEqual([['/project', '/outside/report.ts']]);
  } finally {
    document.getSelection()?.removeAllRanges();
    open.mockRestore();
  }
});

test('on the phone a file link also opens the files drawer (#5486)', async () => {
  const open = spyOn(state, 'openContextFile');
  const { DedicatedMobileAppProvider } = await import('@/apps/mobileAppContext');
  let filesOpened = 0;
  const actions = { openChanges: () => undefined, openFiles: () => { filesOpened += 1; }, openSettings: () => undefined, openSourceBoard: () => undefined };
  try {
    const content = React.createElement(Renderer.MarkdownContent, { content: '[View README.md](README.md)', directory: '/project', enableFileReferences: true, settled: true });
    await act(() => root.render(React.createElement(I18nProvider, null, React.createElement(DedicatedMobileAppProvider, { actions, children: content }))));
    host.querySelector<HTMLElement>('a')?.click();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(open.mock.calls).toEqual([['/project', '/project/README.md']]);
    expect(filesOpened).toBe(1);
  } finally {
    open.mockRestore();
  }
});

test('a file:// folder link opens in the file manager in the desktop app only, as the Files tree reveal does (#5521)', async () => {
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const web = createWebAPIs();
  const revealed: string[] = [];
  const files = { ...web.files, revealPath: async (path: string) => { revealed.push(path); return { success: true }; } };
  const content = React.createElement(Renderer.MarkdownContent, { content: '[Open the test folder](file:///Users/me/some_path/)', directory: '/project', enableFileReferences: true, settled: true });
  // Electron reports the web platform and differs from a browser only by its shell.
  const surfaces = [['browser', 'web', false], ['vscode', 'vscode', false], ['desktop', 'web', true]] as const;
  try {
    for (const [surface, platform, electron] of surfaces) {
      Object.assign(window, { __OPENCHAMBER_ELECTRON__: electron ? { runtime: 'electron' } : undefined });
      const apis = { ...web, files, runtime: { ...web.runtime, platform } };
      await act(() => root.render(React.createElement(I18nProvider, null, React.createElement(RuntimeAPIContext.Provider, { value: apis }, content))));
      const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      host.querySelector('a')?.dispatchEvent(event);
      expect([surface, event.defaultPrevented]).toEqual([surface, electron]);
    }
    expect(revealed).toEqual(['/Users/me/some_path/']);
  } finally {
    Object.assign(window, { __OPENCHAMBER_ELECTRON__: undefined });
  }
});

test('remote media labels use chat navigation and retain modified-click defaults', async () => {
  openedLinks.length = 0;
  await render('![remote](https://example.com/image.png)');
  const anchor = host.querySelector('a');
  const plain = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  anchor?.dispatchEvent(plain);
  expect(plain.defaultPrevented).toBe(true);
  expect(openedLinks).toEqual(['https://example.com/image.png']);
  const modified = new window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  anchor?.dispatchEvent(modified);
  expect(modified.defaultPrevented).toBe(false);
  expect(openedLinks).toHaveLength(1);
});

test('links keep the old renderer behaviour: inert when unsafe, bare URLs LTR, framed favicons, footnotes scroll in place', async () => {
  openedLinks.length = 0;
  await render('[bad](javascript:alert(1)) https://example.com/docs [named](https://example.com/page)\n\nNote[^1]\n\n[^1]: The note.');
  const anchors = Array.from(host.querySelectorAll('a'));
  const bad = anchors.find((anchor) => anchor.textContent === 'bad');
  expect(bad?.hasAttribute('href')).toBe(false);
  expect(bad?.hasAttribute('target')).toBe(false);
  const bare = anchors.find((anchor) => anchor.textContent === 'https://example.com/docs');
  expect(bare?.getAttribute('dir')).toBe('ltr');
  expect(anchors.find((anchor) => anchor.textContent === 'named')?.hasAttribute('dir')).toBe(false);
  // The favicon sits before its link in a frame, loads lazily and is not part of the link.
  const favicon = bare?.previousElementSibling;
  expect(favicon?.getAttribute('data-message-image-export-exclude')).toBe('true');
  expect(favicon?.querySelector('img')?.getAttribute('loading')).toBe('lazy');
  expect(bare?.querySelector('img')).toBeNull();
  await act(async () => { favicon?.querySelector('img')?.dispatchEvent(new window.Event('error')); });
  expect(bare?.previousElementSibling?.querySelector('img')).toBeFalsy();
  const footnote = anchors.find((anchor) => anchor.getAttribute('href')?.startsWith('#'));
  const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  footnote?.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(openedLinks).toEqual([]);
});

test('a code block without a language is labelled text', async () => {
  await render('```\nplain\n```');
  expect(host.querySelector('[data-streamdown="code-block-header"]')?.textContent).toContain('text');
});

test('document images with a numeric width and height scale by their ratio; a height alone stays fixed', async () => {
  await render('<img src="https://example.com/a.png" width="1920" height="906"> <img src="https://example.com/b.png" height="28">', false, true);
  const [ratio, fixed] = Array.from(host.querySelectorAll('img'));
  expect(ratio?.style.aspectRatio.replace(/ /g, '')).toBe('1920/906');
  expect(ratio?.style.height).toBe('');
  expect(fixed?.style.height).toBe('28px');
});

test('whole-message plain copy retains Mermaid source after rich normalization', async () => {
  const { renderMarkdownForExport } = await import('./markdown/renderMarkdownForExport');
  const { serializeRenderedMarkdown } = await import('./markdown/selectionMarkdown');
  const source = 'graph TD\n  A[Start] --> B[End]';
  let output: HTMLElement | undefined;
  await act(async () => { output = await renderMarkdownForExport(`\`\`\`mermaid\n${source}\n\`\`\``, { purpose: 'copy' }); });
  expect(output?.querySelector('pre code')?.textContent).toBe(source);
  expect(output && serializeRenderedMarkdown(output, 'plain')).toBe(source);
});

test('code rows and selection preserve intentional trailing blank lines', async () => {
  const { serializeRenderedMarkdown } = await import('./markdown/selectionMarkdown');
  await render('```text\nfirst\n\n\n```');
  expect(Array.from(host.querySelectorAll('pre code > span'), (row) => row.textContent?.replace(/^\n$/, '')).join('\n')).toBe('first\n\n');
  expect(serializeRenderedMarkdown(host, 'markdown')).toContain('first\n\n```');
});

test('table columns preserve short content and allocate remaining width to long content', async () => {
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const bounds = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.tagName === 'TH' || this.tagName === 'TD' ? this.textContent?.includes('long') ? 600 : 120 : 502;
    return new window.DOMRect(0, 0, width, 30);
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 502 });
  try {
    await render('| long heading over short values | long |\n| --- | --- |\n| `id` | `long description` |');
    expect(Array.from(host.querySelectorAll('col'), (col) => col.style.width)).toEqual(['120px', '380px']);
    expect(host.querySelector('td')?.style.getPropertyValue('--oc-table-code-wrap')).toBe('nowrap');
    expect(host.querySelector<HTMLElement>('td:last-child')?.style.getPropertyValue('--oc-table-code-wrap')).toBe('normal');
  } finally {
    bounds.mockRestore();
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    await act(() => root.render(null));
  }
});

test('a streaming table is not measured until the reply settles', async () => {
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 500 });
  let cellReadCount = 0;
  const bounds = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.tagName === 'TD' || this.tagName === 'TH') cellReadCount += 1;
    return new window.DOMRect(0, 0, 120, 30);
  });
  const draw = (live: boolean) => act(() => root.render(React.createElement(I18nProvider, null, React.createElement(Renderer.MarkdownContent, {
    content: '| a | b |\n| --- | --- |\n| 1 | 2 |', mode: 'streaming', isStreaming: live, enableFileReferences: false,
  }))));
  try {
    await draw(true);
    const cellReads = () => cellReadCount;
    expect(cellReads()).toBe(0);
    expect(host.querySelector('table')?.getAttribute('data-oc-table-layout')).toBe('pending');
    await draw(false);
    expect(cellReads()).toBeGreaterThan(0);
    expect(host.querySelector('table')?.getAttribute('data-oc-table-layout')).toBe('fixed');
  } finally {
    bounds.mockRestore();
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    await act(() => root.render(null));
  }
});

test('Mermaid preserves the view across themes and restores controls and ASCII copy', async () => {
  const code = 'sequenceDiagram\n  Start->>End: Hello';
  const content = `\`\`\`mermaid\n${code}\n\`\`\``;
  await render(content);
  const svg = host.querySelector('[data-streamdown="mermaid"] svg');
  expect(svg).not.toBeNull();
  const original = svg?.outerHTML;
  expect(original).toContain('var(--surface-foreground)');
  const toolbar = host.querySelector('[data-streamdown="mermaid-toolbar"]');
  expect(toolbar?.classList.contains('absolute')).toBe(true);
  expect(Array.from(toolbar?.querySelectorAll('button') ?? [], (button) => button.title))
    .toEqual(['Zoom in', 'Zoom out', 'Reset view', 'Copy', 'Download SVG']);

  // An early user action flushes the pending initial fit before the saved view.
  await act(async () => toolbar?.querySelectorAll<HTMLButtonElement>('button')[2]?.click());
  svg?.setAttribute('viewBox', '1 2 30 40');
  currentTheme = getDefaultTheme(true);
  await act(() => root.render(React.createElement(I18nProvider, null, React.createElement(Renderer.SimpleMarkdownRenderer, {
    content, enableFileReferences: false, className: 'theme-check',
  }))));
  expect(host.querySelector('[data-streamdown="mermaid"] svg')).toBe(svg);
  expect(svg?.getAttribute('viewBox')).toBe('1 2 30 40');

  const write = spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  state.mermaidRenderingMode = 'ascii';
  try {
    await act(() => root.render(null));
    await render(content);
    const ascii = host.querySelector('[data-streamdown="mermaid-scroll"] > pre');
    expect(ascii?.textContent).toContain('Start');
    const copy = host.querySelector<HTMLButtonElement>('[data-streamdown="mermaid-toolbar"] button');
    await act(async () => copy?.click());
    expect(write.mock.calls.at(-1)?.[0]).toBe(ascii?.textContent);
    expect(copy?.title).toBe('Copied');
    expect(host.querySelector('[data-streamdown="mermaid-block"]')?.getAttribute('data-mermaid-render')).toBe('ascii');
  } finally {
    write.mockRestore();
    state.mermaidRenderingMode = 'svg';
    currentTheme = getDefaultTheme(false);
  }
});

test('updates safe raw HTML with identical source and retains disclosure identity', async () => {
  const source = '<details><summary>More</summary>Body</details>\n\n<img src="https://example.com/pixel.png" alt="remote">';
  await render(source, false, false);
  const details = host.querySelector('details');
  expect(details).not.toBeNull();
  if (details) details.open = true;
  await render(source, false, true);
  expect(host.querySelector('details') === details).toBe(true);
  expect(host.querySelector('details')?.open).toBe(true);
  // Documents explicitly permit remote images. Media readiness still owns mounting.
});

test('a heading tag in a disclosure summary renders as a heading with and without raw HTML', async () => {
  for (const allowRawHtml of [false, true]) {
    await render('<details><summary><h3>Findings `x`</h3></summary>\n\nBody\n</details>', false, allowRawHtml);
    const heading = host.querySelector('details > summary h3');
    expect(heading?.textContent).toBe('Findings x');
    expect(heading?.querySelector('code')?.textContent).toBe('x');
    expect(host.querySelector('details summary')?.textContent).not.toContain('<h3>');
    expect(host.querySelector('details p')?.textContent).toBe('Body');
  }
  await render('<details><summary>Plain <b>bold</b></summary>Body</details>', false, true);
  expect(host.querySelector('details summary h3, details summary h1')).toBeNull();
  expect(host.querySelector('details summary b')?.textContent).toBe('bold');
});

test('summary heading attributes do not turn the heading into text', async () => {
  for (const allowRawHtml of [false, true]) {
    await render('<details><summary><h2 align="center">Report</h2></summary>\n\nBody\n</details>', false, allowRawHtml);
    expect(host.querySelector('details > summary h2')?.textContent).toBe('Report');
    expect(host.querySelector('details > summary h2')?.hasAttribute('align')).toBe(false);
    expect(host.textContent).not.toContain('<');
  }
});

test('GitHub alerts render as titled callouts in both HTML modes and leave other quotes alone', async () => {
  for (const allowRawHtml of [false, true]) {
    await render('> [!WARNING]\n> Careful **now**\n\n> [!tip]\n>\n> Second\n\n> [!NOTE] trailing text\n\n> Plain quote', false, allowRawHtml);
    const quotes = Array.from(host.querySelectorAll('blockquote'));
    expect(quotes.map((quote) => quote.getAttribute('data-oc-alert'))).toEqual(['warning', 'tip', null, null]);
    expect(quotes[0].querySelector('[data-oc-alert-title]')?.textContent).toBe('Warning');
    expect(quotes[0].querySelector('p:not([data-oc-alert-title])')?.textContent).toBe('Careful now');
    expect(quotes[1].querySelector('[data-oc-alert-title]')?.textContent).toBe('Tip');
    expect(quotes[1].textContent).not.toContain('[!');
    expect(quotes[2].textContent).toContain('[!NOTE] trailing text');
  }
  await render('<blockquote data-oc-alert="warning">Forged</blockquote>', false, true);
  expect(host.querySelector('blockquote')?.hasAttribute('data-oc-alert')).toBe(false);
});

test('item text links its repository references and leaves code, words and paths alone', async () => {
  const { githubLikeDescriptor, gitlabLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const github = { descriptor: githubLikeDescriptor(), origin: 'https://github.com', owner: 'acme', repo: 'app' };
  const draw = (content: string, repositoryLinks: typeof github) => act(async () => root.render(
    React.createElement(I18nProvider, null, React.createElement(Renderer.SimpleMarkdownRenderer, { content, allowRawHtml: true, enableFileReferences: false, repositoryLinks }))));
  const links = () => Array.from(host.querySelectorAll('a')).map((link) => [link.textContent, link.getAttribute('href')]);

  await draw('Fixes #12 and other/lib#3, thanks @octo-cat, see abc1234f.\n\nNot C#5, a@b.com, @scope/pkg, 1234567, defaced, `#9` or [#7](https://x.test/7).', github);
  expect(links()).toEqual([
    ['#12', 'https://github.com/acme/app/issues/12'],
    ['other/lib#3', 'https://github.com/other/lib/issues/3'],
    ['@octo-cat', 'https://github.com/octo-cat'],
    ['abc1234', 'https://github.com/acme/app/commit/abc1234f'],
    // GFM's own email link, never read as a mention.
    ['a@b.com', 'mailto:a@b.com'],
    ['#7', 'https://x.test/7'],
  ]);
  expect(host.querySelector('a[href$="/commit/abc1234f"] code')?.textContent).toBe('abc1234');
  // A host's own references draw without the favicon a pasted link gets.
  expect(host.querySelectorAll('a[data-oc-reference]')).toHaveLength(4);
  expect(host.querySelectorAll('img')).toHaveLength(1);

  // An author's own inline link or code keeps its text; their markup cannot pass as a reference.
  await draw('Fixes <a href="https://x.test/12">#12</a>, <code>abc1234f</code> and <a data-oc-reference href="https://x.test/y">y</a> after #3', github);
  expect(links()).toEqual([
    ['#12', 'https://x.test/12'],
    ['y', 'https://x.test/y'],
    ['#3', 'https://github.com/acme/app/issues/3'],
  ]);
  expect(host.querySelector('a[href="https://x.test/y"]')?.hasAttribute('data-oc-reference')).toBe(false);

  await draw('MR !7 closes #4', { descriptor: gitlabLikeDescriptor(), origin: 'https://gitlab.example.com', owner: 'group', repo: 'app' });
  expect(links()).toEqual([
    ['!7', 'https://gitlab.example.com/group/app/-/merge_requests/7'],
    ['#4', 'https://gitlab.example.com/group/app/-/issues/4'],
  ]);
});

test('a suggestion fence in a review comment draws as a suggested change; elsewhere it stays code', async () => {
  const { MarkdownSuggestionContext } = await import('./markdown/markdownSuggestion');
  const content = 'Try this:\n\n```suggestion:-0+0\n  const c = 5;\n```';
  const draw = (excerpt: { startLine: number; lines: string[] } | null | undefined) => act(async () => root.render(
    React.createElement(I18nProvider, null, React.createElement(MarkdownSuggestionContext.Provider, { value: excerpt === undefined ? null : { excerpt } },
      React.createElement(Renderer.SimpleMarkdownRenderer, { content, allowRawHtml: true, enableFileReferences: false })))));

  await draw({ startLine: 12, lines: ['  const c = 4;'] });
  expect(host.querySelector('[data-streamdown="code-block-header"]')?.textContent).toBe('Suggested change');
  expect(host.querySelector('[data-language="diff"]')?.textContent).toContain('const c = 4;');
  // Copying takes the suggested code itself.
  expect(host.querySelector('[data-oc-code-source]')?.getAttribute('data-oc-code-source')).toBe('  const c = 5;');

  await draw(undefined);
  expect(host.querySelector('[data-streamdown="code-block-header"]')?.textContent).toBe('suggestion:-0+0');
  expect(host.querySelector('[data-language="diff"]')).toBeNull();
});

test('emoji shortcodes read as emoji in text, never in code, and unknown names stay', async () => {
  const { loadEmojiShortcodes, mayHoldEmojiShortcode } = await import('@/lib/emoji/shortcodes');
  const emojiShortcodes = await loadEmojiShortcodes();
  const content = 'Shipped :tada: :rocket: at 12:30:45 :not_an_emoji:\n\n`:tada:`';
  expect(mayHoldEmojiShortcode(content)).toBe(true);
  expect(mayHoldEmojiShortcode('at 12:30')).toBe(false);
  await act(async () => root.render(React.createElement(I18nProvider, null,
    React.createElement(Renderer.SimpleMarkdownRenderer, { content, enableFileReferences: false, emojiShortcodes }))));
  expect(host.querySelector('p')?.textContent).toBe('Shipped 🎉 🚀 at 12:30:45 :not_an_emoji:');
  expect(host.querySelector('code')?.textContent).toBe(':tada:');
});

test('handles empty, shrink and same-length replacement without stale text', async () => {
  await render('first');
  await render('other');
  expect(host.textContent).toBe('other');
  await render('x');
  expect(host.textContent).toBe('x');
  await render('');
  expect(host.textContent).toBe('');
});

test('chooses static history and preserves the live block tree through settlement', async () => {
  const source = 'Stable prefix.\n\n```text\none\ntwo';
  const draw = async (content: string, isStreaming: boolean, messageId = 'message') => {
    await act(() => root.render(React.createElement(I18nProvider, null, React.createElement(Renderer.MarkdownRenderer, { content, isStreaming, messageId, isAnimated: false, enableFileReferences: false }))));
  };
  await draw('Finished history.\n\n![remote](https://example.com/history.png)', false, 'history');
  expect(host.querySelector('[data-oc-markdown-block]')).toBeNull();
  expect(host.querySelector('img')).toBeNull();
  expect(host.querySelector('[data-oc-media-label]')?.textContent).toBe('history.png');
  await draw(source, true);
  const prefix = host.querySelector('p');
  const block = host.querySelector('[data-oc-markdown-block]');
  expect(block).not.toBeNull();
  expect(host.querySelector('[data-streamdown="code-block"] button')).not.toBeNull();
  await draw(source + '\n```', false);
  expect(host.querySelector('p') === prefix).toBe(true);
  expect(host.querySelector('[data-oc-markdown-block]')).toBe(block);
  expect(host.querySelector('[data-oc-code-source]')?.getAttribute('data-oc-code-source')).toBe('one\ntwo');
  await draw('Other history.', false, 'other');
  expect(host.querySelector('[data-oc-markdown-block]')).toBeNull();
});

test('native copy uses the selected Markdown and current plain-text setting', async () => {
  await render('**chosen** and unselected');
  const strong = host.querySelector('strong');
  if (!strong) throw new Error('Expected strong text');
  const selection = document.getSelection();
  const range = document.createRange(); range.selectNode(strong);
  selection?.removeAllRanges(); selection?.addRange(range);
  const copied = new Map<string, string>();
  const copy = () => {
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => copied.set(type, value) } });
    strong.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };
  copy();
  expect(copied.get('text/plain')).toBe('**chosen**');
  expect(copied.get('text/html')).toContain('<strong>chosen</strong>');
  state.copyMessagesAsPlainText = true;
  copy();
  expect(copied.get('text/plain')).toBe('chosen');
  state.copyMessagesAsPlainText = false;
  selection?.removeAllRanges();
});

test('ordinary code copy and desktop menu use raw selected source under both prose settings', async () => {
  await render('```text\nalpha\nbeta\n\n```');
  const code = host.querySelector('pre code');
  if (!code) throw new Error('Missing native code');
  const range = document.createRange(); range.selectNodeContents(code);
  document.getSelection()?.removeAllRanges(); document.getSelection()?.addRange(range);
  const write = spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  try {
    for (const plain of [false, true]) {
      state.copyMessagesAsPlainText = plain;
      const copied = new Map<string, string>();
      const event = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, text: string) => copied.set(type, text) } });
      code.dispatchEvent(event);
      expect(copied.get('text/plain')).toBe('alpha\nbeta\n');
      expect(copied.has('text/html')).toBe(false);
      const menu = new Event('openchamber:copy', { cancelable: true });
      window.dispatchEvent(menu);
      expect(menu.defaultPrevented).toBe(true);
      expect(write.mock.calls.at(-1)).toEqual(['alpha\nbeta\n']);
    }
  } finally { write.mockRestore(); state.copyMessagesAsPlainText = false; document.getSelection()?.removeAllRanges(); }
});

test('mixed rich copy clips code at both ends and preserves full middle source', async () => {
  await render(['alpha', 'middle', 'omega'].map((code) => `\`\`\`text\n${code}\n\n\n\`\`\``).join('\n\n'));
  const owners = host.querySelectorAll('[data-oc-code-source]');
  const first = owners[0]?.querySelector('code span span')?.firstChild;
  const last = owners[2]?.querySelector('code span span')?.firstChild;
  if (!first || !last) throw new Error('Missing native code text');
  const range = document.createRange();
  range.setStart(first, 2);
  range.setEnd(last, 3);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const copied = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => copied.set(type, value) } });
  try {
    first.parentElement?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(copied.get('text/plain')).toBe('```\npha\n\n```\n\n```\nmiddle\n\n```\n\n```\nome\n```');
    const recipient = document.createElement('template');
    recipient.innerHTML = copied.get('text/html') ?? '';
    expect(Array.from(recipient.content.querySelectorAll('pre code'), (code) => code.textContent)).toEqual(['pha\n\n', 'middle\n\n', 'ome']);
    expect(Array.from(owners, (owner) => owner.getAttribute('data-oc-code-source'))).toEqual(['alpha\n\n', 'middle\n\n', 'omega\n\n']);
  } finally {
    selection?.removeAllRanges();
  }
});

test('desktop prose menu follows the copy setting and prevents the menu fallback', async () => {
  await render('**menu**');
  const strong = host.querySelector('strong');
  if (!strong) throw new Error('Missing prose');
  const range = document.createRange(); range.selectNode(strong);
  document.getSelection()?.removeAllRanges(); document.getSelection()?.addRange(range);
  const write = spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  try {
    for (const plain of [false, true]) {
      state.copyMessagesAsPlainText = plain;
      const menu = new Event('openchamber:copy', { cancelable: true });
      window.dispatchEvent(menu);
      expect(menu.defaultPrevented).toBe(true);
      expect(write.mock.calls.at(-1)).toEqual([plain ? 'menu' : '**menu**']);
    }
  } finally { write.mockRestore(); state.copyMessagesAsPlainText = false; document.getSelection()?.removeAllRanges(); }
});

test('wrap settings update the actual Markdown root without replacing content', async () => {
  await render('same source');
  const paragraph = host.querySelector('p');
  const markdown = host.querySelector('[data-markdown-content]');
  expect(markdown?.hasAttribute('dir')).toBe(false);
  expect(markdown?.getAttribute('data-code-wrap')).toBe('false');
  state.codeBlockLineWrap = true;
  state.tableCellWrap = false;
  await act(() => root.render(React.createElement(I18nProvider, null, React.createElement(Renderer.MarkdownContent, { content: 'same source', enableFileReferences: false }))));
  expect(host.querySelector('[data-markdown-content]')?.getAttribute('data-code-wrap')).toBe('true');
  expect(host.querySelector('[data-markdown-content]')?.getAttribute('data-table-wrap')).toBe('false');
  // The wrappers differ in this fixture; subsequent same-source changes retain identity.
  const stable = host.querySelector('p');
  state.codeBlockLineWrap = false;
  await act(() => root.render(React.createElement(I18nProvider, null, React.createElement(Renderer.MarkdownContent, { content: 'same source', enableFileReferences: false }))));
  expect(host.querySelector('p') === stable).toBe(true);
  expect(paragraph?.textContent).toBe('same source');
  state.tableCellWrap = true;
});

test('same-source theme repaint keeps nodes and publishes syntax variables on the consumer root', async () => {
  await render('theme text');
  const paragraph = host.querySelector('p');
  const oldColor = host.querySelector<HTMLElement>('[data-markdown-content]')?.style.getPropertyValue('--md-syntax-keyword');
  currentTheme = getDefaultTheme(true);
  // A parent theme context update redraws the shared renderer with the same source.
  await act(() => root.render(React.createElement(I18nProvider, null, React.createElement(Renderer.SimpleMarkdownRenderer, { content: 'theme text', enableFileReferences: false, className: 'theme-fixture' }))));
  const markdown = host.querySelector<HTMLElement>('[data-markdown-content]');
  expect(host.querySelector('p') === paragraph).toBe(true);
  expect(markdown?.style.getPropertyValue('--md-syntax-keyword')).toBe(currentTheme.colors.syntax.base.keyword);
  expect(markdown?.style.getPropertyValue('--md-syntax-keyword')).not.toBe(oldColor);
  currentTheme = getDefaultTheme(false);
});

test('only blocks the stream commits after mount enter, never the first, cascading by 55ms', async () => {
  await act(() => root.render(null));
  const draw = (content: string, live: boolean) => act(() => root.render(React.createElement(I18nProvider, null,
    React.createElement(Renderer.MarkdownContent, { content, mode: 'streaming', isStreaming: live, enableFileReferences: false }))));
  const entering = () => Array.from(host.querySelectorAll<HTMLElement>('.oc-md-block-enter'));
  // A message that mounts mid-stream shows what it already holds without a reveal.
  await draw('First.\n\nSecond.', true);
  expect(entering()).toHaveLength(0);
  await draw('First.\n\nSecond.\n\nThird.\n\nFourth.\n\nFifth.\n\nSixth.\n\nSeventh.\n\nEighth.', true);
  const blocks = entering();
  expect(blocks.map((block) => block.textContent)).toEqual(['Third.', 'Fourth.', 'Fifth.', 'Sixth.', 'Seventh.', 'Eighth.']);
  expect(blocks.map((block) => block.style.getPropertyValue('--oc-md-enter-delay'))).toEqual(['', '55ms', '110ms', '165ms', '220ms', '220ms']);
  const third = blocks[0];
  await draw('First.\n\nSecond.\n\nThird.\n\nFourth.\n\nFifth.\n\nSixth.\n\nSeventh.\n\nEighth.', false);
  expect(entering()[0]).toBe(third);
  await act(() => root.render(null));
  // A fresh streamed reply: the first block never shimmers, the second does.
  await draw('One.', true);
  await draw('One.\n\nTwo.', true);
  expect(entering().map((block) => block.textContent)).toEqual(['Two.']);
});

test('exports the shared Markdown renderer with bounded real highlighting and no media requests or controls', async () => {
  const { renderMarkdownForExport } = await import('./markdown/renderMarkdownForExport');
  const source = '**bold**\n\n```typescript\nconst value = 1;\n\n\n```\n\n```javascript\nconst value = 1;\n\n\n```\n\n![remote](https://example.com/pixel.png)';
  const fallbackSource = 'plain fallback\n'.repeat(1201).trimEnd();
  const imageSource = `${source}\n\n\`\`\`text\n\`\`\`\n\n\`\`\`typescript\n${fallbackSource}\n\`\`\``;
  const before = document.body.childElementCount;
  let copied: HTMLElement | undefined;
  await act(async () => { copied = await renderMarkdownForExport(source, { purpose: 'copy' }); });
  expect(copied?.querySelector('strong')?.textContent).toBe('bold');
  expect(copied?.querySelector('button,video,source') === null).toBe(true);
  expect(copied?.querySelector('pre code')?.textContent).toBe('const value = 1;\n\n');
  expect(document.body.childElementCount).toBe(before);
  let image: HTMLElement | undefined;
  // The export helper synchronously commits its own temporary root.
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: false });
  try { image = await renderMarkdownForExport(imageSource, { purpose: 'image' }); }
  finally { Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true }); }
  expect(image?.querySelector('code span[style*="color"]')).not.toBeNull();
  const cards = Array.from(image?.querySelectorAll('[data-streamdown="code-block"]') ?? []);
  expect(cards).toHaveLength(4);
  expect(cards.slice(0, 2).every((card) => card.querySelector('code span[style*="color"]'))).toBe(true);
  expect(Array.from(cards[0].querySelectorAll('code > span'), (row) => row.textContent?.replace(/^\n$/, '')).join('\n')).toBe('const value = 1;\n\n');
  expect(cards[2].querySelector('code')?.textContent?.trim()).toBe('');
  const fallbackRows = Array.from(cards[3].querySelectorAll('code > span'), (row) => row.textContent);
  expect(fallbackRows.join('\n')).toBe(fallbackSource);
  expect(image?.querySelector('button,img,video,source')).toBeNull();
  expect(document.body.childElementCount).toBe(before);
}, 15000);

test('copy and image exports never publish signed media sources or no-title video URLs', async () => {
  const { renderMarkdownForExport } = await import('./markdown/renderMarkdownForExport');
  const source = ['![image](https://host.test/pic.png?oc_url_token=URL_SECRET)', '![video](https://host.test/demo.mp4?oc_client_token=CLIENT_SECRET)', 'https://host.test/clip.mp4?oc_url_token=NO_TITLE_SECRET'].join('\n\n');
  for (const purpose of ['copy', 'image'] as const) {
    let output: HTMLElement | undefined;
    await act(async () => { output = await renderMarkdownForExport(source, { purpose }); });
    expect(output?.innerHTML).not.toContain('SECRET');
    expect(output?.innerHTML).not.toContain('oc_url_token');
    expect(output?.innerHTML).not.toContain('oc_client_token');
    expect(output?.querySelector('img,video,source')).toBeNull();
    expect(output?.textContent).toContain('clip.mp4');
  }
});

test('native rich selection normalization keeps safe original media and ordinary URL query parameters', async () => {
  await render('**rich** ![signed](https://host.test/image.png?oc_client_token=NATIVE_SECRET) [ordinary](https://example.test/page?tracking=keep)', false, false);
  const paragraph = host.querySelector('p');
  if (!paragraph) throw new Error('Missing selected paragraph');
  const range = document.createRange(); range.selectNode(paragraph);
  document.getSelection()?.removeAllRanges(); document.getSelection()?.addRange(range);
  for (const plain of [false, true]) {
    state.copyMessagesAsPlainText = plain;
    const copied = new Map<string, string>();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, text: string) => copied.set(type, text) } });
    paragraph.dispatchEvent(event);
    expect(copied.get('text/html')).toContain('<strong>rich</strong>');
    expect(copied.get('text/html')).not.toContain('NATIVE_SECRET');
    expect(copied.get('text/html')).toContain('tracking=keep');
    expect(copied.get('text/plain')).not.toContain('NATIVE_SECRET');
  }
  state.copyMessagesAsPlainText = false;
  document.getSelection()?.removeAllRanges();
});

test('rich prose-to-partial-code selection cannot expand to the unselected code tail', async () => {
  await render('Selected **prose**.\n\n```text\nfirst\nUNSELECTED_TAIL\n```');
  const paragraph = host.querySelector('p');
  const firstLine = host.querySelector('pre code > span');
  if (!paragraph || !firstLine) throw new Error('Missing partial selection nodes');
  const liveHtml = host.innerHTML;
  const range = document.createRange(); range.setStart(paragraph, 0); range.setEnd(firstLine, firstLine.childNodes.length);
  document.getSelection()?.removeAllRanges(); document.getSelection()?.addRange(range);
  const copied = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, text: string) => copied.set(type, text) } });
  paragraph.dispatchEvent(event);
  expect(copied.get('text/plain')).toContain('first');
  expect(copied.get('text/plain')).not.toContain('UNSELECTED_TAIL');
  expect(copied.get('text/html')).toContain('first');
  expect(copied.get('text/html')).not.toContain('UNSELECTED_TAIL');
  expect(host.innerHTML).toBe(liveHtml);
  document.getSelection()?.removeAllRanges();
});

test('shared raw-document export components use name-only fallback for signed videos without titles', async () => {
  for (const purpose of ['copy', 'image'] as const) {
    await act(() => root.render(React.createElement(I18nProvider, null, React.createElement(Renderer.MarkdownContent, {
      content: '<video src="https://host.test/clip.mp4?oc_url_token=RAW_SECRET&oc_client_token=OTHER_SECRET"></video>',
      allowRawHtml: true, purpose, enableFileReferences: false,
    }))));
    expect(host.textContent).toBe('clip.mp4');
    expect(host.innerHTML).not.toContain('SECRET');
    expect(host.querySelector('[data-oc-media-source]')).toBeNull();
    expect(host.querySelector('video')).toBeNull();
  }
});
