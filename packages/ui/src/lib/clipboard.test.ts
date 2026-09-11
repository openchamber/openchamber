import { afterEach, describe, expect, test } from 'bun:test';

import { marked } from 'marked';

import { copyMarkdownToClipboard } from './clipboard';
import { flattenAssistantTextParts } from './messages/messageText';

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

describe('copyMarkdownToClipboard', () => {
  test('offers rich HTML and Markdown source in one clipboard item', async () => {
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

    const result = await copyMarkdownToClipboard('**bold**', '<p><strong>bold</strong></p>');

    expect(result).toEqual({ ok: true, method: 'clipboard' });
    expect(Object.keys(writtenItem?.data ?? {}).sort()).toEqual(['text/html', 'text/markdown', 'text/plain']);
    expect(await writtenItem?.data['text/plain']?.text()).toBe('**bold**');
    expect(await writtenItem?.data['text/markdown']?.text()).toBe('**bold**');
    expect(await writtenItem?.data['text/html']?.text()).toBe('<p><strong>bold</strong></p>');
  });

  test('falls back to plain Markdown when a rich clipboard write fails', async () => {
    let fallbackText = '';
    class FakeClipboardItem {
      static supports(): boolean {
        return false;
      }

      constructor() {}
    }

    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: FakeClipboardItem });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          write: async () => {
            throw new Error('unsupported');
          },
          writeText: async (text: string) => {
            fallbackText = text;
          },
        },
      },
    });

    const result = await copyMarkdownToClipboard('# title', '<h1>title</h1>');

    expect(result).toEqual({ ok: true, method: 'clipboard' });
    expect(fallbackText).toBe('# title');
  });

  test('assistant copy payload keeps Markdown block separation in every clipboard format', async () => {
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

    const parts = [
      { id: 'p0', sessionID: 's', messageID: 'm', type: 'text', text: '第一段' },
      { id: 'p1', sessionID: 's', messageID: 'm', type: 'text', text: '第二段' },
      { id: 'p2', sessionID: 's', messageID: 'm', type: 'text', text: '```js\nconsole.log(1)\n\n\nconsole.log(2)\n```' },
      { id: 'p3', sessionID: 's', messageID: 'm', type: 'text', text: '第三段' },
    ];

    // Same path as ChatMessage.tsx handleCopyMessage:
    const text = flattenAssistantTextParts(parts as Parameters<typeof flattenAssistantTextParts>[0]);
    const html = marked.parse(text, { gfm: true, breaks: false }) as string;
    const result = await copyMarkdownToClipboard(text, html);

    const expected = '第一段\n\n第二段\n\n```js\nconsole.log(1)\n\n\nconsole.log(2)\n```\n\n第三段';
    expect(result).toEqual({ ok: true, method: 'clipboard' });
    expect(await writtenItem?.data['text/plain']?.text()).toBe(expected);
    expect(await writtenItem?.data['text/markdown']?.text()).toBe(expected);
    const htmlText = await writtenItem?.data['text/html']?.text();
    expect(htmlText).toContain('<p>第一段</p>');
    expect(htmlText).toContain('<p>第二段</p>');
    expect(htmlText).not.toContain('<p>第一段\n第二段</p>');
  });
});
