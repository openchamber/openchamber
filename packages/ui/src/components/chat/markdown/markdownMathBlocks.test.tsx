import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { Streamdown } from 'streamdown';
import { getMarkdownCjk, getMarkdownProcessingOptions, markdownMath } from './streamdownPlugins';
import { createMarkdownMathPreparer, prepareMarkdownMath } from './markdownMathBlocks';

describe('standalone bracket math with blank lines', () => {
  const formula = '\\[\n\\boxed{x+\n\ny}\n\\]';
  const source = `Before\n\n${formula}\n\nAfter`;

  test('renders the same expression in static, windowed and streaming Markdown', () => {
    for (const mode of ['static', 'streaming'] as const) {
      for (const isAnimating of [false, true]) {
        const prepared = prepareMarkdownMath(source, mode === 'streaming' && isAnimating);
        const html = renderToStaticMarkup(<Streamdown
          mode={mode} isAnimating={isAnimating} parseIncompleteMarkdown={isAnimating} controls={false}
          plugins={{ math: markdownMath, cjk: getMarkdownCjk(false) }}
          remend={prepared.remend}
          {...getMarkdownProcessingOptions(false, false)}
        >{prepared.content}</Streamdown>);
        const body = new Window().document.createElement('div');
        body.innerHTML = html;
        expect(body.querySelectorAll('.katex-display')).toHaveLength(1);
        expect(body.querySelector('annotation')?.textContent).toContain('\\boxed{x+\n\ny}');
        expect(body.textContent).toContain('Before');
        expect(body.textContent).toContain('After');
      }
    }
  });

  test('preserves Markdown code, links, containers and unfinished delimiters', () => {
    for (const text of [
      `\`\`\`tex\n${formula}\n\`\`\``,
      '\\[plain\\] text\n\nNext',
      'Before\n\n\\[\nx\n\nUnfinished',
      '`code\n\\[x\\]\nend`',
      '[See\n\\[options\\] guide](https://example.test)',
      '\\[unfinished\n\n```\n\\]\n```\n\nAfter',
      '\\[\nA\n\n    code\n\\]',
      '\\[\nA\n\n[link][ref]\n\\]\n\n[ref]: https://example.test',
      '\\[\nA\n\n| item | value |\n| --- | --- |\n| x | y |\n\\]',
      '\\[\nA\n\n*emphasis*\n\\]',
      '\\[\nA\n\n**bold**\n\\]',
      '\\[\nA\n\n文**加粗。**本\n\\]',
      '\\[\nA\n\n\tcode\n\\]',
      '\\[\nA\n\nexample@example.test\n\\]',
      '\\[\nA\n\nopenchamber://session/ses_abc\n\\]',
      '\\[\nA\n\n&amp;\n\\]',
      '\\[\nA\n\n---\n\\]',
      '> \\[\n> x\n>\n> +y\n> \\]',
      '- item\n\n  \\[\n  x\n\n  +y\n  \\]',
    ]) expect(prepareMarkdownMath(text, true).content).toBe(text);
  });

  test('keeps the original text when a closer is escaped', () => {
    const text = '\\[\nx \\\\]\n\ny';
    expect(prepareMarkdownMath(text, true).content).toBe(text);
  });

  test('renders a formula containing an interval during a live response', () => {
    const text = '\\[\nx \\in [0,1)\n\n\\]';
    const prepared = prepareMarkdownMath(text, true);
    const html = renderToStaticMarkup(<Streamdown
      mode="streaming" isAnimating parseIncompleteMarkdown controls={false}
      plugins={{ math: markdownMath, cjk: getMarkdownCjk(false) }}
      remend={prepared.remend}
      {...getMarkdownProcessingOptions(false, false)}
    >{prepared.content}</Streamdown>);
    const body = new Window().document.createElement('div');
    body.innerHTML = html;
    expect(body.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(body.querySelector('annotation')?.textContent).toContain('x \\in [0,1)');
  });

  test('reuses the prepared prefix and rechecks appended math and private-use characters', () => {
    const prepare = createMarkdownMathPreparer();
    const finish = (prepared: ReturnType<typeof prepareMarkdownMath>) => {
      const restore = prepared.remend?.handlers?.find((handler) => handler.name === 'restore-display-math');
      return restore ? restore.handle(prepared.content) : prepared.content;
    };
    const first = '\\[\nx\n\ny\n\\]\n\n';
    expect(finish(prepare(first, true))).toBe('$$\nx\n\ny\n$$\n\n');
    expect(finish(prepare(`${first}\uE000`, true))).toBe('$$\nx\n\ny\n$$\n\n\uE000');
    const second = `${first}\\[\na\n\nb\n\\]`;
    expect(finish(prepare(second, true))).toBe('$$\nx\n\ny\n$$\n\n$$\na\n\nb\n$$');
    expect(finish(prepare(first, false))).toBe('$$\nx\n\ny\n$$\n\n');
  });

  test('does not change streaming text with no complete standalone math', () => {
    const text = '\uE000*hello';
    const prepared = prepareMarkdownMath(text, true);
    expect(prepared.content).toBe(text);
    expect(prepared.remend?.handlers).toBeUndefined();
  });

  test('rechecks a closing line that grows while streaming', () => {
    const prepare = createMarkdownMathPreparer();
    const source = '\\[\nx\n\ny\n\\]';
    expect(prepare(source, true).content).not.toBe(source);
    const continued = `${source} text\n\nAfter`;
    expect(prepare(continued, true).content).toBe(continued);
  });

  test('keeps a prepared formula when later text is indented code', () => {
    const prepare = createMarkdownMathPreparer();
    const source = '\\[\nx\n\ny\n\\]\n';
    prepare(source, true);
    const continued = `${source}    code`;
    expect(prepare(continued, true).content).toBe(prepareMarkdownMath(continued, true).content);
  });

  test('rechecks the prefix when a streamed reference definition changes block splitting', () => {
    const prepare = createMarkdownMathPreparer();
    const source = 'Before\n\n\\[\nx\n\ny\n\\]\n\n[ref]';
    prepare(source, true);
    const continued = `${source}: https://example.test`;
    expect(prepare(continued, true).content).toBe(prepareMarkdownMath(continued, true).content);
  });

  test('notices a reference definition streamed over several updates', () => {
    const prepare = createMarkdownMathPreparer();
    const source = '\\[\nx\n\ny\n\\]\n\n';
    prepare(source, true);
    prepare(`${source}[ref`, true);
    prepare(`${source}[ref]`, true);
    const completed = `${source}[ref]: https://example.test`;
    expect(prepare(completed, true).content).toBe(prepareMarkdownMath(completed, true).content);
  });

  test('rechecks definitions inside block quotes and can disable preparation for extra plugins', () => {
    const prepare = createMarkdownMathPreparer();
    const source = '\\[\nA\n\n[ref]\n\\]\n\n';
    prepare(source, true);
    const continued = `${source}> [ref]: https://example.test`;
    expect(prepare(continued, true).content).toBe(prepareMarkdownMath(continued, true).content);
    expect(prepare(source, true, false).content).toBe(source);
  });

  test('finds a standalone formula in a document with footnotes and references', () => {
    const text = 'Before[^1] and [reference][ref]\n\n\\[\nx\n\ny\n\\]\n\n[^1]: note\n\n[ref]: https://example.test';
    const prepared = prepareMarkdownMath(text, false);
    const html = renderToStaticMarkup(<Streamdown
      mode="static" parseIncompleteMarkdown={false} controls={false}
      plugins={{ math: markdownMath, cjk: getMarkdownCjk(false) }}
      urlTransform={(value) => value}
      components={{ a: ({ node: _node, ...props }) => <a {...props} /> }}
      {...getMarkdownProcessingOptions(false, false)}
    >{prepared.content}</Streamdown>);
    const body = new Window().document.createElement('div');
    body.innerHTML = html;
    expect(body.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(body.querySelector('a[href="https://example.test"]')?.textContent).toBe('reference');
    expect(body.textContent).toContain('note');
  });
});
