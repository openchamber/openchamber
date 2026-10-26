import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';

const dom = new Window({ url: 'http://localhost/' });
const originalFetch = globalThis.fetch;
const bootstrapFetch: typeof fetch = async () => Response.json({
  home: '/project', directory: '/project', project: { directory: '/project' },
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  fetch: bootstrapFetch,
});

const { getMarkdownSelectionText, renderedMarkdownHtmlToPlainText, serializeRenderedMarkdown, normalizeMarkdownCopyContent } = await import('./selectionMarkdown');
const { rangeToMarkdown } = await import('../message/selectionMarkdown');

afterEach(() => document.body.replaceChildren());
afterAll(() => { globalThis.fetch = originalFetch; return dom.happyDOM.close(); });

const render = (html: string): HTMLElement => {
  const root = document.createElement('div');
  root.setAttribute('data-markdown-content', '');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
};

const selectionOf = (start: Node, startOffset: number, end: Node, endOffset: number): Range => {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  return range;
};

const isText = (node: Node | null | undefined): node is Text => node?.nodeType === 3;

const textIn = (root: Element, selector: string): Text => {
  const node = root.querySelector(selector)?.firstChild;
  if (!isText(node)) throw new Error(`no text in ${selector}`);
  return node;
};

test('whole blocks serialize to their markdown form', () => {
  const root = render([
    '<h2>Plan</h2>',
    '<p>Run <code>bun test</code> and read <a href="https://example.com/docs">the docs</a>, <strong>not</strong> <em>guess</em>.</p>',
    '<ul><li>first</li><li>second<ul><li>nested</li></ul></li></ul>',
    '<ol start="3"><li>three</li><li>four</li></ol>',
    '<blockquote><p>quoted</p></blockquote>',
    '<hr>',
  ].join(''));

  expect(serializeRenderedMarkdown(root)).toBe([
    '## Plan',
    'Run `bun test` and read [the docs](https://example.com/docs), **not** *guess*.',
    '- first\n- second\n  - nested',
    '3. three\n4. four',
    '> quoted',
    '---',
  ].join('\n\n'));
});

test('native code blocks reconstruct token rows without their toolbar', () => {
  const root = render(
    '<div data-streamdown="code-block"><div data-streamdown="code-block-header"><span>ts</span></div><div data-streamdown="code-block-actions"><button>Copy</button></div>'
    + '<div data-streamdown="code-block-body" data-language="ts"><pre><code>'
    + '<span class="block"><span style="color:red">const</span> a = 1;</span><span class="block">\n</span><span class="block">a += 1;</span>'
    + '</code></pre></div></div>',
  );

  expect(serializeRenderedMarkdown(root)).toBe('```ts\nconst a = 1;\n\na += 1;\n```');
});

test('tables, math, mermaid and file links read from what the renderer kept', () => {
  const root = render([
    '<div data-streamdown="table-wrapper"><div><button>Copy</button></div>'
    + '<div><table><colgroup><col></colgroup><thead><tr><th>Name</th><th>Value</th></tr></thead>'
    + '<tbody><tr><td>a|b</td><td><code>1</code></td></tr></tbody></table></div></div>',
    '<p>Within <span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow>'
    + '<annotation encoding="application/x-tex">\\pm 5\\%</annotation></semantics></math></span>'
    + '<span class="katex-html" aria-hidden="true">±5%</span></span> of <a href="#" data-openchamber-file-link="true">src/app.ts</a>.</p>',
    '<div data-streamdown="mermaid-block" data-oc-mermaid-source="graph TD; A-->B"><div><svg></svg></div>'
    + '<div><button>Copy</button></div></div>',
  ].join(''));

  expect(serializeRenderedMarkdown(root)).toBe([
    '| Name | Value |\n| --- | --- |\n| a\\|b | `1` |',
    'Within $\\pm 5\\%$ of src/app.ts.',
    '```mermaid\ngraph TD; A-->B\n```',
  ].join('\n\n'));
});

test('a selection across list items stays a list', () => {
  const root = render('<p>Intro</p><ul><li>alpha one</li><li>beta two</li><li>gamma</li></ul>');
  const range = selectionOf(textIn(root, 'li:nth-child(1)'), 6, textIn(root, 'li:nth-child(2)'), 4);

  expect(getMarkdownSelectionText(range)).toBe('- one\n- beta');
});

test('part of one list item copies as its text, without the list marker', () => {
  const root = render('<ol><li><p>first</p></li><li><p><strong>Second</strong> item. This time the model</p></li></ol>');
  const item = root.querySelector('li:nth-child(2) p')?.lastChild;
  if (!isText(item)) throw new Error('no item text');

  expect(getMarkdownSelectionText(selectionOf(item, 7, item, 26))).toBe('This time the model');
});

test('part of one table cell copies as its text, not a table', () => {
  const root = render('<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>some cell text</td></tr></tbody></table>');
  const range = selectionOf(textIn(root, 'td'), 5, textIn(root, 'td'), 9);

  expect(getMarkdownSelectionText(range)).toBe('cell');
});

test('a selection across table cells stays a table', () => {
  const root = render('<table><tbody><tr><td>left</td><td>right</td></tr></tbody></table>');
  const range = selectionOf(textIn(root, 'td:nth-child(1)'), 0, textIn(root, 'td:nth-child(2)'), 5);

  expect(getMarkdownSelectionText(range)).toBe('| left | right |\n| --- | --- |');
});

test('a selection inside bold text drops the emphasis it started in', () => {
  const root = render('<p>This is <strong>very important</strong> text.</p>');
  const range = selectionOf(textIn(root, 'strong'), 5, textIn(root, 'strong'), 14);

  expect(getMarkdownSelectionText(range)).toBe('important');
});

test('formatting inside the selection is kept', () => {
  const root = render('<p>Run <code>bun test</code> and <strong>stop</strong> there.</p>');
  const range = selectionOf(textIn(root, 'p'), 0, root.querySelector('p')?.lastChild ?? root, 6);

  expect(getMarkdownSelectionText(range)).toBe('Run `bun test` and **stop** there');
});

test('a selection from prose into a table produces both blocks', () => {
  const root = render('<p>Before the table</p><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>cell</td></tr></tbody></table>');
  const range = selectionOf(textIn(root, 'p'), 7, textIn(root, 'td'), 4);

  expect(getMarkdownSelectionText(range)).toBe('the table\n\n| H |\n| --- |\n| cell |');
});

test('selections outside one markdown root are left to the browser', () => {
  const first = render('<p>one</p>');
  const second = render('<p>two</p>');
  const outside = document.createElement('div');
  outside.innerHTML = '<p>plain</p>';
  document.body.appendChild(outside);
  const plain = textIn(outside, 'p');

  expect(getMarkdownSelectionText(selectionOf(textIn(first, 'p'), 0, textIn(second, 'p'), 3))).toBeNull();
  expect(getMarkdownSelectionText(selectionOf(plain, 0, plain, 5))).toBeNull();
});

test('the plain reading drops Markdown syntax but keeps structure', () => {
  const root = render([
    '<h2>Plan</h2>',
    '<p>Run <code>bun test</code> and read <a href="https://example.com/docs">the docs</a>, <strong>not</strong> <em>guess</em>.</p>',
    '<ul><li>first</li><li>second<ul><li>nested</li></ul></li></ul>',
    '<ol start="3"><li>three</li><li>four</li></ol>',
    '<blockquote><p>quoted</p></blockquote>',
    '<hr>',
    '<pre><code class="language-ts">const a = 1;\n</code></pre>',
    '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a|b</td><td><code>1</code></td></tr></tbody></table>',
  ].join(''));

  expect(serializeRenderedMarkdown(root, 'plain')).toBe([
    'Plan',
    'Run bun test and read the docs, not guess.',
    '• first\n• second\n  • nested',
    '3. three\n4. four',
    'quoted',
    'const a = 1;',
    'Name\tValue\na|b\t1',
  ].join('\n\n'));
});

test('a plain selection across list items keeps the visible bullets', () => {
  const root = render('<ul><li>alpha <strong>one</strong></li><li>beta two</li></ul>');
  const range = selectionOf(textIn(root, 'li:nth-child(1)'), 0, textIn(root, 'li:nth-child(2)'), 4);

  expect(getMarkdownSelectionText(range, 'plain')).toBe('• alpha one\n• beta');
});

test('rendered HTML from the copy button reads as plain text', () => {
  const html = '<h1>Title</h1><p>Use <strong>bold</strong> and <a href="https://example.com">a link</a>.</p><pre><code>x = 1\n</code></pre>';

  expect(renderedMarkdownHtmlToPlainText(html, document)).toBe('Title\n\nUse bold and a link.\n\nx = 1');
});

test('an assistant image copies as the Markdown the message wrote, label or drawn', () => {
  const root = render([
    '<p>See <span data-oc-media-source="screens/run.png">run.png</span> now</p>',
    '<p><span data-oc-media-source="screens/next.png"><button type="button"><img src="https://host/api/fs/raw?token=secret" alt="next.png"></button></span></p>',
  ].join(''));

  expect(serializeRenderedMarkdown(root)).toBe('See ![run.png](screens/run.png) now\n\n![next.png](screens/next.png)');
  expect(serializeRenderedMarkdown(root, 'plain')).toBe('See run.png now\n\nnext.png');
});

test('native strong spans and link labels preserve supported inline semantics', () => {
  const root = render('<p><span data-streamdown="strong">bold</span> <button data-streamdown="link">safe label</button><button>Copy</button></p>');
  expect(serializeRenderedMarkdown(root)).toBe('**bold** safe label');
});

test('partial native code ranges keep row breaks without copying whole source metadata', () => {
  const root = render('<div data-streamdown="code-block" data-oc-code-source="alpha\n\nbeta\n\n"><div data-streamdown="code-block-header">ts</div><div data-streamdown="code-block-body" data-language="ts"><pre><code><span><span>alpha</span></span><span>\n</span><span><span>beta</span></span></code></pre></div></div>');
  expect(serializeRenderedMarkdown(root)).toBe('```ts\nalpha\n\nbeta\n\n```');
  const start = textIn(root, 'code > span:first-child > span');
  const end = textIn(root, 'code > span:last-child > span');
  expect(getMarkdownSelectionText(selectionOf(start, 2, end, 2))).toBe('```ts\npha\n\nbe\n```');
  expect(getMarkdownSelectionText(selectionOf(start, 2, start, 4), 'plain')).toBe('ph');
});

test('the installed Streamdown render copies code rows, strong spans and table links', () => {
  const root = render(renderToStaticMarkup(createElement(Streamdown, {
    mode: 'static',
    linkSafety: { enabled: false },
    children: '**Bold**\n\n```c++\nfirst\n\n  third\n```\n\n| Name |\n| :---: |\n| [docs](https://example.com) |',
  })));
  expect(serializeRenderedMarkdown(root)).toBe('**Bold**\n\n```c++\nfirst\n\n  third\n```\n\n| Name |\n| :---: |\n| [docs](https://example.com/) |');
});

test('whole and mixed selections preserve code metadata only for fully selected cards', () => {
  const root = render('<p>Before</p><div data-streamdown="code-block" data-language="ts" data-oc-code-source="alpha\n\n"><div data-streamdown="code-block-header">ts</div><div data-streamdown="code-block-body" data-language="ts"><pre><code><span><span>alpha</span></span></code></pre></div></div><p>After</p>');
  const range = document.createRange();
  range.selectNodeContents(root);
  expect(getMarkdownSelectionText(range)).toBe('Before\n\n```ts\nalpha\n\n```\n\nAfter');
  const card = root.querySelector('[data-streamdown="code-block"]');
  if (!card) throw new Error('Missing card');
  range.selectNodeContents(card);
  expect(getMarkdownSelectionText(range)).toBe('```ts\nalpha\n\n```');
  const start = textIn(root, 'code > span > span');
  const end = textIn(root, 'p:last-child');
  expect(getMarkdownSelectionText(selectionOf(start, 2, end, 5))).toBe('```ts\npha\n```\n\nAfter');
});

test('tasks, disclosure and media source metadata keep their source semantics', () => {
  const root = render('<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">next</li></ul><details open><summary>More</summary><p>Body</p></details><p><img src="https://host/raw?secret" data-oc-media-source="original.png" alt="image"><img src="plain.png" alt="plain"></p>');
  expect(serializeRenderedMarkdown(root)).toBe('- [x] done\n- [ ] next\n\n<details>\n<summary>More</summary>\n\nBody\n\n</details>\n\n![image](original.png)![plain](plain.png)');
});

test('an alert copies back to its GitHub marker, and as its drawn title in plain text', () => {
  const html = '<blockquote data-oc-alert="note"><p data-oc-alert-title="NOTE"><span>Note</span></p><p>Body</p></blockquote>';
  expect(serializeRenderedMarkdown(render(html))).toBe('> [!NOTE]\n>\n> Body');
  expect(serializeRenderedMarkdown(render(html), 'plain')).toBe('Note\n\nBody');
});

test('native code element offsets preserve partial rows and selected empty lines', () => {
  const root = render('<div data-streamdown="code-block" data-language="ts" data-oc-code-source="alpha\n\nbeta\n\n"><div data-streamdown="code-block-body" data-language="ts"><pre><code><span><span>alpha</span></span><span>\n</span><span><span>beta</span></span></code></pre></div></div>');
  const code = root.querySelector('code');
  if (!code) throw new Error('Missing code');
  expect(getMarkdownSelectionText(selectionOf(code, 1, code, 3))).toBe('```ts\n\nbeta\n```');
  expect(getMarkdownSelectionText(selectionOf(code, 1, code, 2))).toBe('```ts\n\n```');
  expect(getMarkdownSelectionText(selectionOf(code, 0, code, 2))).toBe('```ts\nalpha\n```');
});

test('source metadata cannot replace a partial second code card', () => {
  const root = render('<div data-streamdown="code-block" data-oc-code-source="first\n\n"><div data-streamdown="code-block-body" data-language="ts"><pre><code><span><span>first</span></span></code></pre></div></div><div data-streamdown="code-block" data-oc-code-source="second\n\n"><div data-streamdown="code-block-body" data-language="js"><pre><code><span><span>second</span></span></code></pre></div></div>');
  const end = textIn(root, '[data-language="js"] code > span > span');
  expect(getMarkdownSelectionText(selectionOf(root, 0, end, 3))).toBe('```ts\nfirst\n\n```\n\n```js\nsec\n```');
});

test('selecting prose does not query code elsewhere in a long message', () => {
  const root = render('<p>Hello world</p>' + '<div data-streamdown="code-block" data-oc-code-source="unselected"><pre><code>unselected</code></pre></div>'.repeat(50));
  const text = textIn(root, 'p');
  const range = selectionOf(text, 0, text, 5);
  const queries = spyOn(root, 'querySelectorAll');
  try {
    expect(getMarkdownSelectionText(range)).toBe('Hello');
    expect(rangeToMarkdown(range, 'Hello')).toBe('Hello');
    expect(queries.mock.calls.length).toBe(0);
  } finally {
    queries.mockRestore();
  }
});

test('mixed code selection trims both boundary owners and preserves complete middle source', () => {
  const root = render(['alpha', 'middle', 'omega'].map((source) =>
    `<div data-oc-code-source="${source}\n\n"><div data-streamdown="code-block"><div data-streamdown="code-block-body" data-language="ts"><pre><code><span><span>${source}</span></span></code></pre></div></div></div>`).join(''));
  const first = root.firstElementChild;
  const last = root.lastElementChild;
  if (!first || !last) throw new Error('Missing code owners');
  const start = textIn(first, 'code span span');
  const end = textIn(last, 'code span span');
  const original = root.innerHTML;
  const range = selectionOf(start, 2, end, 3);
  expect(getMarkdownSelectionText(range)).toBe('```ts\npha\n```\n\n```ts\nmiddle\n\n```\n\n```ts\nome\n```');
  root.removeAttribute('data-markdown-content');
  expect(rangeToMarkdown(range, 'pha middle ome')).toBe('```ts\npha\n```\n\n```ts\nmiddle\n\n```\n\n```ts\nome\n```');
  expect(root.innerHTML).toBe(original);
});

test('an element boundary keeps complete source and trims a partial opposite boundary', () => {
  const root = render('<div data-streamdown="code-block" data-oc-code-source="alpha\n\n"><div data-streamdown="code-block-body" data-language="ts"><pre><code><span>alpha</span></code></pre></div></div><div data-streamdown="code-block" data-oc-code-source="beta\n\n"><div data-streamdown="code-block-body" data-language="ts"><pre><code><span>beta</span></code></pre></div></div>');
  const first = root.firstElementChild;
  const last = root.lastElementChild;
  if (!first || !last) throw new Error('Missing code cards');
  const start = textIn(first, 'code span');
  const end = textIn(last, 'code span');
  expect(getMarkdownSelectionText(selectionOf(first, 0, end, 2))).toBe('```ts\nalpha\n\n```\n\n```ts\nbe\n```');
  expect(getMarkdownSelectionText(selectionOf(start, 2, last, last.childNodes.length))).toBe('```ts\npha\n```\n\n```ts\nbeta\n\n```');
});

test('partial code selection reads displayed rows when full source has advanced', () => {
  const root = render('<div data-oc-code-source="alpha\nbeta\nnew pending line"><div data-streamdown="code-block"><div data-streamdown="code-block-body" data-language="ts"><pre><code><span><span>alpha</span></span><span><span>beta</span></span></code></pre></div></div></div>');
  const start = textIn(root, 'code > span:first-child span');
  const end = textIn(root, 'code > span:last-child span');
  const selected = getMarkdownSelectionText(selectionOf(start, 2, end, 2));
  expect(selected).toBe('```ts\npha\nbe\n```');
  expect(serializeRenderedMarkdown(root)).toBe('```ts\nalpha\nbeta\nnew pending line\n```');
});

test('media inside anchors is serialized once and video copies its original source', () => {
  const root = render('<p><a href="https://example.com/image.png"><span data-oc-media-source="https://example.com/image.png">image.png</span></a> <span data-oc-media-source="clip.mp4"><video title="Clip" data-oc-media-source="clip.mp4" src="https://host/raw?secret"></video></span></p>');
  expect(serializeRenderedMarkdown(root)).toBe('![image.png](https://example.com/image.png) ![Clip](clip.mp4)');
  expect(serializeRenderedMarkdown(root, 'plain')).toBe('image.png Clip');
});

test('explicit image links retain their outer target without repeating image labels', () => {
  const root = render('<p><a href="https://example.com/page"><span data-oc-media-source="image.png"><button><img src="https://host/raw?secret" alt="Image"></button></span></a></p>');
  expect(serializeRenderedMarkdown(root)).toBe('[![Image](image.png)](https://example.com/page)');
});

test('partial code in real Streamdown list output retains rows without list chrome', () => {
  const root = render(renderToStaticMarkup(createElement(Streamdown, {
    mode: 'static', children: '- Item\n\n  ```ts\n  alpha\n  beta\n  ```',
  })));
  const first = textIn(root, 'code > span:first-child > span');
  const last = textIn(root, 'code > span:last-child > span');
  const range = selectionOf(first, 2, last, 2);
  expect(getMarkdownSelectionText(range)).toBe('```ts\npha\nbe\n```');
  expect(getMarkdownSelectionText(range, 'plain')).toBe('pha\nbe');
});

test('partial native code inside a table cell retains rows without table chrome', () => {
  const root = render('<table><tbody><tr><td>Before<div data-streamdown="code-block"><div data-streamdown="code-block-body" data-language="ts"><pre><code><span><span>alpha</span></span><span><span>beta</span></span></code></pre></div></div>After</td></tr></tbody></table>');
  const first = textIn(root, 'code > span:first-child > span');
  const last = textIn(root, 'code > span:last-child > span');
  const range = selectionOf(first, 2, last, 2);
  expect(getMarkdownSelectionText(range)).toBe('```ts\npha\nbe\n```');
  expect(getMarkdownSelectionText(range, 'plain')).toBe('pha\nbe');
});

test('an image-only range reads original source metadata on the image itself', () => {
  const root = render('<p><span data-oc-media-source="original.png"><button><img data-oc-media-source="original.png" src="https://host/raw?token=secret" alt="Image"></button></span></p>');
  const button = root.querySelector('button');
  if (!button) throw new Error('Missing image button');
  const range = selectionOf(button, 0, button, 1);
  expect(getMarkdownSelectionText(range)).toBe('![Image](original.png)');
  expect(getMarkdownSelectionText(range, 'plain')).toBe('Image');
});

test('actual MarkdownContent source positions preserve full cards and invalidate a partial last card', async () => {
  const { MarkdownContent } = await import('../MarkdownRendererImpl');
  const { I18nProvider } = await import('@/lib/i18n');
  const root = render(renderToStaticMarkup(createElement(I18nProvider, null, createElement(MarkdownContent, {
    content: '```text\nalpha\n\n\n```\n\n```ts\nbeta\ngamma\n\n```', purpose: 'copy', enableFileReferences: false,
  }))));
  const cards = root.querySelectorAll('[data-streamdown="code-block"]');
  if (cards.length !== 2) throw new Error('Missing actual code cards');
  const range = document.createRange();
  range.selectNode(cards[0]);
  expect(getMarkdownSelectionText(range)).toBe('```\nalpha\n\n```');
  expect(getMarkdownSelectionText(range, 'plain')).toBe('alpha\n');
  expect(rangeToMarkdown(range, 'alpha')).toBe('```\nalpha\n\n```');
  expect(serializeRenderedMarkdown(root, 'plain')).toBe('alpha\n\n\nbeta\ngamma');
  const end = cards[1].querySelector('code > span:nth-child(2) > span')?.firstChild;
  if (!end) throw new Error('Missing actual token');
  const content = cards[0].closest('[data-markdown-content]');
  if (!content) throw new Error('Missing actual content');
  range.setStart(content, 0);
  range.setEnd(end, 2);
  expect(getMarkdownSelectionText(range)).toBe('```\nalpha\n\n```\n\n```ts\nbeta\nga\n```');
  expect(rangeToMarkdown(range, 'alphabeta ga')).toBe('```\nalpha\n\n```\n\n```ts\nbeta\nga\n```');
});

test('detached rich copy normalizes actual code source to semantic literal text', async () => {
  const { MarkdownContent } = await import('../MarkdownRendererImpl');
  const { I18nProvider } = await import('@/lib/i18n');
  const live = render(renderToStaticMarkup(createElement(I18nProvider, null, createElement(MarkdownContent, {
    content: '**Bold**\n\n```ts\nalpha\n\nbeta\n\n```', purpose: 'copy', enableFileReferences: false,
  }))));
  const copy = document.createElement('div');
  copy.innerHTML = live.innerHTML;
  normalizeMarkdownCopyContent(copy);
  const recipient = document.createElement('template');
  recipient.innerHTML = copy.innerHTML;
  expect(recipient.content.querySelector('pre code')?.textContent).toBe('alpha\n\nbeta\n');
  expect(recipient.content.querySelector('pre code')?.className).toBe('language-ts');
  expect(recipient.content.querySelector('strong')?.textContent).toBe('Bold');
  expect(copy.querySelector('[data-streamdown="code-block"]')).toBeNull();
  expect(copy.querySelector('[data-oc-code-source]')).toBeNull();
  expect(live.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
});

test('detached rich copy removes chrome and auth metadata while preserving media labels', () => {
  const copy = document.createElement('div');
  copy.innerHTML = '<p><a href="https://example.com"><img data-message-image-export-exclude src="https://favicon.test/icon">Link</a><span data-oc-media-source="original.png"><button><img data-oc-media-source="original.png" data-oc-media-srcset="https://host/raw?oc_url_token=SECRET 1x" src="https://host/raw?oc_client_token=SECRET" alt="Image"></button></span><span data-oc-media-source=""><video src="https://host/raw?oc_url_token=SECRET" title="Clip"></video></span></p><div data-export-ignore>Toolbar</div>';
  normalizeMarkdownCopyContent(copy);
  expect(copy.querySelector('img')).toBeNull();
  expect(copy.textContent).toBe('LinkImageClip');
  expect(copy.querySelector('video')).toBeNull();
  expect(copy.innerHTML).not.toContain('SECRET');
  expect(copy.innerHTML).not.toContain('data-oc-');
  expect(copy.innerHTML).not.toContain('Toolbar');
});

test('actual copy helper media labels never become request-bearing media', async () => {
  const { renderMarkdownForExport } = await import('./renderMarkdownForExport');
  const copy = await renderMarkdownForExport('![Remote](https://example.com/image.png)\n\n![Local](screens/local.png)', { purpose: 'copy' });
  normalizeMarkdownCopyContent(copy);
  expect(copy.querySelector('img, video, source')).toBeNull();
  expect(copy.textContent).toContain('Remote');
  expect(copy.textContent).toContain('Local');
  expect(copy.querySelector('[data-oc-media-source], [data-oc-media-srcset]')).toBeNull();
});

test('rich copy cannot normalize the live connected tree', () => {
  const root = render('<p>Unchanged</p>');
  expect(() => normalizeMarkdownCopyContent(root)).toThrow('detached');
  expect(root.innerHTML).toBe('<p>Unchanged</p>');
});

test('a native card only reads its own body metadata and immediate owner source', () => {
  const root = render('<div data-oc-code-source="outer\n\n"><div data-streamdown="code-block"><div data-streamdown="code-block-body" data-language="ts"><pre><code><span>outer</span></code></pre></div><div data-streamdown="code-block"><div data-streamdown="code-block-body" data-oc-code-source="unrelated\n\n"><pre><code><span>unrelated</span></code></pre></div></div></div></div>');
  expect(serializeRenderedMarkdown(root)).toBe('```ts\nouter\n\n```');
  root.firstElementChild?.removeAttribute('data-oc-code-source');
  expect(serializeRenderedMarkdown(root)).toBe('```ts\nouter\n```');
});

test('rich copy keeps partial source rows and drops signed media label metadata', () => {
  const copy = document.createElement('div');
  copy.innerHTML = '<div data-streamdown="code-block"><div data-streamdown="code-block-body" data-language="ts"><pre><code><span><span>pha</span></span><span>\n</span><span><span>be</span></span></code></pre></div></div><span data-oc-media-source="https://host/raw?oc_url_token=SECRET" data-oc-media-label="true">Clip</span>';
  normalizeMarkdownCopyContent(copy);
  expect(copy.querySelector('pre code')?.textContent).toBe('pha\n\nbe');
  expect(copy.textContent).toBe('pha\n\nbeClip');
  expect(copy.innerHTML).not.toContain('SECRET');
});

test('rich media without a safe label cannot publish its signed source as text', () => {
  const copy = document.createElement('div');
  copy.innerHTML = '<span data-oc-media-source="https://host/raw?oc_client_token=SECRET" data-oc-media-label="true">https://host/raw?oc_client_token=SECRET</span><video src="https://host/raw?oc_url_token=SECRET"></video><a href="https://example.com/?oc_url_token=ordinary">Link</a>';
  normalizeMarkdownCopyContent(copy);
  expect(copy.innerHTML).not.toContain('SECRET');
  expect(copy.querySelector('a')?.getAttribute('href')).toBe('https://example.com/?oc_url_token=ordinary');
});

test('rich native strong markup keeps emphasis without application styles', () => {
  const copy = document.createElement('div');
  copy.innerHTML = '<p><span data-streamdown="strong" class="font-semibold">Bold</span> text</p>';
  normalizeMarkdownCopyContent(copy);
  expect(copy.querySelector('strong')?.textContent).toBe('Bold');
});
