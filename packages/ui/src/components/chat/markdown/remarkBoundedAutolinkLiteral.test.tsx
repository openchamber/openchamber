import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import type { Construct, Event, Extension, Tokenizer } from 'micromark-util-types';
import type { Pluggable, Processor } from 'unified';
import { getMarkdownCjk, getMarkdownProcessingOptions, markdownMath } from './streamdownPlugins';
import { remarkBoundedAutolinkLiteral } from './remarkBoundedAutolinkLiteral';

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

// For every literal-autolink attempt that reaches the GFM tokenizer, records how
// many events its previousUnbalanced walk reads: back to an unbalanced label, a
// token an earlier walk marked, or the paragraph start.
const walkLength = (events: Event[]): number => {
  let read = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    read += 1;
    const token = events[index][1];
    if ((token.type === 'labelLink' || token.type === 'labelImage') && token._balanced !== true) break;
    if (token._gfmAutolinkLiteralWalkedInto === true) break;
  }
  return read;
};
const LITERALS = new Set(['wwwAutolink', 'protocolAutolink', 'emailAutolink']);
// One plugin instance: Streamdown may reuse a processor built from the same plugins.
let reads: number[] = [];
function recordLiteralAttempts(this: Processor) {
  const wrap = (construct: Construct): Construct => {
    if (!construct.name || !LITERALS.has(construct.name)) return construct;
    const { tokenize } = construct;
    const recorded: Tokenizer = function (effects, ok, nok) {
      reads.push(walkLength(this.events));
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
}

const processing = getMarkdownProcessingOptions(false, false, false);
const remarkPlugins = processing.remarkPlugins ?? [];
const boundAt = remarkPlugins.indexOf(remarkBoundedAutolinkLiteral);

// `bounded: false` is the reference: the same pipeline without the bound.
const render = (source: string, { bounded = true, record = false }: { bounded?: boolean; record?: boolean } = {}): string => {
  const plugins: Pluggable[] = [...remarkPlugins.slice(0, boundAt), ...(record ? [recordLiteralAttempts] : []), ...(bounded ? [remarkBoundedAutolinkLiteral] : []), ...remarkPlugins.slice(boundAt + 1)];
  return renderToStaticMarkup(<Streamdown
    mode="static" parseIncompleteMarkdown={false} controls={false}
    plugins={{ math: markdownMath, cjk: getMarkdownCjk(false) }}
    remarkPlugins={plugins} rehypePlugins={processing.rehypePlugins}
    urlTransform={(value) => value}
    components={{ a: ({ node: _node, ...props }) => <a {...props} /> }}
  >{source}</Streamdown>);
};
const hrefs = (html: string): string[] => [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((match) => match[1]);

// Long enough that the unbalanced `[` sits thousands of events back; the
// reference render without the plugin is quadratic in it, so it stays modest.
const filler = 'word '.repeat(1500);
// Shapes where the literal tokenizer and the later mdast pass link differently,
// so a declined attempt the tokenizer would have taken changes the output.
const urls = [
  'https://example.com。 tail',
  'www.example.org/x and a@b.co',
  'https://example.com/*foo*bar',
  'https://x.com/a?b=c_d_',
  'https://x.com/a*',
  'https://x.com/a\\_b',
  'https://x.com/?a=1&amp;b=2',
  'https://x.com/[a](b)',
];

describe('linear GFM literal autolinks', () => {
  test('the chat pipeline adds the plugin right after GFM', () => {
    expect(boundAt).toBeGreaterThan(0);
  });

  test('no literal attempt walks back over the paragraph again, where unbounded every one does', () => {
    const total = (rows: number, bounded = true): number => {
      reads = [];
      render(dataDump(rows), { bounded, record: true });
      return reads.reduce((sum, read) => sum + read, 0);
    };
    const unbounded = total(300, false);
    // Positive control: the dump opens with `[`, so each attempt walks back to it.
    expect(unbounded).toBeGreaterThan(1_000_000);
    // Linear: four times the rows read about four times the events, not sixteen.
    expect(total(1200)).toBeLessThan(6 * total(300));
    expect(total(300) * 50).toBeLessThan(unbounded);
  });

  test('the data dump renders the same as without the plugin', () => {
    const source = dataDump(300);
    expect(render(source)).toBe(render(source, { bounded: false }));
  });

  for (const lead of ['', '[ ', '![ ', '[balanced](x) ', '[not a link] ']) {
    test(`URLs late in a long paragraph opening with ${JSON.stringify(lead)} render the same as without the plugin`, () => {
      for (const url of urls) {
        const source = `${lead}${filler} see ${url} done`;
        expect(render(source)).toBe(render(source, { bounded: false }));
      }
    }, 60_000);
  }

  // The remembered `[` closes later without forming a link; attempts after it
  // must see it as balanced again.
  test('URLs after a long label that closes without a link render the same as without the plugin', () => {
    for (const url of urls) {
      const source = `[open ${filler} closes] then ${url} done`;
      expect(render(source)).toBe(render(source, { bounded: false }));
    }
  }, 60_000);

  test('a bare URL late in a long paragraph is still linked, with the CJK boundary', () => {
    expect(hrefs(render(`${filler} see https://example.com。 then www.example.org/x and a@b.co done`)))
      .toEqual(['https://example.com', 'http://www.example.org/x', 'mailto:a@b.co']);
  });

  // The plugin's own walk is not visible to the recorder above, so the whole
  // render is measured too, in CPU time so other processes do not count:
  // linear is about four times the cost for four times the rows, quadratic
  // sixteen.
  test('four times the rows costs well under sixteen times the CPU', () => {
    const cpuMs = (rows: number): number => {
      const source = dataDump(rows);
      const start = process.cpuUsage();
      render(source);
      const used = process.cpuUsage(start);
      return (used.user + used.system) / 1000;
    };
    cpuMs(300);
    expect(cpuMs(1200)).toBeLessThan(10 * cpuMs(300));
  }, 60_000);

  // Smoke: the fork rendered this dump inside the default test timeout.
  test('the data dump from the report renders', () => {
    const html = render(dataDump(600));
    expect(html).toContain('item_599');
    expect(hrefs(html)[0]).toBe('https://example.com/docs');
  });
});
