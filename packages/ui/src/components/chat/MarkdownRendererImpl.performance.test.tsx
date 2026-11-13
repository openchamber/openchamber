import { afterAll, expect, spyOn, test } from 'bun:test';
import type { HighlightResult } from 'streamdown';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost/' });
const requests: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  requests.push(url);
  const payload = url.includes('/api/fs/stat') ? { exists: true } : url.includes('/api/location') ? { directory: '/reference-test', project: { directory: '/reference-test' } } : url.includes('/api/session') ? [] : {};
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
};
browser.document.write('<!doctype html><html><head></head><body></body></html>');
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, HTMLElement: browser.HTMLElement,
  HTMLAnchorElement: browser.HTMLAnchorElement, Element: browser.Element, Node: browser.Node, Text: browser.Text,
  SVGElement: browser.SVGElement, customElements: browser.customElements, MutationObserver: browser.MutationObserver,
  DOMParser: browser.DOMParser, XMLSerializer: browser.XMLSerializer, IntersectionObserver: browser.IntersectionObserver,
  ResizeObserver: browser.ResizeObserver });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const { MarkdownContent } = await import('./MarkdownRendererImpl');
const { I18nProvider } = await import('@/lib/i18n');
const { createMarkdownCodePlugin } = await import('./markdown/streamdownCode');
const { streamdownCodeWorker } = await import('./markdown/streamdownCodeWorker');
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
afterAll(async () => { await act(() => root.unmount()); browser.happyDOM.abort(); globalThis.fetch = realFetch; });

test('the original settled, open-fence and VS Code line budgets preserve readable source', () => {
  for (const [isVSCode, isIncomplete, lines] of [[false, false, 1201], [false, true, 301], [true, false, 201]] as const) {
    const plugin = createMarkdownCodePlugin({ isVSCode });
    const code = Array.from({ length: lines }, () => 'const value = 1;').join('\n');
    const result = plugin.highlight({ code, language: 'typescript', isIncomplete, themes: plugin.getThemes() });
    expect(result).not.toBeNull();
    expect(result?.tokens.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(code);
  }
});

test('streaming stable prefix retains selection, disclosure and scroll through append and settlement', async () => {
  const prefix = '<details><summary>Read more</summary>Stable body</details>\n\nStable paragraph.\n\n';
  const draw = async (tail: string, isStreaming: boolean) => act(() => root.render(<I18nProvider>
    <MarkdownContent content={prefix + tail} mode="streaming" isStreaming={isStreaming} purpose="copy" enableFileReferences={false} />
  </I18nProvider>));
  await draw('Tail', true);
  const paragraph = host.querySelector('p');
  const details = host.querySelector('details');
  if (!paragraph || !details) throw new Error('Expected native Markdown content');
  details.open = true;
  host.scrollTop = 100;
  const range = document.createRange(); range.selectNodeContents(paragraph);
  document.getSelection()?.addRange(range);
  const selected = document.getSelection()?.toString();
  await draw('Tail grows.', true);
  await draw('Tail grows.', false);
  expect(host.querySelector('p') === paragraph).toBe(true);
  expect(host.querySelector('details') === details).toBe(true);
  expect(details.open).toBe(true);
  expect(document.getSelection()?.toString()).toBe(selected);
  expect(host.scrollTop).toBe(100);
});

test('warm code is highlighted at the first layout commit and source changes never commit stale text', async () => {
  const source = 'const warmCode = "中文";';
  const highlighted = await streamdownCodeWorker.highlight(source, 'typescript', false);
  expect(highlighted).not.toBeNull();
  const commits: Array<{ text: string; colored: boolean }> = [];
  function Capture({ code, language }: { code: string; language: string }) {
    React.useLayoutEffect(() => {
      const body = host.querySelector('[data-streamdown="code-block-body"]');
      commits.push({ text: body?.textContent ?? '', colored: !!body?.querySelector('span[style*="color"]') });
    }, [code, language]);
    return <I18nProvider><MarkdownContent content={`\`\`\`${language}\n${code}\n\`\`\``}
      mode="streaming" enableFileReferences={false} /></I18nProvider>;
  }
  await act(() => root.render(<Capture code={source} language="typescript" />));
  expect(commits[0]).toEqual({ text: source, colored: true });
  const firstRow = host.querySelector('[data-streamdown="code-block-body"] code > span');
  const appended = source + '\nconst appended = 2;';
  await streamdownCodeWorker.highlight(appended, 'typescript', false);
  await act(() => root.render(<Capture code={appended} language="typescript" />));
  expect(host.querySelector('[data-streamdown="code-block-body"] code > span')).toBe(firstRow);
  await act(() => root.render(<Capture code="replacement" language="unknown-language" />));
  expect(commits.at(-1)?.text).toBe('replacement');
});

test('append results advance while newer requests are pending without resetting highlighted nodes', async () => {
  await act(() => root.render(null));
  const prefix = 'const stable = 1;\n';
  const original = prefix + 'let tail';
  const colored: HighlightResult = { tokens: [
    [{ content: 'const', color: 'var(--syntax-keyword)' }, { content: ' stable = 1;', color: 'var(--syntax-string)' }],
    [{ content: 'let', color: 'var(--syntax-keyword)' }, { content: ' tail' }],
  ] };
  const pending = new Map<string, (result: HighlightResult | null) => void>();
  const lookup = spyOn(streamdownCodeWorker, 'cached').mockImplementation((code, language) => (
    code === original && language === 'typescript' ? colored : undefined
  ));
  const highlight = spyOn(streamdownCodeWorker, 'highlight').mockImplementation((code, language) => (
    code === original && language === 'typescript'
      ? Promise.resolve(colored)
      : new Promise((resolve) => { pending.set(code, resolve); })
  ));
  const draw = (code: string, language = 'typescript', directory = '/prefix-test') => act(() => root.render(
    <I18nProvider><MarkdownContent content={`\`\`\`${language}\n${code}\n\`\`\``}
      mode="streaming" settled={false} directory={directory} enableFileReferences={false} /></I18nProvider>,
  ));
  const text = () => Array.from(host.querySelectorAll('pre code > span'), (row) => row.textContent === '\n' ? '' : row.textContent).join('\n');
  try {
    await draw(original);
    const first = host.querySelector('pre code > span');
    const token = first?.lastChild;
    if (!first || !token) throw new Error('Missing highlighted prefix');
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(first, { subtree: true, childList: true, characterData: true, attributes: true });
    try {
      const appended = prefix + 'let tail = 2;';
      await draw(appended);
      expect(text()).toBe(original);
      expect(first.lastChild === token).toBe(true);
      const latest = appended + '\nnext();';
      await draw(latest);
      expect(text()).toBe(original);
      await act(async () => { pending.get(appended)?.({ tokens: [colored.tokens[0], [{ content: 'let tail = 2;' }]] }); });
      expect(text()).toBe(appended);
      expect(first.lastChild === token).toBe(true);
      await act(async () => { pending.get(latest)?.({ tokens: [colored.tokens[0], [{ content: 'let tail = 2;' }], [{ content: 'next();' }]] }); });
      expect(text()).toBe(latest);
      expect(first.lastChild === token).toBe(true);
      expect([...mutations, ...observer.takeRecords()]).toHaveLength(0);
      const stale = latest + '\nold();';
      await draw(stale);
      const edited = prefix + 'let replaced = 3;';
      await draw(edited);
      expect(text()).toBe(edited);
      await act(async () => { pending.get(stale)?.({ tokens: [[{ content: 'obsolete' }]] }); });
      expect(text()).toBe(edited);
      await draw(prefix);
      expect(text()).toBe(prefix);
      await draw('const stable = changed;\n');
      expect(text()).toBe('const stable = changed;\n');
      expect(host.querySelector('pre code span[style*="color"]')).toBeNull();
      await draw(original);
      await draw(prefix, 'javascript');
      expect(text()).toBe(prefix);
      expect(host.querySelector('pre code span[style*="color"]')).toBeNull();
      await draw(original);
      await draw(prefix + 'other', 'typescript', '/other-context');
      expect(host.querySelector('pre code span[style*="color"]')).toBeNull();
      await draw(original);
      const slow = original + ' slow';
      const fast = slow + ' fast';
      await draw(slow);
      await draw(fast);
      await act(async () => { pending.get(fast)?.({ tokens: fast.split('\n').map((content) => [{ content }]) }); });
      await act(async () => { pending.get(slow)?.({ tokens: slow.split('\n').map((content) => [{ content }]) }); });
      expect(text()).toBe(fast);
      const failed = fast + ' failed';
      await draw(failed);
      await act(async () => { pending.get(failed)?.(null); });
      expect(text()).toBe(failed);
      await draw(original);
      const abandoned = original + ' abandoned';
      await draw(abandoned);
      const abandonedReply = pending.get(abandoned);
      await draw('replacement');
      await draw(original + ' abandoned again');
      await act(async () => { abandonedReply?.({ tokens: [[{ content: 'obsolete lineage' }]] }); });
      expect(text()).toBe(original + ' abandoned again');
      await draw(original);
      const overBudget = prefix + 'line\n'.repeat(1200);
      await draw(overBudget);
      expect(text()).toBe(overBudget);
      expect(host.querySelector('pre code span[style*="color"]')).toBeNull();
    } finally { observer.disconnect(); }
  } finally {
    await act(() => root.render(null));
    lookup.mockRestore();
    highlight.mockRestore();
  }
});

test('confirmed fenced paths span syntax tokens and survive repeat highlight without consuming later fences', async () => {
  const content = '`inline.ts:2`\n\n```typescript\nsrc/first.ts:12\n```\n\n```typescript\nsrc/second.ts:20:3\n```';
  const draw = (directory: string, live: boolean) => act(() => root.render(<I18nProvider><MarkdownContent content={content} directory={directory} mode="streaming" isStreaming={live} settled={!live} /></I18nProvider>));
  await draw('/reference-test', true);
  expect(requests.some((url) => url.includes('/api/fs/stat'))).toBe(false);
  await draw('/reference-test', false);
  for (let attempt = 0; attempt < 100 && host.querySelectorAll('[data-openchamber-file-ref="src/second.ts:20:3"]').length === 0; attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  expect(host.querySelector('[data-openchamber-file-ref="inline.ts:2"]')?.getAttribute('data-openchamber-file-path')).toBe('/reference-test/inline.ts');
  expect(host.querySelector('[data-openchamber-file-ref="src/first.ts:12"]')?.getAttribute('data-openchamber-file-path')).toBe('/reference-test/src/first.ts');
  expect(host.querySelector('[data-openchamber-file-ref="src/second.ts:20:3"]')?.getAttribute('data-openchamber-file-path')).toBe('/reference-test/src/second.ts');
  const count = requests.filter((url) => url.includes('/api/fs/stat')).length;
  await draw('/reference-test', false);
  expect(host.querySelector('[data-openchamber-file-ref="src/second.ts:20:3"]')).not.toBeNull();
  expect(requests.filter((url) => url.includes('/api/fs/stat')).length).toBe(count);
}, 10000);

test('Plan-style document assets resolve relative media while raw HTML stays inert', async () => {
  const before = requests.length;
  // happy-dom's observer never reports, and a document image waits until it is near the view.
  const observer = Object.getOwnPropertyDescriptor(browser, 'IntersectionObserver');
  Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: undefined });
  try {
    await act(() => root.render(<I18nProvider><MarkdownContent content={'![plan](./diagram.png)\n\n<div>inert HTML</div>'}
      allowRawHtml={false} enableFileReferences={false} directory="/project"
      documentAssets={{ filePath: '/plans/current/plan.md', workspaceRoot: '/project', colorScheme: 'light', onOpenFile: () => undefined }} />
    </I18nProvider>));
    for (let attempt = 0; attempt < 30 && !requests.slice(before).some((url) => url.includes('/api/fs/raw')); attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const raw = requests.slice(before).find((url) => url.includes('/api/fs/raw'));
    expect(raw ? new URL(raw, 'http://localhost').searchParams.get('path') : null).toBe('/plans/current/diagram.png');
    expect(host.textContent).toContain('<div>inert HTML</div>');
  } finally {
    if (observer) Object.defineProperty(browser, 'IntersectionObserver', observer);
    else Reflect.deleteProperty(browser, 'IntersectionObserver');
  }
});
