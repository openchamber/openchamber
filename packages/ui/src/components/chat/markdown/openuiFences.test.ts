import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { collectOpenUIFences, normalizeOpenUISource, remarkOpenUIFenceSyntax } from './openuiFences';

describe('collectOpenUIFences', () => {
  test('returns a closed OpenUI fence with canonical source offsets and its exact code value', () => {
    const source = 'Before\r\n```openui-lang\r\nroot = Text("😀")\\\\path\r\n```\r\nAfter';
    const normalized = normalizeOpenUISource(source);

    expect(collectOpenUIFences(source)).toEqual([{
      start: normalized.indexOf('```openui-lang'),
      end: normalized.indexOf('\nAfter'),
      code: 'root = Text("😀")\\\\path',
      closed: true,
      literal: false,
      meta: null,
    }]);
  });

  test('tracks closure through the real remark parser without treating a partial fence as complete', () => {
    const source = '```openui-lang\nroot = Text("open")\n\n```openui-lang\nroot = Text("closed")\n```';

    expect(collectOpenUIFences(source)).toEqual([
      {
        start: 0,
        end: source.length,
        code: 'root = Text("open")\n\n```openui-lang\nroot = Text("closed")',
        closed: true,
        literal: false,
        meta: null,
      },
    ]);
    expect(collectOpenUIFences('```openui-lang\nroot = Text("partial")')).toEqual([{
      start: 0,
      end: '```openui-lang\nroot = Text("partial")'.length,
      code: 'root = Text("partial")',
      closed: false,
      literal: false,
      meta: null,
    }]);
    expect(collectOpenUIFences('````openui-lang\nroot = Text("fake close")\n```')).toEqual([{
      start: 0,
      end: '````openui-lang\nroot = Text("fake close")\n```'.length,
      code: 'root = Text("fake close")\n```',
      closed: false,
      literal: false,
      meta: null,
    }]);
  });

  test('keeps literal and unknown metadata visible but inert to callers', () => {
    const source = '```openui-lang literal\nroot = Text("literal")\n```\n\n```openui-lang title="example"\nroot = Text("inert")\n```';

    expect(collectOpenUIFences(source).map(({ code, literal, meta, closed }) => ({ code, literal, meta, closed }))).toEqual([
      { code: 'root = Text("literal")', literal: true, meta: 'literal', closed: true },
      { code: 'root = Text("inert")', literal: false, meta: 'title="example"', closed: true },
    ]);
  });

  test('uses CommonMark fenced-code rules for tilde, longer closers, lists, quotes, and disclosures', () => {
    const source = [
      '~~~~openui-lang',
      'root = Text("tilde")',
      '~~~~~',
      '',
      '- ```openui-lang',
      '  root = Text("list")',
      '  ````',
      '',
      '> ```openui-lang',
      '> root = Text("quote")',
      '> ```',
      '',
      '<details><summary>More</summary>',
      '',
      '```openui-lang',
      'root = Text("disclosure")',
      '```',
      '',
      '</details>',
    ].join('\n');

    expect(collectOpenUIFences(source).map(({ code, closed }) => ({ code, closed }))).toEqual([
      { code: 'root = Text("tilde")', closed: true },
      { code: 'root = Text("list")', closed: true },
      { code: 'root = Text("quote")', closed: true },
      { code: 'root = Text("disclosure")', closed: true },
    ]);
  });

  test('excludes HTML, indented code, wrong languages, and repeated non-fence text', () => {
    const source = [
      '<pre><code class="language-openui-lang">root = Text("html")</code></pre>',
      '',
      '    ```openui-lang',
      '    root = Text("indented")',
      '    ```',
      '',
      '```openui-language',
      'root = Text("wrong")',
      '```',
      '',
      '```openui-lang',
      'root = Text("one")',
      '```',
      '',
      '```openui-lang',
      'root = Text("one")',
      '```',
    ].join('\n');

    expect(collectOpenUIFences(source).map(fence => fence.code)).toEqual(['root = Text("one")', 'root = Text("one")']);
  });

  test('retains canonical fence positions when later reference definitions change the document tree', () => {
    const source = 'See [later][ref].\n\n```openui-lang\nroot = Text("stable")\n```\n\n[ref]: https://example.test';
    const [fence] = collectOpenUIFences(source);

    expect(fence).toMatchObject({
      start: source.indexOf('```openui-lang'),
      end: source.indexOf('\n\n[ref]'),
      code: 'root = Text("stable")',
      closed: true,
    });
  });

  test('normalizes BOM and line endings before remark assigns canonical UTF-16 positions', () => {
    const source = '\uFEFFbefore\r```openui-lang\rroot = Text("value")\r```';
    const normalized = normalizeOpenUISource(source);
    const [fence] = collectOpenUIFences(source);

    expect(normalized).toBe('before\n```openui-lang\nroot = Text("value")\n```');
    expect(fence).toMatchObject({ start: 7, end: normalized.length, code: 'root = Text("value")', closed: true });
  });
  test('keeps Streamdown fenced-code rendering on its default parser path', () => {
    const html = renderToStaticMarkup(React.createElement(Streamdown, {
      mode: 'static',
      parseIncompleteMarkdown: false,
      controls: false,
      remarkPlugins: [remarkOpenUIFenceSyntax],
    }, '```openui-lang\nroot = Text("streamdown")\n```'));

    expect(html).toContain('language-openui-lang');
    expect(html).toContain('root = Text(&quot;streamdown&quot;)');
  });
});
