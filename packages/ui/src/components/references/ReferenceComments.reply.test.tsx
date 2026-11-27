import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';

import type { ReferenceCommentItem, ReferenceTimelineEntry } from './referenceTimeline';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
  HTMLImageElement: browser.HTMLImageElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLAnchorElement: browser.HTMLAnchorElement, SVGElement: browser.SVGElement,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  PointerEvent: browser.PointerEvent, FocusEvent: browser.FocusEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const { createRoot } = await import('react-dom/client');

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const thread: ReferenceCommentItem = {
  kind: 'comment', key: 'thread-1', author: 'mona', avatarUrl: null, body: '', createdAt: '2026-01-02T00:00:00Z',
  context: null, location: null, thread: { id: 'T1', resolved: false, canResolve: false, canReply: true, replies: [] },
};

/** The editor's height cap is measured from the line height its CSS resolves; happy-dom loads no CSS. */
const withLineHeight = async (lineHeight: string, run: () => Promise<void>) => {
  const original = globalThis.getComputedStyle;
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    writable: true,
    // SAFETY: the stub answers only `lineHeight`, the single property ComposerEditor's height cap reads; the real style object is returned for every other element.
    value: (element: Element) => element instanceof HTMLElement && element.classList.contains('cm-content')
      ? ({ lineHeight } as CSSStyleDeclaration)
      : original(element),
  });
  try {
    await run();
  } finally {
    Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, writable: true, value: original });
  }
};

const render = async (replies: Array<{ threadId: string; body: string }>) => {
  const [{ ReferenceCommentsSection }, { I18nProvider }, { TooltipProvider }] = await Promise.all([
    import('./ReferenceCommentsSection'),
    import('@/lib/i18n'),
    import('@/components/ui/tooltip'),
  ]);
  const entries: ReferenceTimelineEntry[] = [thread];
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <ReferenceCommentsSection
            state={{ status: 'ready', value: entries }}
            total={null}
            activity
            now={0}
            threadActions={{ reply: async (threadId, body) => { replies.push({ threadId, body }); return true; } }}
          />
        </TooltipProvider>
      </I18nProvider>,
    );
  });
};

const buttonNamed = (name: string) => [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === name);
const click = async (element: HTMLElement | undefined) => {
  if (!element) throw new Error('Expected the button');
  await act(async () => { element.click(); });
};
const content = () => {
  const field = host.querySelector<HTMLElement>('.cm-content');
  if (!field) throw new Error('Expected the reply editor');
  return field;
};
const replyOpen = () => Boolean(host.querySelector('.composer-editor'));
const editorHost = () => {
  const editor = host.querySelector<HTMLElement>('.composer-editor');
  if (!editor) throw new Error('Expected the shared reply editor');
  return editor;
};
const type = async (text: string) => {
  const editorDOM = host.querySelector('.cm-editor');
  if (!(editorDOM instanceof HTMLElement)) throw new Error('Expected the reply editor view');
  const view = EditorView.findFromDOM(editorDOM);
  if (!view) throw new Error('Expected the reply editor view');
  await act(async () => { view.dispatch({ changes: { from: 0, insert: text } }); });
};
const press = async (key: string, init: { ctrlKey?: boolean; metaKey?: boolean } = {}) => {
  await act(async () => {
    content().dispatchEvent(new KeyboardEvent('keydown', { key, code: key === 'Escape' ? 'Escape' : 'Enter', bubbles: true, cancelable: true, ...init }));
  });
};

describe('replying inside a review thread', () => {
  test('the reply opens the shared Markdown editor at the body type and the 12-line window', async () => {
    await withLineHeight('21px', async () => {
      await render([]);
      await click(buttonNamed('Reply'));
    });
    const editor = editorHost();
    expect(editor.className).toContain('typography-markdown');
    expect(editor.className).toContain('min-h-[calc(12*1lh)]');
    expect(editor.getAttribute('data-chat-input')).toBe('reference-body');
    expect(content().getAttribute('aria-label')).toBe('Write a reply');
    expect(host.querySelector<HTMLElement>('.cm-scroller')?.style.maxHeight).toBe('252px');
  });

  test('Mod+Enter posts the text the editor holds as the thread reply', async () => {
    const replies: Array<{ threadId: string; body: string }> = [];
    await render(replies);
    await click(buttonNamed('Reply'));
    await type('Looks good to me');
    await press('Enter', { ctrlKey: true });
    expect(replies).toEqual([{ threadId: 'T1', body: 'Looks good to me' }]);
    expect(replyOpen()).toBe(false);
  });

  test('Escape closes the reply with text in it, and the text is back when it reopens', async () => {
    await render([]);
    await click(buttonNamed('Reply'));
    await type('Keep this draft');
    await press('Escape');
    expect(replyOpen()).toBe(false);
    await click(buttonNamed('Reply'));
    expect(content().textContent).toContain('Keep this draft');
  });
});
