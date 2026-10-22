import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { useUIStore } from '@/stores/useUIStore';

import { SessionWorkSettings } from './SessionWorkSettings';

describe('SessionWorkSettings: sessions enter In work', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let initialUi: ReturnType<typeof useUIStore.getState>;
  let initialRouting: ReturnType<typeof useRoutingStore.getState>;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;

  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'];

  beforeEach(() => {
    windowInstance = new Window();
    initialUi = useUIStore.getState();
    initialRouting = useRoutingStore.getState();
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      localStorage: windowInstance.localStorage,
      sessionStorage: windowInstance.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      useUIStore.setState(initialUi, true);
      useRoutingStore.setState(initialRouting, true);
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  const render = async ({ entry, enabled = true, jev }: { entry: 'off' | 'every-message' | 'jev'; enabled?: boolean; jev: boolean }) => {
    useUIStore.setState({ sessionWorkEntry: entry, sessionWorkEnabled: enabled });
    useRoutingStore.setState({ available: true, jevAvailable: jev });
    await act(async () => root.render(
      <I18nProvider>
        <SessionWorkSettings />
      </I18nProvider>,
    ));
    const field = host.querySelector('[data-settings-item="sessions.work-entry"]');
    if (!field) throw new Error('The entry field is missing');
    const buttons = Array.from(field.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'));
    const chip = (label: string): HTMLButtonElement => {
      const found = buttons.find((button) => button.textContent === label);
      if (!found) throw new Error(`No ${label} chip`);
      return found;
    };
    return { chip, buttons };
  };

  test('shows the saved choice and saves a new one', async () => {
    const { chip } = await render({ entry: 'jev', jev: true });
    expect(chip('Jev decides').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Jev decides').disabled).toBe(false);

    await act(async () => chip('Every message').click());
    expect(useUIStore.getState().sessionWorkEntry).toBe('every-message');
  });

  test('without a classification provider Jev decides shows as Off, cannot be picked, and says why', async () => {
    const { chip } = await render({ entry: 'jev', jev: false });
    expect(chip('Off').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Jev decides').getAttribute('aria-pressed')).toBe('false');
    expect(chip('Jev decides').disabled).toBe(true);
    expect(host.textContent).toContain('Jev decides needs a classification provider.');
    // The saved choice comes back once a provider is set up.
    expect(useUIStore.getState().sessionWorkEntry).toBe('jev');
  });

  test('with In work off nothing enters, so every choice is disabled and Off shows', async () => {
    const { chip, buttons } = await render({ entry: 'every-message', enabled: false, jev: true });
    expect(chip('Off').getAttribute('aria-pressed')).toBe('true');
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button.disabled).toBe(true);
  });
});
