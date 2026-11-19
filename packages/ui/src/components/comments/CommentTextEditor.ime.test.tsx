import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CommentTextEditor } from './CommentTextEditor';
import { useCommentImagePaste } from './useCommentImagePaste';
import { I18nProvider } from '@/lib/i18n';

describe('CommentTextEditor IME handling', () => {
  test('ignores composition keydown events before handling save shortcuts', async () => {
    const browser = new Window();
    const globals = {
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      MutationObserver: browser.MutationObserver,
      ResizeObserver: browser.ResizeObserver,
      requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
      cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
      getComputedStyle: browser.getComputedStyle.bind(browser),
      localStorage: browser.localStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const descriptors = Object.getOwnPropertyDescriptors(globalThis);
    Object.assign(globalThis, globals);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let saved = 0;
    const Host = () => {
      const imagePaste = useCommentImagePaste();
      return <CommentTextEditor value="note" onChange={() => undefined}
        onSubmit={() => { saved += 1; }} onCancel={() => undefined}
        enterSubmits imagePaste={imagePaste} placeholder="Comment" />;
    };
    try {
      await act(async () => root.render(<I18nProvider><Host /></I18nProvider>));
      const field = browser.document.querySelector('.cm-content');
      if (!field) throw new Error('comment field not mounted');
      await act(async () => {
        field.dispatchEvent(new browser.KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true,
        }));
      });
      expect(saved).toBe(0);
      await act(async () => {
        field.dispatchEvent(new browser.KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
        }));
      });
      expect(saved).toBe(1);
    } finally {
      await act(async () => root.unmount());
      browser.close();
      for (const key of Object.keys(globals)) {
        const descriptor = descriptors[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});
