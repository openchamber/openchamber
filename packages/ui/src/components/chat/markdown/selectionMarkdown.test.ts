import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
});

const { getMarkdownSelectionText, serializeRenderedMarkdown } = await import('./selectionMarkdown');

afterEach(() => document.body.replaceChildren());
afterAll(() => dom.happyDOM.close());

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

test('decorated code blocks keep language and code text, not the toolbar', () => {
  const root = render(
    '<div data-component="markdown-code"><div><span>ts</span><div data-md-code-actions><button data-md-action="copy-code">Copy</button></div></div>'
    + '<div data-md-code-body><pre data-md-lang="ts"><code data-md-code-lines data-md-code-trailing-newline>'
    + '<span data-md-code-line><span data-md-code-line-number="1" aria-hidden="true"></span><span data-md-code-line-content>const a = 1;</span></span>'
    + '<span data-md-code-line-break>\n</span>'
    + '<span data-md-code-line><span data-md-code-line-number="2" aria-hidden="true"></span><span data-md-code-line-content>a += 1;</span></span>'
    + '<span data-md-code-line-break>\n</span>'
    + '</code></pre></div></div>',
  );

  expect(serializeRenderedMarkdown(root)).toBe('```ts\nconst a = 1;\na += 1;\n```');
});

test('tables, math, mermaid and file links read from what the renderer kept', () => {
  const root = render([
    '<div data-markdown="table-wrapper"><div><button data-md-action="table-copy-toggle">Copy</button></div>'
    + '<div><table><colgroup><col></colgroup><thead><tr><th>Name</th><th>Value</th></tr></thead>'
    + '<tbody><tr><td>a|b</td><td><code>1</code></td></tr></tbody></table></div></div>',
    '<p>Within <span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow>'
    + '<annotation encoding="application/x-tex">\\pm 5\\%</annotation></semantics></math></span>'
    + '<span class="katex-html" aria-hidden="true">±5%</span></span> of <a href="#" data-openchamber-file-link="true">src/app.ts</a>.</p>',
    '<div data-markdown="mermaid-block" data-md-source="graph TD; A-->B"><div data-markdown="mermaid-scroll"><svg></svg></div>'
    + '<div data-markdown="mermaid-toolbar"><button>Copy</button></div></div>',
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
