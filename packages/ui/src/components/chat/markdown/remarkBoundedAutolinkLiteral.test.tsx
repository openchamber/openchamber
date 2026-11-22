import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import type { Construct, Extension, Tokenizer } from 'micromark-util-types';
import type { Pluggable, Processor } from 'unified';
import { getMarkdownCjk, getMarkdownProcessingOptions, markdownMath } from './streamdownPlugins';
import { AUTOLINK_LITERAL_EVENT_LIMIT, remarkBoundedAutolinkLiteral } from './remarkBoundedAutolinkLiteral';

// The fork's #4204 fixture: pretty-printed JSON with no blank line, one paragraph.
const dataDump = (count: number): string => {
  let seed = 7;
  const pick = (values: readonly string[]): string | undefined => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return values[Math.floor((seed / 0x100000000) * values.length)];
  };
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `item_${i}`,
    label: pick(['alpha_beta', 'gamma_delta', 'epsilon_zeta', 'eta_theta', 'iota_kappa']),
    link: pick(['/Main', '/List', '/Detail', '/data/nested']),
    count_a: 1000 + i,
    ratio_b: 30 + (i % 20),
    state: pick(['ok', 'warning', 'unread']),
  }));
  return `Review the following data dump. Docs: https://example.com/docs\n\n${JSON.stringify(rows, null, 2)}\nwith \\(x^2\\) at the end`;
};

// Records the paragraph length, in events, at every literal-autolink attempt
// that reaches the GFM tokenizer, which walks back over all of them.
const LITERALS = new Set(['wwwAutolink', 'protocolAutolink', 'emailAutolink']);
const recordAttempts = (seen: number[]) => function recordLiteralAttempts(this: Processor) {
  const wrap = (construct: Construct): Construct => {
    if (!construct.name || !LITERALS.has(construct.name)) return construct;
    const { tokenize } = construct;
    const recorded: Tokenizer = function (effects, ok, nok) {
      seen.push(this.events.length);
      return tokenize.call(this, effects, ok, nok);
    };
    return { ...construct, tokenize: recorded };
  };
  const wrapExtension = (extension: Extension): Extension => {
    if (!extension.text) return extension;
    const text: NonNullable<Extension['text']> = {};
    for (const [code, constructs] of Object.entries(extension.text)) {
      if (constructs) text[Number(code)] = Array.isArray(constructs) ? constructs.map(wrap) : wrap(constructs);
    }
    return { ...extension, text };
  };
  const extensions = this.data('micromarkExtensions');
  if (extensions) this.data('micromarkExtensions', extensions.map(wrapExtension));
};

const processing = getMarkdownProcessingOptions(false, false, false);
const remarkPlugins = processing.remarkPlugins ?? [];
const boundAt = remarkPlugins.indexOf(remarkBoundedAutolinkLiteral);

// `bounded: false` is the reference: the same pipeline without the bound.
const render = (source: string, { bounded = true, seen }: { bounded?: boolean; seen?: number[] } = {}): string => {
  const plugins: Pluggable[] = [...remarkPlugins.slice(0, boundAt), ...(seen ? [recordAttempts(seen)] : []), ...(bounded ? [remarkBoundedAutolinkLiteral] : []), ...remarkPlugins.slice(boundAt + 1)];
  return renderToStaticMarkup(<Streamdown
    mode="static" parseIncompleteMarkdown={false} controls={false}
    plugins={{ math: markdownMath, cjk: getMarkdownCjk(false) }}
    remarkPlugins={plugins} rehypePlugins={processing.rehypePlugins}
    urlTransform={(value) => value}
    components={{ a: ({ node: _node, ...props }) => <a {...props} /> }}
  >{source}</Streamdown>);
};
const hrefs = (html: string): string[] => [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((match) => match[1]);

describe('bounded GFM literal autolinks', () => {
  test('the chat pipeline bounds the literal autolink right after GFM', () => {
    expect(boundAt).toBeGreaterThan(0);
  });

  test('the tokenizer never walks back over more than the limit, where unbounded it does', () => {
    const source = dataDump(300);
    const unbounded: number[] = [];
    render(source, { bounded: false, seen: unbounded });
    // Positive control: the fixture does reach past the limit.
    expect(Math.max(...unbounded)).toBeGreaterThan(AUTOLINK_LITERAL_EVENT_LIMIT);
    const bounded: number[] = [];
    render(source, { seen: bounded });
    expect(bounded.length).toBeGreaterThan(0);
    expect(Math.max(...bounded)).toBeLessThanOrEqual(AUTOLINK_LITERAL_EVENT_LIMIT);
  });

  test('the data dump renders the same with and without the bound', () => {
    const source = dataDump(300);
    expect(render(source)).toBe(render(source, { bounded: false }));
  });

  test('a bare URL late in a long paragraph is still linked, with the CJK boundary', () => {
    const filler = 'word '.repeat(6000);
    const late = `${filler} see https://example.com。 then www.example.org/x and a@b.co done`;
    expect(hrefs(render(late))).toEqual(['https://example.com', 'http://www.example.org/x', 'mailto:a@b.co']);
    expect(render(late)).toBe(render(late, { bounded: false }));
  });

  // Smoke: the fork rendered this dump inside the default test timeout.
  test('the data dump from the report renders', () => {
    const html = render(dataDump(600));
    expect(html).toContain('item_599');
    expect(hrefs(html)[0]).toBe('https://example.com/docs');
  });
});
