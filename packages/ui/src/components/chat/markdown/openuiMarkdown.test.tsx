import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Block, Streamdown, type BlockProps, type ExtraProps } from 'streamdown';
import {
  createOpenUIDocument,
  OpenUIDocumentContext,
  type OpenUIFenceMount,
  useOpenUIFence,
} from './openuiMarkdownContext';
import { OpenUIBlockSource } from './openuiMarkdown';
import { getMarkdownProcessingOptions } from './streamdownPlugins';

const owner = { runtimeKey: 'test', directory: '/repo', sessionId: 's', messageId: 'm', partId: 'p' };
const code = 'root = Stack([TextContent("Hello")])';
const block = `\`\`\`openui-lang\n${code}\n\`\`\``;

function Code({ node }: React.ComponentProps<'code'> & ExtraProps) {
  const value = node?.children.map((child) => child.type === 'text' ? child.value : '').join('') ?? '';
  const mount = useOpenUIFence(node, value);
  return <code data-authorized={mount ? String(mount.fence.start) : 'no'}>{value}</code>;
}

function SourceBlock(props: BlockProps) {
  return (
    <OpenUIBlockSource content={props.content} index={props.index}>
      <Block {...props} />
    </OpenUIBlockSource>
  );
}

function authorized(displayed: string, canonical = displayed, mode: 'static' | 'streaming' = 'static') {
  const source = createOpenUIDocument({ displayed, canonical, owner, currentSource: () => canonical });
  return renderToStaticMarkup(
    <OpenUIDocumentContext.Provider value={source.document}>
      <Streamdown
        {...getMarkdownProcessingOptions(false, false)}
        mode={mode}
        components={{ code: Code }}
        parseMarkdownIntoBlocksFn={source.split}
        BlockComponent={SourceBlock}
        parseIncompleteMarkdown={false}
      >
        {source.document.display.displayed}
      </Streamdown>
    </OpenUIDocumentContext.Provider>,
  );
}

describe('Streamdown maps display nodes to canonical OpenUI fences', () => {
  test('static and streaming prose preserve the canonical offset', () => {
    const source = `Before.\n\n${block}\n\nAfter.`;
    for (const mode of ['static', 'streaming'] as const) {
      expect(authorized(source, source, mode)).toContain('data-authorized="9"');
    }
  });

  test('identical programs have distinct identities, including after late references', () => {
    for (const suffix of ['', '\n\n[late]: https://example.com']) {
      const source = `${block}\n\n${block}${suffix}`;
      const html = authorized(source, source, 'streaming');
      expect(html).toContain('data-authorized="0"');
      expect(html).toContain(`data-authorized="${block.length + 2}"`);
    }
  });

  test('literal, unclosed and indented code are never authorized', () => {
    for (const source of [
      block.replace('openui-lang', 'openui-lang literal'),
      block.slice(0, -3),
      `    ${block.replaceAll('\n', '\n    ')}`,
      '<pre><code class="language-openui-lang">root = Stack([])</code></pre>',
    ]) {
      expect(authorized(source)).not.toMatch(/data-authorized="\d/);
    }
  });

  test('interleaved source receipts cannot authorize another render', () => {
    const first = createOpenUIDocument({ displayed: block, canonical: block, owner, currentSource: () => block });
    const secondSource = `Changed prefix.\n\n${block}`;
    const second = createOpenUIDocument({ displayed: secondSource, canonical: secondSource, owner, currentSource: () => secondSource });
    const draw = (source: typeof first, text: string) => renderToStaticMarkup(
      <OpenUIDocumentContext.Provider value={source.document}>
        <Streamdown {...getMarkdownProcessingOptions(false, false)} mode="streaming" components={{ code: Code }}
          parseMarkdownIntoBlocksFn={source.split} BlockComponent={SourceBlock} parseIncompleteMarkdown={false}>
          {text}
        </Streamdown>
      </OpenUIDocumentContext.Provider>,
    );
    expect(draw(first, block)).toContain('data-authorized="0"');
    expect(draw(second, secondSource)).toContain('data-authorized="17"');
    expect(draw(first, block)).toContain('data-authorized="0"');
    expect(draw(first, secondSource)).not.toMatch(/data-authorized="\d/);
  });

  test('a stale display does not authorize a replaced canonical source', () => {
    expect(authorized(block, block.replace('Hello', 'Changed'))).toContain('data-authorized="no"');
    expect(authorized(block, `${block}\n\nLater prose.`)).toContain('data-authorized="0"');
    expect(authorized(block, `${block}not-a-closer`)).toContain('data-authorized="no"');
  });

  test('normalized CRLF/BOM and nested prose retain real canonical positions', () => {
    const source = `Before.\n\n${block}\n`;
    expect(authorized(`\uFEFF${source.replaceAll('\n', '\r\n')}`)).toContain('data-authorized="9"');
    for (const nested of [
      block.split('\n').map((line) => `> ${line}`).join('\n'),
      `<details><summary>Open</summary>\n\n${block}\n\n</details>`,
    ]) {
      expect(authorized(nested)).toMatch(/data-authorized="\d/);
    }
  });

  test('closure is revoked synchronously when a later raw delta invalidates its line', () => {
    let current = block;
    let interact: (() => boolean) | undefined;
    function Capture({ node }: React.ComponentProps<'code'> & ExtraProps) {
      const value = node?.children.map((child) => child.type === 'text' ? child.value : '').join('') ?? '';
      interact = useOpenUIFence(node, value)?.canInteract;
      return <code>{value}</code>;
    }
    const source = createOpenUIDocument({ displayed: block, canonical: block, owner, currentSource: () => current });
    renderToStaticMarkup(
      <OpenUIDocumentContext.Provider value={source.document}>
        <Streamdown {...getMarkdownProcessingOptions(false, false)} mode="static" components={{ code: Capture }}>
          {block}
        </Streamdown>
      </OpenUIDocumentContext.Provider>,
    );
    expect(interact?.()).toBe(true);
    current = `${block}not-a-closer`;
    expect(interact?.()).toBe(false);
    current = block.replace('Hello', 'Replaced');
    expect(interact?.()).toBe(false);
    current = `${block}\n\nContinued prose.`;
    expect(interact?.()).toBe(true);
  });

  test('streaming mounts receive original DSL and wait for a confirmed closing line', () => {
    function inspect(displayed: string, canonical = displayed, isStreaming = true, finalized = false) {
      const captured: OpenUIFenceMount[] = [];
      function Capture({ node }: React.ComponentProps<'code'> & ExtraProps) {
        const value = node?.children.map((child) => child.type === 'text' ? child.value : '').join('') ?? '';
        const mount = useOpenUIFence(node, value);
        if (mount) captured.push(mount);
        return <code>{value}</code>;
      }
      const source = createOpenUIDocument({ displayed, canonical, owner, isStreaming, finalized, currentSource: () => canonical });
      renderToStaticMarkup(
        <OpenUIDocumentContext.Provider value={source.document}>
          <Streamdown {...getMarkdownProcessingOptions(false, false)} mode="streaming" isAnimating={isStreaming}
            components={{ code: Capture }} BlockComponent={SourceBlock} parseMarkdownIntoBlocksFn={source.split}
            parseIncompleteMarkdown={isStreaming}>
            {source.document.display.displayed}
          </Streamdown>
        </OpenUIDocumentContext.Provider>,
      );
      return captured;
    }
    const partial = '```openui-lang\nroot = Stack([TextContent("hello ';
    expect(inspect(partial)[0]?.fence.code).toBe('root = Stack([TextContent("hello ');
    expect(inspect(partial.split('\n').map((line) => `> ${line}`).join('\n'))[0]?.fence.code)
      .toBe('root = Stack([TextContent("hello ');
    const disclosed = `<details><summary>Open</summary>\n\n${partial}`;
    expect(inspect(disclosed)[0]?.fence.code).toBe('root = Stack([TextContent("hello ');
    for (const suffix of ['', ' ', '`', 'not-a-closer']) {
      const mounted = inspect(block, block + suffix);
      expect(mounted).toHaveLength(1);
      expect(mounted[0].isStreaming).toBe(true);
      expect(mounted[0].canInteract()).toBe(false);
    }
    for (const suffix of ['\n', ' \n', '`\n']) {
      const mounted = inspect(block, block + suffix);
      expect(mounted).toHaveLength(1);
      expect(mounted[0].isStreaming).toBe(false);
      expect(mounted[0].canInteract()).toBe(true);
      expect(inspect(block + suffix)[0]?.canInteract()).toBe(true);
    }
    expect(inspect(block, block, false, true)[0]?.canInteract()).toBe(true);
    expect(inspect(block.slice(0, -3), block.slice(0, -3), false, true)).toHaveLength(0);
    expect(inspect(block, block, false, false)).toHaveLength(0);
    expect(inspect(partial, partial.replace('hello', 'other'))).toHaveLength(0);
  });
});
