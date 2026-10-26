import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { Streamdown } from 'streamdown';
import { getMarkdownProcessingOptions, markdownCjk, markdownMath } from './streamdownPlugins';

const dom = new Window();
function render(source: string, raw = false, vscode = false) {
  const html = renderToStaticMarkup(<Streamdown
    mode="static" parseIncompleteMarkdown={false} controls={false}
    plugins={{ math: markdownMath, cjk: markdownCjk }}
    {...getMarkdownProcessingOptions(raw, vscode)}
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

describe('Streamdown processing policy', () => {
  test('keeps blockquoted disclosures inside their container in both HTML policies', () => {
    const source = '> <details><summary>S</summary>\n>\n> Body $100$ and $$x$$\n>\n> </details>\n\nAfter';
    for (const raw of [false, true]) {
      const result = render(source, raw);
      expect(result.querySelectorAll('details')).toHaveLength(1);
      expect(result.querySelector('details')?.textContent).toContain('Body $100$');
      expect(result.querySelector('details')?.textContent).not.toContain('After');
      expect(result.querySelector('details blockquote')).toBeNull();
      expect(result.textContent?.match(/After/g)).toHaveLength(1);
      expect(result.querySelector('details')?.textContent).not.toContain('</details>');
    }
  });

  test('preserves valid embedded image metadata for the validating resolver without browser src', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    for (const raw of [false, true]) {
      const result = render(`![image](${png})`, raw);
      expect(result.querySelector('img')?.getAttribute('data-oc-media-source')).toBe(png);
      expect(result.querySelector('img')?.getAttribute('src')).toBeNull();
    }
  });

  test('preserves safe image and picture source candidates while dropping hostile srcset', () => {
    const result = render('<picture><source srcset="dark.png 1x, https://cdn.test/dark.png 2x"><img src="light.png" srcset="light.png 1x, https://cdn.test/light.png 2x"></picture>', true);
    expect(result.querySelector('img')?.getAttribute('src')).toBe('light.png');
    expect(result.querySelector('img')?.getAttribute('srcset')).toBe('light.png 1x, https://cdn.test/light.png 2x');
    expect(result.querySelector('source')?.getAttribute('srcset')).toBe('dark.png 1x, https://cdn.test/dark.png 2x');
    const hostile = render('<picture><source srcset="safe.png 1x, javascript:bad 2x"><img src="safe.png" srcset="safe.png 1x, data:image/svg+xml,bad 2x"></picture>', true);
    expect(hostile.querySelector('img')?.hasAttribute('srcset')).toBe(false);
    expect(hostile.querySelector('source')?.hasAttribute('srcset')).toBe(false);
  });
  test('keeps processing arrays stable and policy-specific', () => {
    expect(getMarkdownProcessingOptions(false, false)).toBe(getMarkdownProcessingOptions(false, false));
    expect(getMarkdownProcessingOptions(true, false).rehypePlugins).not.toBe(getMarkdownProcessingOptions(false, false).rehypePlugins);
  });

  test('shows chat HTML as text and parses only restricted nested disclosures', () => {
    const result = render('<details open><summary>Review **ready**</summary>\n\n> Quote\n\n<details><summary>Inner</summary>\n\n`</details>`\n\n```html\n</details>\n```\n\n**Nested**\n\n</details>\n\n</details>\n\n<p class="fixed">visible</p>');
    expect(result.querySelectorAll('details')).toHaveLength(2);
    expect(result.querySelector('details')?.hasAttribute('open')).toBe(true);
    expect(result.querySelector('summary strong')?.textContent).toBe('ready');
    expect(result.querySelector('blockquote')?.textContent).toContain('Quote');
    expect(result.textContent).toContain('<p class="fixed">visible</p>');
    expect(render('<details onclick="bad()"><summary>Bad</summary>x</details>').querySelector('details')).toBeNull();
    expect(render('```html\n<details><summary>Inert</summary>\n```').querySelector('details')).toBeNull();
  });

  test('sanitizes document markup without author-controlled renderer properties', () => {
    const result = render('<picture><source media="(prefers-color-scheme: dark)" srcset="dark.svg 1x, https://cdn.test/dark.svg 2x"><img src="light.svg" width="32" height="28" class="language-ts fixed" style="position:fixed" id="x" onerror="bad()" data-oc-media-source="file:///secret"></picture>\n\n<video src="clip.mp4" autoplay></video>\n\n<script>bad()</script><style>bad</style><input type="text">', true);
    expect(result.querySelector('source')?.getAttribute('srcset')).toContain('dark.svg 1x');
    expect(result.querySelector('img')?.getAttribute('width')).toBe('32');
    expect(result.querySelector('img')?.getAttribute('data-oc-media-source')).not.toBe('file:///secret');
    for (const attribute of ['class', 'style', 'id', 'onerror']) expect(result.querySelector('img')?.hasAttribute(attribute)).toBe(false);
    expect(result.querySelector('video')?.hasAttribute('controls')).toBe(true);
    expect(result.querySelector('video')?.hasAttribute('autoplay')).toBe(false);
    expect(result.querySelector('script, style, input')).toBeNull();
    expect(render('<source srcset="a.png 1x, javascript:bad 2x">', true).querySelector('source')?.hasAttribute('srcset')).toBe(false);
  });

  test('preserves approved links before sanitation while rejecting privileged and network URLs', () => {
    const sources = ['obsidian://open?vault=Notes', 'file:///workspace/a.md', 'openchamber://session/ses_abc?message=msg_1', 'javascript:bad', 'data:text/html,bad', 'blob:https://test/a', 'file://server/share/a', '//server/share/a', 'openchamber://connect?p=secret', 'openchamber-ui://index.html'];
    const source = sources.map((url, i) => `[link${i}](${url})`).join('\n\n');
    const links = render(source).querySelectorAll('a');
    for (let i = 0; i < sources.length; i++) expect(links[i]?.getAttribute('href')).toBe(i < 3 ? sources[i] : null);
    expect(render('[session](openchamber://session/ses_abc)', false, true).querySelector('a')?.getAttribute('href')).toBeNull();
    expect(render('Pasted openchamber://session/ses_abc?message=msg_1.').querySelector('a')?.getAttribute('href')).toBe('openchamber://session/ses_abc?message=msg_1');
    const image = render('![local](file:///workspace/a.png)').querySelector('img');
    expect(image?.getAttribute('data-oc-media-source')).toBe('file:///workspace/a.png');
    expect(image?.getAttribute('src')).toBeNull();
    expect(render('![bad](data:image/png;base64,bad)').querySelector('img')?.getAttribute('data-oc-media-source')).toBeNull();
  });

  test('preserves real fence language and metastring while stripping authored classes', () => {
    const result = render('```rust title="file.rs"\nlet x = 1;\n```\n\n<code class="language-rust">raw</code> <code class="language-ts fixed">mixed</code> <span class="language-ts">span</span>', true);
    expect(result.querySelector('pre code')?.getAttribute('class')).toBe('language-rust');
    expect(result.querySelector('pre code')?.getAttribute('metastring')).toBe('title="file.rs"');
    // A document's own language class stays, as it did before; any other author class goes.
    const inline = result.querySelectorAll('p code');
    expect(inline[0]?.getAttribute('class')).toBe('language-rust');
    expect(inline[1]?.hasAttribute('class')).toBe(false);
    expect(result.querySelector('p span')?.hasAttribute('class')).toBe(false);
  });

  test('rejects obfuscated and network media sources without trusting authored metadata', () => {
    for (const source of ['java&#10;script:bad', 'data&#9;:image/png,bad', '//server/share/a.png', '\\\\server\\share\\a.png']) {
      const result = render(`<img src="${source}" data-oc-media-source="file:///secret">`, true);
      expect(result.querySelector('img')?.getAttribute('src')).toBeNull();
      expect(result.querySelector('img')?.getAttribute('data-oc-media-source')).toBeNull();
    }
  });

  test('keeps raw document disclosure Markdown and nested unsafe HTML under the same policy', () => {
    const result = render('<details><summary>Review **ready**</summary>\n\n$100$ and $x$\n\n<img class="fixed" data-oc-media-source="file:///secret" src="safe.png">\n\n</details>', true);
    expect(result.querySelector('summary strong')?.textContent).toBe('ready');
    expect(result.querySelectorAll('.katex')).toHaveLength(1);
    expect(result.textContent).toContain('$100$');
    expect(result.querySelector('img')?.hasAttribute('class')).toBe(false);
    expect(result.querySelector('img')?.getAttribute('data-oc-media-source')).toBe('safe.png');
  });
});

describe('Streamdown math and CJK compatibility', () => {
  test('renders comparisons and interval brackets as ordinary formulas', () => {
    const result = render('$n > p$ and $x < y$ and $x \\in [0,1]$');
    expect(result.querySelectorAll('.katex')).toHaveLength(3);
    expect(Array.from(result.querySelectorAll('annotation')).map(node => node.textContent)).toEqual(['n > p', 'x < y', 'x \\in [0,1]']);
  });

  test('keeps angle autolinks outside currency math candidates', () => {
    const result = render('$5 <https://example.test/$x$> $10');
    expect(result.querySelectorAll('.katex')).toHaveLength(0);
    expect(result.querySelector('a')?.getAttribute('href')).toBe('https://example.test/$x$');
    expect(result.querySelector('a')?.textContent).toBe('https://example.test/$x$');
    expect(result.textContent).toBe('$5 https://example.test/$x$ $10');
  });
  test('math plugin registers its own parser without processing options', () => {
    const html = renderToStaticMarkup(<Streamdown mode="static" plugins={{ math: markdownMath }}>
      {'$x$ and \\(y\\) and $100$'}
    </Streamdown>);
    const body = dom.document.createElement('div');
    body.innerHTML = html;
    expect(body.querySelectorAll('.katex')).toHaveLength(2);
    expect(body.textContent).toContain('$100$');
  });
  test('renders inline formulas and keeps currency literal', () => {
    const result = render('$x$ and $2\\pi r$; $100$; $5 and $10; US$ 680; $50M to $72M');
    expect(result.querySelectorAll('.katex')).toHaveLength(2);
    expect(result.textContent).toContain('$100$');
    expect(result.textContent).toContain('$5 and $10');
    expect(result.textContent).toContain('$50M to $72M');
  });

  test('bracket display math may own a line inside a list item or a quote', () => {
    for (const source of ['- item\n\n  \\[x^2\\]', '- item\n  \\[x^2\\]', '> q\n> \\[x\\]', '1. a\n   \\[\n   y\n   \\]']) {
      expect(render(source).querySelectorAll('.katex').length).toBeGreaterThan(0);
    }
    expect(render('text \\[x\\]').querySelector('.katex')).toBeNull();
  });

  test('keeps LaTeX emphasis characters inside dollar math (#5303)', () => {
    const cases = [
      '- **Example**: a two-factor random-effects ANOVA as an LMM ($\\boldsymbol{b}=(\\boldsymbol{\\alpha},\\boldsymbol{\\beta}_B,\\boldsymbol{\\gamma}_{AB})^\\top$,$G$ block-diagonal)',
      'variance component estimates $\\hat{\\sigma}_\\beta$ -> $\\hat{\\sigma}^2_\\beta$',
      '$$\\boldsymbol{b}=(\\boldsymbol{\\alpha},\\boldsymbol{\\beta}_B,\\boldsymbol{\\gamma}_{AB})^\\top$$',
    ];
    for (const source of cases) {
      const result = render(source);
      expect(result.querySelectorAll('.katex').length).toBeGreaterThan(0);
      expect(result.querySelector('em')).toBeNull();
      expect(result.textContent).not.toContain('$\\');
    }
    const emphasized = render('**$x_i$** and $a_i < b_i$');
    expect(emphasized.querySelector('strong .katex')).not.toBeNull();
    expect(emphasized.querySelectorAll('.katex')).toHaveLength(2);
    expect(emphasized.querySelector('em')).toBeNull();
  });

  test('preserves formula content and prevents delimiters from crossing Markdown link boundaries', () => {
    const result = render('$x;y$ and $2\\pi r$ and $5 [item](https://example.test/$x$) $10\n\n\\(a+b\\)\n\n\\[\r\nx+y\r\n\\]');
    expect(result.querySelectorAll('.katex')).toHaveLength(4);
    expect(result.querySelector('annotation')?.textContent).toBe('x;y');
    expect(result.querySelector('a')?.getAttribute('href')).toBe('https://example.test/$x$');
    expect(Array.from(result.querySelectorAll('annotation')).map(node => node.textContent)).toContain('a+b');
    expect(Array.from(result.querySelectorAll('annotation')).map(node => node.textContent)).toContain('\nx+y\n');
  });

  test('supports backslash inline/block and same-line dollar display without changing code, URLs or escaped bracket prose', () => {
    const result = render('Area \\(\\pi r^2\\)\n\n\\[\nx^2\n\\]\n\n$$x+y$$\n\n[title \\[Bug\\] more](https://example.test/$x$) and \\[plain\\] text\n\n`$x$ \\(y\\)`\n\n```tex\n$$z$$\n```');
    expect(result.querySelectorAll('.katex')).toHaveLength(3);
    expect(result.querySelectorAll('.katex-display')).toHaveLength(2);
    expect(result.querySelector('a')?.textContent).toBe('title [Bug] more');
    expect(result.querySelector('a')?.getAttribute('href')).toBe('https://example.test/$x$');
    expect(result.textContent).toContain('[plain] text');
    expect(result.querySelector('code')?.textContent).toBe('$x$ \\(y\\)');
  });

  test('keeps math source positions inside disclosures and leaves incomplete delimiters readable', () => {
    const result = render('<details><summary>Area $100$ and \\(x\\)</summary>\n\nBody $100$ and $$y$$\n\n<details><summary>Inner</summary>\n\n$z$\n\n</details>\n\n</details>');
    expect(result.querySelectorAll('.katex')).toHaveLength(3);
    expect(result.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(result.textContent).toContain('$100$');
    expect(render('unfinished \\(x and $y').textContent).toBe('unfinished (x and $y');
  });

  test('keeps escaped dollars and math-looking URL labels literal and display math handles CRLF', () => {
    const result = render('\\$x$ and [https://example.test/$x$](https://example.test/$x$)\r\n\r\n\\[\r\nx+y\r\n\\]');
    expect(result.querySelectorAll('.katex')).toHaveLength(1);
    expect(result.querySelector('a')?.textContent).toBe('https://example.test/$x$');
    expect(result.querySelectorAll('.katex-display')).toHaveLength(1);
  });

  test('keeps CJK URL boundaries, CRLF, tables, tasks, references and footnotes', () => {
    const result = render('访问https://example.com/path，接着https://other.test/x。\r\n\r\n| A | B |\r\n| - | - |\r\n| [ref][r] | $x$ |\r\n\r\n- [x] done\r\n\r\n[r]: https://reference.test\r\n\r\nNote[^1]\r\n\r\n[^1]: Footnote');
    expect(Array.from(result.querySelectorAll('a')).map(a => a.getAttribute('href'))).toContain('https://example.com/path');
    expect(result.querySelector('table a')?.getAttribute('href')).toBe('https://reference.test');
    expect(result.querySelector('input')?.hasAttribute('disabled')).toBe(true);
    expect(result.textContent).toContain('Footnote');
  });
});
