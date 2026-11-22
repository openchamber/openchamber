import React, { act } from 'react';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { Session } from '@/lib/opencode/model';

const dom = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    location: dom.location,
    localStorage: dom.localStorage,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    Node: dom.Node,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    KeyboardEvent: dom.KeyboardEvent,
    MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent,
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
});

afterAll(() => {
  dom.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const renderTrigger = async (isMobile: boolean) => {
  const { createRoot } = await import('react-dom/client');
  const { ScheduledTaskTargetPicker } = await import('./ScheduledTaskTargetPicker');
  const { I18nProvider } = await import('@/lib/i18n');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ScheduledTaskTargetPicker value="" eligible={[]} known={[]} load="ready" isMobile={isMobile} onSelect={() => {}} />
      </I18nProvider>,
    ));
    const trigger = container.querySelector('button');
    return { haspopup: trigger?.getAttribute('aria-haspopup') ?? null, expanded: trigger?.getAttribute('aria-expanded') ?? null };
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
};

describe('ScheduledTaskTargetPicker trigger', () => {
  test('on desktop the field says it opens a menu and whether it is open', async () => {
    expect(await renderTrigger(false)).toEqual({ haspopup: 'menu', expanded: 'false' });
  });

  test('on a phone the field says it opens a dialog', async () => {
    expect(await renderTrigger(true)).toEqual({ haspopup: 'dialog', expanded: 'false' });
  });
});

describe('ScheduledTaskTargetPicker keyboard', () => {
  test('Ctrl+N/P in search moves the highlight once per press on a non-Latin layout', async () => {
    const { createRoot } = await import('react-dom/client');
    const { ScheduledTaskTargetPicker } = await import('./ScheduledTaskTargetPicker');
    const { I18nProvider } = await import('@/lib/i18n');
    // SAFETY: sessions as the stores hold them; the picker reads id, title, parentID, metadata and time.
    const sessions = ['ses_a', 'ses_b', 'ses_c'].map((id, index): Session => ({
      id, title: `Session ${id}`, directory: '/work/app', projectID: 'p', cost: 0, time: { created: 0, updated: 10 - index },
    } as Session));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(
        <I18nProvider>
          <ScheduledTaskTargetPicker value="" eligible={sessions} known={sessions} load="ready" isMobile={false} onSelect={() => {}} />
        </I18nProvider>,
      ));
      const trigger = container.querySelector('button');
      await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
        trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      });
      const input = document.querySelector('[cmdk-input]');
      expect(input).not.toBeNull();
      const highlighted = () => document.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-value') ?? null;
      const press = async (key: string, code: string) => act(async () => {
        input?.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey: true, bubbles: true, cancelable: true }));
      });
      const start = highlighted();
      expect(start).toBe('ses_a');
      await press('т', 'KeyN');
      expect(highlighted()).toBe('ses_b');
      await press('т', 'KeyN');
      expect(highlighted()).toBe('ses_c');
      await press('з', 'KeyP');
      expect(highlighted()).toBe('ses_b');
      await act(async () => {
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }));
      });
      expect(highlighted()).toBe('ses_b');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
