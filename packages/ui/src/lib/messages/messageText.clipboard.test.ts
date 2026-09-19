import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';

mock.module('dompurify', () => ({
  default: {
    isSupported: true,
    addHook: () => undefined,
    sanitize: (html: string) => html,
  },
}));
mock.module('../../components/chat/markdown/markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
}));

import { copyMarkdownToClipboard } from '../clipboard';
import { flattenAssistantTextParts } from './messageText';

const { renderMarkdownSync } = await import('../../components/chat/markdown/markdownCore');

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');

const restoreGlobal = (name: 'navigator' | 'ClipboardItem', descriptor?: PropertyDescriptor): void => {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
};

afterEach(() => {
  restoreGlobal('navigator', originalNavigator);
  restoreGlobal('ClipboardItem', originalClipboardItem);
});

// SAFETY: each mapped fixture supplies every required SDK TextPart field, and its `type: 'text'` discriminant selects that Part variant.
const textParts = (texts: string[]): Part[] => texts.map((text, index) => ({
  id: `part-${index}`,
  sessionID: 'session-1',
  messageID: 'message-1',
  type: 'text',
  text,
} as Part));

describe('assistant Markdown clipboard payload', () => {
  test('carries preserved block separation into each clipboard format', async () => {
    let writtenItem: { data: Record<string, Blob> } | undefined;
    class FakeClipboardItem {
      static supports(type: string): boolean {
        return type === 'text/markdown';
      }

      readonly data: Record<string, Blob>;

      constructor(data: Record<string, Blob>) {
        this.data = data;
      }
    }

    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: FakeClipboardItem });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          write: async (items: Array<{ data: Record<string, Blob> }>) => {
            writtenItem = items[0];
          },
        },
      },
    });

    const markdown = flattenAssistantTextParts(textParts([
      'First paragraph',
      'Second paragraph',
      '```ts\nconst value = 1;\n```',
      '- item 1\n- item 2',
    ]));
    const html = renderMarkdownSync(markdown);

    expect(html).toContain('<p>First paragraph</p>');
    expect(html).toContain('<p>Second paragraph</p>');
    expect(html).toContain('<pre><code class="language-ts">const value = 1;\n</code></pre>');
    expect(html).toContain('<ul>\n<li>item 1</li>\n<li>item 2</li>\n</ul>');

    const result = await copyMarkdownToClipboard(markdown, html);
    const plain = await writtenItem?.data['text/plain']?.text();
    const markdownText = await writtenItem?.data['text/markdown']?.text();
    const htmlText = await writtenItem?.data['text/html']?.text();

    expect(result).toEqual({ ok: true, method: 'clipboard' });
    expect(Object.keys(writtenItem?.data ?? {}).sort()).toEqual(['text/html', 'text/markdown', 'text/plain']);
    expect(plain).toBe(markdown);
    expect(markdownText).toBe(markdown);
    expect(htmlText).toBe(html);
  });
});
