import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { Streamdown } from 'streamdown';
import { getMarkdownCjk, getMarkdownProcessingOptions, markdownMath, remarkLiteralText } from './streamdownPlugins';
import { parseMarkdownBlocksWithMath } from './mathBlocks';
import { prepareUserMarkdownContent } from '../message/parts/userTextPartContent';

const dom = new Window();
function render(source: string, raw = false, vscode = false, singleTilde = false, streaming = false) {
  const html = renderToStaticMarkup(<Streamdown
    mode={streaming ? 'streaming' : 'static'} parseIncompleteMarkdown={false} controls={false}
    parseMarkdownIntoBlocksFn={streaming ? parseMarkdownBlocksWithMath : undefined}
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

describe('Streamdown processing policy', () => {
  test('renders blank lines inside display math without consuming surrounding content', () => {
    const source = 'Before\n\n\\[\n\\boxed{x+\n\ny}\n\\]\n\nAfter';
    const result = render(source);
    expect(result.querySelector('.katex-display annotation')?.textContent).toBe('\n\\boxed{x+\n\ny}\n');
    expect(result.textContent).toContain('Before');
    expect(result.textContent).toContain('After');
    const blocks = parseMarkdownBlocksWithMath(source);
    expect(blocks.join('')).toBe(source);
    expect(blocks).toHaveLength(3);
    expect(render(blocks[1]).querySelector('.katex-display')).not.toBeNull();
    expect(render('```\n\\[\nx\n\ny\n\\]\n```').querySelector('.katex')).toBeNull();
    expect(render('\\[\nx\n\ny').textContent).toContain('y');
    for (const equation of ['\\[\nx\n+ y\n\\]', 'text\n\\[\nx\n\ny\n\\]', '\\[\nx\n\ny\n    \\]']) {
      expect(render(equation).querySelector('.katex-display')).not.toBeNull();
      expect(parseMarkdownBlocksWithMath(equation)).toHaveLength(1);
    }
    expect(render('> \\[\n> x\nnot quoted\n\n> \\]').querySelector('.katex-display')).toBeNull();
  });
  test('closes display math at the first line ending in a bracket, in static and streaming rendering', () => {
    const source = '\\[\nx\\]\n\nOrdinary prose.\n\n\\]';
    for (const streaming of [false, true]) {
      const result = render(source, false, false, false, streaming);
      expect(Array.from(result.querySelectorAll('.katex-display annotation')).map(node => node.textContent)).toEqual(['\nx']);
      expect(Array.from(result.querySelectorAll('p')).map(node => node.textContent)).toContain('Ordinary prose.');
      const closedInLine = render('\\[\na\n\nb\\]\n\nAfter', false, false, false, streaming);
      expect(closedInLine.querySelector('.katex-display annotation')?.textContent).toBe('\na\n\nb');
      expect(Array.from(closedInLine.querySelectorAll('p')).map(node => node.textContent)).toEqual(['After']);
      const blankLines = render('Before\n\n\\[\n\\boxed{x+\n\ny}\n\\]\n\nAfter', false, false, false, streaming);
      expect(blankLines.querySelector('.katex-display annotation')?.textContent).toBe('\n\\boxed{x+\n\ny}\n');
      expect(Array.from(blankLines.querySelectorAll('p')).map(node => node.textContent)).toEqual(['Before', 'After']);
      const quoted = render('Before\n\n> \\[\n> x\n>\n> y\n> \\]\n\nAfter', false, false, false, streaming);
      expect(quoted.querySelector('blockquote .katex-display annotation')?.textContent).toBe('\nx\n\ny\n');
      expect(Array.from(quoted.querySelectorAll('p')).filter(node => !node.closest('blockquote')).map(node => node.textContent)).toEqual(['Before', 'After']);
    }
  });
  test('preserves blank-line display math inside quotes and list items', () => {
    for (const [container, equation] of [
      ['blockquote', '> \\[\n> x\n>\n> y\n> \\]'],
      ['ul li', '- item\n\n  \\[\n  x\n\n  y\n  \\]'],
      ['ol li', '1. item\n\n   \\[\n   x\n\n   y\n   \\]'],
    ]) {
      const source = `Before\n\n${equation}\n\nAfter`;
      const blocks = parseMarkdownBlocksWithMath(source);
      expect(blocks.join('')).toBe(source);
      const result = render(source);
      expect(result.querySelectorAll('.katex-display')).toHaveLength(1);
      expect(result.querySelector(`${container} .katex-display annotation`)?.textContent).toBe('\nx\n\ny\n');
      expect(Array.from(result.querySelectorAll('p')).filter(node => !node.closest(container)).map(node => node.textContent)).toEqual(['Before', 'After']);
      expect(blocks.flatMap(block => Array.from(render(block).querySelectorAll(`${container} .katex-display annotation`))).map(node => node.textContent)).toEqual(['\nx\n\ny\n']);
    }
  });
  test('keeps adjacent multiline equations intact and accepts tabs on delimiters', () => {
    const source = '\\[\nx\n\\]\n\\[\ny\n\nz\n\\]';
    const blocks = parseMarkdownBlocksWithMath(source);
    expect(blocks.join('')).toBe(source);
    expect(blocks.flatMap(block => Array.from(render(block).querySelectorAll('.katex-display')))).toHaveLength(2);
    for (const source of ['\\[\t\nx\n\ny\n\\]', '\\[\nx\n\ny\n\t\\]']) {
      expect(render(source).querySelector('.katex-display')).not.toBeNull();
    }
  });
  test('keeps a code span over bracket lines and windows prose after a fenced example in a list', () => {
    for (const streaming of [false, true]) {
      const result = render('`sample\n\\[\nx\n\\]\nfinish`', false, false, false, streaming);
      expect(result.querySelector('.katex')).toBeNull();
      expect(result.querySelector('p code')?.textContent).toBe('sample \\[ x \\] finish');
    }
    const source = `- item\n\n  \`\`\`text\n  \\[\n  \`\`\`\n\n${Array.from({ length: 20 }, (_, i) => `P${i}`).join('\n\n')}\n\n\\]\n`;
    expect(parseMarkdownBlocksWithMath(source)).toHaveLength(22);
  });
  test('keeps an unclosed bracket line in its paragraph', () => {
    const result = render('text\n\\[\nnext');
    expect(result.querySelectorAll('p')).toHaveLength(1);
  });
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
  test('keeps single tildes as written and strikes only on a double tilde', () => {
    const ranges = render('**ETA**：前 4 步稳定在 4m50s~5m02s 每个目标，第 5 步大约 **6~7 分钟**后完成；随后是组装（秒级）和 6 个包逐个 `npm publish`（每个 5~20s），整体 **约 8~10 分钟**收敛。');
    expect(ranges.querySelector('del')).toBeNull();
    expect(ranges.textContent).toContain('4m50s~5m02s');
    expect(ranges.textContent).toContain('6~7 分钟');
    expect(ranges.textContent).toContain('5~20s');
    expect(ranges.textContent).toContain('约 8~10 分钟');
    expect(render('旧 ~~已删除~~ 新').querySelector('del')?.textContent).toBe('已删除');
    expect(render('旧 ~~已删除~~ 新').textContent).toBe('旧 已删除 新');
  });

  test('keeps single tildes literal inside re-parsed content and inline markup', () => {
    const details = render('<details><summary>ETA</summary>\n\n前 4m50s~5m02s 每个目标\n\n</details>');
    expect(details.querySelector('del')).toBeNull();
    expect(details.textContent).toContain('4m50s~5m02s');
    const markup = render('a ~b **c** d~ e');
    expect(markup.querySelector('del')).toBeNull();
    expect(markup.querySelector('strong')?.textContent).toBe('c');
    expect(markup.textContent).toBe('a ~b c d~ e');
  });

  test('preserves GFM tildes in host-authored bodies, comments and disclosures', () => {
    for (const vscode of [false, true]) {
      const result = render('a ~removed~ b and 前~~删除。~~后\n\n<details><summary>More</summary>\n\na ~hidden~ b\n\n</details>', true, vscode, true);
      expect(Array.from(result.querySelectorAll('del')).map(node => node.textContent)).toEqual(['removed', '删除。', 'hidden']);
    }
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

  test('keeps an extension install link and drops other app links', () => {
    const kept = 'openchamber://extensions/install?path=/Users/me/ext';
    expect(render(`[Install](${kept})`).querySelector('a')?.getAttribute('href')).toBe(kept);
    expect(render('[Install](openchamber://extensions/install?url=http://example.com/a)').querySelector('a')?.getAttribute('href')).toBeNull();
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

  test('keeps CJK flanked strikethrough working', () => {
    const result = render('前~~删除。~~后 and ~~日本語。~~だよ');
    expect(Array.from(result.querySelectorAll('del')).map(node => node.textContent)).toEqual(['删除。', '日本語。']);
  });

  test('keeps CJK URL boundaries, CRLF, tables, tasks, references and footnotes', () => {
    const result = render('访问https://example.com/path，接着https://other.test/x。\r\n\r\n| A | B |\r\n| - | - |\r\n| [ref][r] | $x$ |\r\n\r\n- [x] done\r\n\r\n[r]: https://reference.test\r\n\r\nNote[^1]\r\n\r\n[^1]: Footnote');
    expect(Array.from(result.querySelectorAll('a')).map(a => a.getAttribute('href'))).toContain('https://example.com/path');
    expect(result.querySelector('table a')?.getAttribute('href')).toBe('https://reference.test');
    expect(result.querySelector('input')?.hasAttribute('disabled')).toBe(true);
    expect(result.textContent).toContain('Footnote');
  });
});

describe('literal text a person typed', () => {
  const renderTyped = (source: string) => {
    const base = getMarkdownProcessingOptions(false, false);
    const html = renderToStaticMarkup(<Streamdown
      mode="static" parseIncompleteMarkdown={false} controls={false}
      plugins={{ math: markdownMath, cjk: getMarkdownCjk(false) }}
      remarkPlugins={[...(base.remarkPlugins ?? []), remarkLiteralText]} rehypePlugins={base.rehypePlugins}
    >{source}</Streamdown>);
    const body = dom.document.createElement('div');
    body.innerHTML = html;
    return body;
  };

  test('keeps shell variables, quotes, code and tags as typed', () => {
    const shell = renderTyped(`run sh -c 'echo user $DEPLOY_USER; test -n "$DEPLOY_PASSWORD"' now`);
    expect(shell.textContent).toBe(`run sh -c 'echo user $DEPLOY_USER; test -n "$DEPLOY_PASSWORD"' now`);
    expect(shell.querySelector('.katex, .katex-error')).toBeNull();
    expect(renderTyped('code `a<b && c` here').querySelector('code')?.textContent).toBe('a<b && c');
    const tags = renderTyped('<b>bold</b> AT&amp;T <details><summary>s</summary>x</details>');
    expect(tags.textContent).toBe('<b>bold</b> AT&amp;T <details><summary>s</summary>x</details>');
    expect(tags.querySelector('b, details')).toBeNull();
  });

  test('still draws a formula from what was typed', () => {
    const formula = renderTyped('so $x<y$ holds');
    expect(formula.querySelector('.katex-error')).toBeNull();
    expect(formula.querySelector('.katex')).not.toBeNull();
  });

  test('renders a typed Windows path literally while code, escapes and math keep working (#6990)', () => {
    const path = renderTyped(prepareUserMarkdownContent({ textContent: 'C:\\Users\\myuser\\.unsloth', skillNames: new Set() }));
    expect(path.textContent).toBe('C:\\Users\\myuser\\.unsloth');

    const mixed = renderTyped(prepareUserMarkdownContent({ textContent: '`a\\.b` and \\*x\\* and \\(y\\)', skillNames: new Set() }));
    expect(mixed.querySelector('code')?.textContent).toBe('a\\.b');
    expect(mixed.textContent).toContain('*x*');
    expect(mixed.querySelector('em')).toBeNull();
    expect(mixed.querySelector('.katex')).not.toBeNull();
  });

  test('keeps the source of a typed formula next to a typed path, for every math delimiter (#6990)', () => {
    const typed = (textContent: string) => renderTyped(prepareUserMarkdownContent({ textContent, skillNames: new Set() }));
    const dotted = '\\text{\\.{z}}';
    for (const formula of [`\\(${dotted}\\)`, `$x ${dotted}$`, `$$${dotted}$$`, `\\[\n${dotted}\n\\]`, `$$\n${dotted}\n$$`]) {
      const expected = renderTyped(formula).querySelector('.katex-html')?.innerHTML;
      expect(expected).toBeDefined();
      const result = typed(`C:\\a\\.b\n\n${formula}`);
      expect(result.querySelector('.katex-html')?.innerHTML).toBe(expected);
      expect(result.textContent).toContain('C:\\a\\.b');
    }
  });

  test('keeps one backslash in an indented code block (#6990)', () => {
    const result = renderTyped(prepareUserMarkdownContent({ textContent: 'C:\\x\\.y\n\n    a\\.b', skillNames: new Set() }));
    expect(result.querySelector('pre code, code')?.textContent?.trim()).toBe('a\\.b');
    expect(result.textContent).toContain('C:\\x\\.y');
  });
});
