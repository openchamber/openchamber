import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { Streamdown } from 'streamdown';
import { getMarkdownCjk, getMarkdownProcessingOptions, markdownMath } from './streamdownPlugins';

const dom = new Window();
function render(source: string, raw = false, vscode = false, singleTilde = false) {
  const html = renderToStaticMarkup(<Streamdown
    mode="static" parseIncompleteMarkdown={false} controls={false}
    plugins={{ math: markdownMath, cjk: getMarkdownCjk(singleTilde) }}
    {...getMarkdownProcessingOptions(raw, vscode, singleTilde)}
    urlTransform={(value) => value}
    components={{
      a: ({ node: _node, ...props }) => <a {...props} />,
      img: ({ node: _node, ...props }) => <img {...props} />,
      code: ({ node: _node, ...props }) => <code {...props} />,
      inlineCode: ({ node: _node, ...props }) => <code {...props} />,
      pre: ({ node: _node, ...props }) => <pre {...props} />,
      strong: ({ node: _node, ...props }) => <strong {...props} />,
    }}
  >{source}</Streamdown>);
  const body = dom.document.createElement('div');
  body.innerHTML = html;
  return body;
}

const dirs = (root: ReturnType<typeof render>, selector: string) => Array.from(root.querySelectorAll(selector), (node) => node.getAttribute('dir'));

describe('rehypeTextDirection in the markdown pipeline', () => {
  test('a Latin-first Arabic paragraph renders right to left', () => {
    expect(render('React هي مكتبة لبناء واجهات المستخدم').querySelector('p')?.getAttribute('dir')).toBe('rtl');
  });

  test('an English paragraph quoting an Arabic word stays left to right', () => {
    expect(render('The Arabic label is مرحبا, and this paragraph is English.').querySelector('p')?.getAttribute('dir')).toBe('ltr');
  });

  test('sibling paragraphs and headings resolve on their own', () => {
    const result = render('# React هي مكتبة\n\nFix the login screen first.\n\nnao رخصة Apache 2.0 مفتوحة المصدر');
    expect(result.querySelector('h1')?.getAttribute('dir')).toBe('rtl');
    expect(dirs(result, 'p')).toEqual(['ltr', 'rtl']);
  });

  test('English and Latin-first Arabic items in one list each keep their direction', () => {
    const result = render('- **nao** — رخصة Apache 2.0 مفتوحة المصدر\n- Run the tests before you merge\n- **Lightdash** — BI مفتوح المصدر مبني على dbt');
    expect(dirs(result, 'li')).toEqual(['rtl', 'ltr', 'rtl']);
    expect(result.querySelector('ul')?.getAttribute('dir')).toBeNull();
  });

  test('a list whose items all run one way takes that direction', () => {
    const result = render('1. React هي مكتبة\n2. MCP Server سيرفر محلي بيشغل أوامر');
    expect(result.querySelector('ol')?.getAttribute('dir')).toBe('rtl');
  });

  test('nested paragraphs, lists and quotes resolve apart from their parent', () => {
    const result = render('- React هي مكتبة لبناء الواجهات\n\n  Then rebuild.\n\n  - Keep this item in English\n\n> OpenCode يبني خوادم محلية بنفسه\n>\n> > Nested quote stays English');
    const item = result.querySelector('li');
    expect(dirs(result, 'li > p')).toEqual(['rtl', 'ltr']);
    expect(item?.getAttribute('dir')).toBe('rtl');
    expect(item?.querySelector('li')?.getAttribute('dir')).toBe('ltr');
    const [outer, inner] = Array.from(result.querySelectorAll('blockquote'));
    expect(outer?.getAttribute('dir')).toBe('rtl');
    expect(inner?.getAttribute('dir')).toBe('ltr');
  });

  test('code and URLs do not count toward the direction', () => {
    expect(render('عدّل `useEffect` و `useMemo` و `useState` هنا').querySelector('p')?.getAttribute('dir')).toBe('rtl');
    expect(render('راجع https://github.com/openchamber/openchamber/pull/6590 الآن').querySelector('p')?.getAttribute('dir')).toBe('rtl');
  });

  test('fenced code blocks and text without letters keep no direction', () => {
    const result = render('```ts\n// مرحبا\nconst a = 1;\n```\n\n42 — 7');
    expect(result.querySelector('pre')?.getAttribute('dir')).toBeNull();
    expect(result.querySelector('p')?.getAttribute('dir')).toBeNull();
  });
});
