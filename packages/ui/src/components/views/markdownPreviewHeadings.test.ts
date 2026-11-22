import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { readPreviewHeadings } from './markdownPreviewHeadings';

const host = (html: string): Element => {
  Object.assign(globalThis, { window: new Window() });
  Object.assign(globalThis, { document: window.document });
  document.body.innerHTML = html;
  return document.body;
};

describe('readPreviewHeadings', () => {
  test('lists the rendered headings in document order with their level and text', () => {
    const container = host('<div data-markdown-content><h1>Plan</h1><p>x</p><h3>Step <code>one</code></h3><h2>Done</h2></div>');
    const headings = readPreviewHeadings(container);
    expect(headings.map((heading) => [heading.level, heading.text])).toEqual([[1, 'Plan'], [3, 'Step one'], [2, 'Done']]);
    expect(headings[0]!.element.tagName).toBe('H1');
  });

  test('collapses whitespace and skips a heading with no text', () => {
    const container = host('<div data-markdown-content><h2>  Two\n   words </h2><h2>   </h2></div>');
    expect(readPreviewHeadings(container).map((heading) => heading.text)).toEqual(['Two words']);
  });

  test('ignores headings outside the rendered document', () => {
    const container = host('<h2>Find bar</h2><div data-markdown-content><h2>Real</h2></div>');
    expect(readPreviewHeadings(container).map((heading) => heading.text)).toEqual(['Real']);
  });

  test('lists each heading once when rendered documents nest', () => {
    const container = host('<div data-markdown-content><h2>A</h2><div data-markdown-content><h2>B</h2></div></div>');
    expect(readPreviewHeadings(container).map((heading) => heading.text)).toEqual(['A', 'B']);
  });

  test('returns nothing for a document without headings', () => {
    expect(readPreviewHeadings(host('<div data-markdown-content><p>text</p></div>'))).toEqual([]);
  });
});
