import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { toast } from 'sonner';

import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { MobileSessionRowActions, MobileSwipeActionsRow, ROW_ACTIONS_WIDTH, ROW_ACTION_SLOT_WIDTH } from './MobileSessionSwipe';

test('mobile swipe keeps every action reachable in narrow LTR and RTL rows and closes after copying', async () => {
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
  const originalLocale = useI18nStore.getState().locale;
  let extraActions = false;
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
        actionsWidth={ROW_ACTIONS_WIDTH + (extraActions ? 3 * ROW_ACTION_SLOT_WIDTH : 0)}
        revealed={revealed}
        onRevealedChange={onRevealedChange}
        actions={(
          <MobileSessionRowActions
            sessionId={sessionId}
            title="Session"
            revealed={revealed}
            confirmingDelete={false}
            onRevealedChange={onRevealedChange}
            pin={extraActions ? { pinned: false, onToggle: () => undefined } : undefined}
            priority={extraActions ? { priority: false, onToggle: () => undefined } : undefined}
            work={extraActions ? { inWork: false, onToggle: () => undefined } : undefined}
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

    extraActions = true;
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
    const row = container.querySelector<HTMLDivElement>('.overflow-hidden');
    const actions = row?.querySelector<HTMLDivElement>('[aria-hidden]');
    const content = actions?.nextElementSibling;
    if (!row || !actions || !(content instanceof HTMLElement)) throw new Error('Missing swipe row');
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 296 });
    expect(actions.style.width).toBe('336px');
    expect(actions.style.maxWidth).toBe('100%');
    expect(actions.querySelectorAll('button')).toHaveLength(7);

    const touch = (type: string, clientX: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'touches', { value: [{ clientX, clientY: 0 }] });
      row.dispatchEvent(event);
    };
    for (const locale of ['en', 'ar'] as const) {
      await act(async () => {
        useI18nStore.setState({ locale });
        setRevealed(false);
      });
      changes.length = 0;
      const sign = locale === 'ar' ? -1 : 1;
      const clamp = sign === -1 ? 'max' : 'min';
      await act(async () => {
        touch('touchstart', 0);
        // Over half the 296px row, but under half the 336px preferred strip.
        touch('touchmove', sign * 150);
        touch('touchend', sign * 150);
      });
      expect(changes).toEqual([true]);
      expect(content.style.transform).toBe(`translateX(${clamp}(${sign * 336}px, ${sign * 100}%))`);
      expect(getCopyButton().tabIndex).toBe(0);
      await act(async () => {
        touch('touchstart', 0);
        touch('touchmove', -sign * 150);
        touch('touchend', -sign * 150);
      });
      expect(changes).toEqual([true, false]);
      expect(content.style.transform).toBe('none');
    }
  } finally {
    await act(async () => root.unmount());
    useI18nStore.setState({ locale: originalLocale });
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
