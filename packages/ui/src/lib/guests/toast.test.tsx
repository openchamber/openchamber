import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { toast } from 'sonner';
import type { ToastRequest } from '@openchamber/sdk';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { showGuestToast } from './toast';

describe('guest toast buttons', () => {
  let dom: Window;
  let root: Root;
  let container: HTMLElement;
  let notice: ReturnType<typeof spyOn<typeof toast, 'info'>>;
  let dismissed: ReturnType<typeof spyOn<typeof toast, 'dismiss'>>;
  let writes: string[];
  let failCopy: boolean;
  const originals = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    dom = new Window({ url: 'http://toast.test' });
    for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    writes = [];
    failCopy = false;
    Object.defineProperty(dom.document, 'execCommand', { value: () => false });
    Object.defineProperty(dom.navigator.clipboard, 'writeText', { value: async (text: string) => {
      if (failCopy) throw new Error('Clipboard denied');
      writes.push(text);
    } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    notice = spyOn(toast, 'info').mockImplementation(() => 'notice');
    dismissed = spyOn(toast, 'dismiss').mockImplementation(() => 'dismissed');
    useI18nStore.getState().setLocale('en');
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    notice.mockRestore(); dismissed.mockRestore();
    useI18nStore.getState().setLocale('en');
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    originals.clear();
  });
  const show = async (request: ToastRequest) => {
    showGuestToast(request);
    const options = notice.mock.calls.at(-1)?.[1];
    const action = options?.action;
    if (!options || !React.isValidElement(action)) throw new Error('Toast buttons missing');
    await act(async () => root.render(<I18nProvider>{action}</I18nProvider>));
    return options;
  };
  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find((element) => element.textContent === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    await act(async () => button.click());
  };

  test('Copy keeps a persistent toast open; OK dismisses that toast', async () => {
    const options = await show({ kind: 'info', message: 'Result', copy: true, dismiss: true, persistent: true });
    expect(options.duration).toBe(Infinity);
    await click('Copy');
    expect(writes).toEqual(['Result']);
    expect(container.textContent).toContain('Copied');
    expect(dismissed.mock.calls.length).toBe(0);
    await click('OK');
    expect(dismissed.mock.calls[0]?.[0]).toBe(options.id);
  });

  test('custom copy text preserves whitespace, and failure leaves the buttons available for retry', async () => {
    await show({ kind: 'info', message: 'Summary', copy: { text: '  source\n' } });
    failCopy = true;
    await click('Copy');
    expect(container.textContent).toContain('Copy failed');
    expect(writes).toEqual([]);
    expect(dismissed.mock.calls.length).toBe(0);
    failCopy = false;
    await click('Copy');
    expect(writes).toEqual(['  source\n']);
    expect(container.textContent).not.toContain('Copy failed');
    expect(container.querySelectorAll('button').length).toBe(1);
  });

  test('persistent toasts always have OK, and legacy toasts keep the normal timer', async () => {
    const options = await show({ kind: 'info', message: 'Wait', persistent: true, dismiss: false });
    expect(container.querySelectorAll('button').length).toBe(1);
    await click('OK');
    expect(dismissed.mock.calls[0]?.[0]).toBe(options.id);
    showGuestToast({ kind: 'info', message: 'Plain' });
    expect(notice.mock.calls.at(-1)).toEqual(['Plain']);
    const timed = await show({ kind: 'info', message: 'Timed', dismiss: true });
    expect(timed.duration).toBeUndefined();
  });

  test('button labels react to a locale change without discarding copy state', async () => {
    await show({ kind: 'info', message: 'Result', copy: true, persistent: true });
    await click('Copy');
    await act(async () => {
      useI18nStore.getState().setLocale('uk');
      for (let attempt = 0; attempt < 50 && !useI18nStore.getState().dictionary['contextPanel.plugin.toast.copied'].includes('Скопійовано'); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    expect(container.textContent).toContain('Скопійовано');
    await click('Гаразд');
    expect(writes).toEqual(['Result']);
  });
});
