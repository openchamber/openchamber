import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';

import {
  formatCodeSelectionMarkdown,
  rangeToMarkdown,
  trimSelectionValue,
  wrapMarkdownSelectionForChat,
} from './selectionMarkdown';

type TestNode =
  | { type: 'text'; value: string }
  | {
      type: 'element';
      tag: string;
      className: string;
      href: string;
      streamdown: string;
      language: string;
      children: TestNode[];
    };

const multiline = (...lines: string[]): string => lines.join('\n');
const text = (value: string): TestNode => ({ type: 'text', value });
const element = (
  tag: string,
  children: TestNode[],
  options: Partial<Omit<Extract<TestNode, { type: 'element' }>, 'type' | 'tag' | 'children'>> = {},
): TestNode => ({
  type: 'element',
  tag,
  className: '',
  href: '',
  streamdown: '',
  language: '',
  children,
  ...options,
});

// Line numbers are CSS-generated, so a code line holds only its code.
const codeLine = (content: string): TestNode => element('span', [text(content)], { className: 'line' });

const markdownBlock = (children: TestNode[]): TestNode => element('div', children);

const codeWrapper = (lines: string[], language = 'ts'): TestNode => element('div', [
  element('div', [text(language)], { streamdown: 'code-block-header' }),
  element('div', [
    element('pre', [
      element('code', lines.map((line) => codeLine(line || '\n'))),
    ]),
  ], { streamdown: 'code-block-body', language }),
], { streamdown: 'code-block' });

const dom = new Window();
Object.assign(globalThis, { document: dom.document });

const selectionNodesToMarkdown = (nodes: TestNode[], plainText: string): string => {
  const root = document.createElement('div');
  root.setAttribute('data-markdown-content', '');
  const append = (parent: Node, node: TestNode): void => {
    if (node.type === 'text') {
      parent.appendChild(document.createTextNode(node.value));
      return;
    }
    const child = document.createElement(node.tag);
    if (node.streamdown) child.setAttribute('data-streamdown', node.streamdown);
    if (node.language) child.setAttribute('data-language', node.language);
    if (node.href) child.setAttribute('href', node.href);
    for (const item of node.children) append(child, item);
    parent.appendChild(child);
  };
  for (const node of nodes) append(root, node);
  const range = document.createRange();
  range.selectNodeContents(root);
  return rangeToMarkdown(range, plainText);
};

describe('rangeToMarkdown', () => {
  test('serializes a complete code block without its header', () => {
    expect(selectionNodesToMarkdown([codeWrapper(['range.cloneContents()', 'next()'])], '')).toBe(multiline(
      '```ts',
      'range.cloneContents()',
      'next()',
      '```',
    ));
  });

  test('preserves a code block nested between production Markdown block wrappers', () => {
    const nodes = [
      markdownBlock([element('p', [
        text('Method:'),
        element('code', [text('Selection.toString()')]),
        text('. Add to Chat uses a cloned range.'),
      ])]),
      markdownBlock([codeWrapper(['range.cloneContents()'])]),
      markdownBlock([element('p', [text('Following explanation')])]),
    ];

    expect(selectionNodesToMarkdown(nodes, '')).toBe(multiline(
      'Method:`Selection.toString()`. Add to Chat uses a cloned range.',
      '',
      '```ts',
      'range.cloneContents()',
      '```',
      '',
      'Following explanation',
    ));
  });

  test('preserves a partial code block selected before prose', () => {
    expect(selectionNodesToMarkdown([
      codeWrapper(['range.cloneContents()']),
      element('p', [text('Following explanation')]),
    ], '')).toBe(multiline(
      '```ts',
      'range.cloneContents()',
      '```',
      '',
      'Following explanation',
    ));
  });
});

test('add-to-chat keeps native code partial rows, empty lines and language', () => {
  const root = document.createElement('div');
  root.setAttribute('data-markdown-content', '');
  root.innerHTML = '<div data-streamdown="code-block" data-oc-code-source="alpha\n\nbeta\n"><div data-streamdown="code-block-header">ts</div><div data-streamdown="code-block-body" data-language="ts"><pre><code><span><span>alpha</span></span><span>\n</span><span><span>beta</span></span></code></pre></div></div>';
  const start = root.querySelector('code > span:first-child > span')?.firstChild;
  const end = root.querySelector('code > span:last-child > span')?.firstChild;
  if (!start || !end) throw new Error('Missing code text');
  const range = document.createRange();
  range.setStart(start, 2);
  range.setEnd(end, 2);
  expect(rangeToMarkdown(range, 'phabe')).toBe('```ts\npha\n\nbe\n```');
});

test('add-to-chat preserves code selections outside Markdown roots without a global document', () => {
  const root = document.createElement('div');
  root.innerHTML = '<div data-streamdown="code-block" data-language="ts" data-oc-code-source="alpha\n\nbeta\n\n"><div data-streamdown="code-block-body" data-language="ts"><pre><code><span><span>alpha</span></span><span>\n</span><span><span>beta</span></span></code></pre></div></div>';
  const start = root.querySelector('code > span:first-child > span')?.firstChild;
  const end = root.querySelector('code > span:last-child > span')?.firstChild;
  const code = root.querySelector('code');
  if (!start || !end || !code) throw new Error('Missing code text');
  const range = document.createRange();
  range.setStart(start, 2);
  range.setEnd(end, 2);
  const doc = document;
  Reflect.deleteProperty(globalThis, 'document');
  try {
    expect(rangeToMarkdown(range, 'phabe')).toBe('```ts\npha\n\nbe\n```');
    range.setStart(code, 1);
    range.setEnd(code, 3);
    expect(rangeToMarkdown(range, 'beta')).toBe('```ts\n\nbeta\n```');
    range.selectNodeContents(root);
    expect(rangeToMarkdown(range, 'alpha beta')).toBe('```ts\nalpha\n\nbeta\n\n```');
    const card = root.firstElementChild;
    if (!card) throw new Error('Missing card');
    range.selectNodeContents(card);
    expect(rangeToMarkdown(range, 'alpha beta')).toBe('```ts\nalpha\n\nbeta\n\n```');
  } finally {
    Object.assign(globalThis, { document: doc });
  }
});

test('rootless mixed selections do not replace selected code with full source metadata', () => {
  const root = document.createElement('div');
  root.innerHTML = '<p>Before</p><div data-streamdown="code-block" data-language="ts" data-oc-code-source="alpha\n\n"><div data-streamdown="code-block-body" data-language="ts"><pre><code><span><span>alpha</span></span></code></pre></div></div><p>After</p>';
  const code = root.querySelector('code span span')?.firstChild;
  const after = root.querySelector('p:last-child')?.firstChild;
  if (!code || !after) throw new Error('Missing text');
  const range = document.createRange();
  range.setStart(code, 2);
  range.setEnd(after, 5);
  expect(rangeToMarkdown(range, 'phaAfter')).toBe('```ts\npha\n```\n\nAfter');
});

test('add-to-chat preserves partial code rows in real Streamdown list output', () => {
  const root = document.createElement('div');
  root.setAttribute('data-markdown-content', '');
  root.innerHTML = renderToStaticMarkup(createElement(Streamdown, {
    mode: 'static', children: '- Item\n\n  ```ts\n  alpha\n  beta\n  ```',
  }));
  const first = root.querySelector('code > span:first-child > span')?.firstChild;
  const last = root.querySelector('code > span:last-child > span')?.firstChild;
  if (!first || !last) throw new Error('Missing token text');
  const range = document.createRange();
  range.setStart(first, 2);
  range.setEnd(last, 2);
  expect(rangeToMarkdown(range, 'phabe')).toBe('```ts\npha\nbe\n```');
});

test('add-to-chat image-only selection uses the image original-source metadata', () => {
  const root = document.createElement('div');
  root.setAttribute('data-markdown-content', '');
  root.innerHTML = '<p><span data-oc-media-source="original.png"><button><img data-oc-media-source="original.png" src="https://host/raw?token=secret" alt="Image"></button></span></p>';
  const button = root.querySelector('button');
  if (!button) throw new Error('Missing image button');
  const range = document.createRange();
  range.selectNodeContents(button);
  expect(rangeToMarkdown(range, '')).toBe('![Image](original.png)');
});

describe('formatCodeSelectionMarkdown', () => {
  test('preserves indentation and blank lines', () => {
    expect(formatCodeSelectionMarkdown(multiline(
      'if (ready) {',
      '  run();',
      '',
      '  stop();',
      '}',
    ), 'ts')).toBe(multiline(
      '```ts',
      'if (ready) {',
      '  run();',
      '',
      '  stop();',
      '}',
      '```',
    ));
  });

  test('normalizes line endings without duplicating a trailing newline', () => {
    expect(formatCodeSelectionMarkdown('first\r\nsecond\r\n', 'text')).toBe(multiline(
      '```text',
      'first',
      'second',
      '```',
    ));
  });

  test('uses a longer fence when selected code contains backtick fences', () => {
    expect(formatCodeSelectionMarkdown(multiline(
      'before',
      '```',
      'after',
    ), 'md')).toBe(multiline(
      '````md',
      'before',
      '```',
      'after',
      '````',
    ));
  });

  test('preserves punctuation in language identifiers', () => {
    expect(selectionNodesToMarkdown([codeWrapper(['std::vector<int> values;'], 'c++')], '')).toBe(multiline(
      '```c++',
      'std::vector<int> values;',
      '```',
    ));
  });
});

describe('trimSelectionValue', () => {
  test('normalizes line endings before trimming the selection', () => {
    expect(trimSelectionValue('  first\r\nsecond  ')).toBe(multiline('first', 'second'));
  });
});

describe('wrapMarkdownSelectionForChat', () => {
  test('uses a longer outer fence when the selection contains fenced code', () => {
    const selectedMarkdown = multiline(
      '```ts',
      'run();',
      '```',
    );

    expect(wrapMarkdownSelectionForChat(selectedMarkdown)).toBe(multiline(
      '````md',
      '```ts',
      'run();',
      '```',
      '````',
    ));
  });
});
