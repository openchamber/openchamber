import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { toast } from 'sonner';

import { I18nProvider } from '@/lib/i18n';
import { MobileSessionRowActions, MobileSwipeActionsRow, ROW_ACTIONS_WIDTH } from './MobileSessionSwipe';

test('mobile session swipe actions copy the exact ID and close only after a successful copy', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    Node: dom.Node,
    Event: dom.Event,
    MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.document, 'execCommand', { configurable: true, value: () => false });

  const sessionId = 'ses_exact-mobile-session-id_42';
  const changes: boolean[] = [];
  let setRevealed: (next: boolean) => void = () => {};
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const clipboard = spyOn(dom.navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  const successToast = spyOn(toast, 'success').mockImplementation(() => 'success');
  const errorToast = spyOn(toast, 'error').mockImplementation(() => 'error');

  const Harness: React.FC = () => {
    const [revealed, updateRevealed] = React.useState(true);
    setRevealed = updateRevealed;
    const onRevealedChange = (next: boolean) => {
      changes.push(next);
      updateRevealed(next);
    };

    return (
      <MobileSwipeActionsRow
        actionsWidth={ROW_ACTIONS_WIDTH}
        revealed={revealed}
        onRevealedChange={onRevealedChange}
        actions={(
          <MobileSessionRowActions
            sessionId={sessionId}
            title="Session"
            revealed={revealed}
            confirmingDelete={false}
            onRevealedChange={onRevealedChange}
          />
        )}
      >
        <div>Session row</div>
      </MobileSwipeActionsRow>
    );
  };

  const getCopyButton = () => {
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Copy session ID"]');
    if (!button) throw new Error('Copy session ID action is missing');
    return button;
  };

  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
    expect(ROW_ACTIONS_WIDTH).toBe(192);
    expect(container.querySelectorAll('[aria-hidden="false"] button')).toHaveLength(4);

    await act(async () => {
      getCopyButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(clipboard.mock.calls[0]?.[0]).toBe(sessionId);
    expect(successToast.mock.calls[0]?.[0]).toBe('Session ID copied');
    expect(changes).toEqual([false]);
    expect(container.querySelector('[aria-hidden="true"] [aria-label="Copy session ID"]')).not.toBeNull();

    changes.length = 0;
    clipboard.mockRejectedValue(new Error('clipboard denied'));
    await act(async () => setRevealed(true));
    await act(async () => {
      getCopyButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(clipboard.mock.calls[1]?.[0]).toBe(sessionId);
    expect(errorToast.mock.calls[0]?.[0]).toBe('Failed to copy session ID');
    expect(changes).toEqual([]);
    expect(container.querySelector('[aria-hidden="false"] [aria-label="Copy session ID"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    clipboard.mockRestore();
    successToast.mockRestore();
    errorToast.mockRestore();
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
