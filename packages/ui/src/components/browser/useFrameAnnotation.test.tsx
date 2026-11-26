import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { ChatColumnActionsContext, useChatColumnActions } from '@/components/chat/chatColumnSession';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { toast } from '@/components/ui';
import { I18nProvider, useI18n } from '@/lib/i18n';
import { useFrameAnnotation } from './useFrameAnnotation';

test('a pinned page without a writable composer refuses annotation before editing starts', async () => {
  const dom = new Window({ url: 'http://localhost/' });
  const globals = { window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
    localStorage: dom.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const error = spyOn(toast, 'error');
  let readOnly = '';
  function Page() {
    const frameRef = React.useRef<HTMLIFrameElement>(null);
    readOnly = useI18n().t('contextPanel.browser.annotate.readOnly');
    const annotation = useFrameAnnotation({ frameRef, directory: '/repo', pageKey: 'page',
      intro: '', describePage: (payload) => payload });
    return <><iframe ref={frameRef} /><button aria-pressed={annotation.isAnnotating} onClick={annotation.toggle}>Annotate</button></>;
  }
  function ReadOnlyPanel() {
    const actions = useChatColumnActions();
    return <ChatColumnActionsContext.Provider value={{ ...actions, pinned: true }}><Page /></ChatColumnActionsContext.Provider>;
  }
  try {
    await act(async () => root.render(<I18nProvider><ThemeSystemProvider><ReadOnlyPanel /></ThemeSystemProvider></I18nProvider>));
    const toggle = host.querySelector('button');
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(error.mock.calls[0]?.[0]).toBe(readOnly);
  } finally {
    await act(async () => root.unmount());
    error.mockRestore();
    await dom.happyDOM.close();
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
