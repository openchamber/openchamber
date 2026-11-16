import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Window } from 'happy-dom';
import { dict } from '@/lib/i18n/messages/en';
import { startRootSpace } from '@/lib/spaces/root-activation';
import { confirmRootStart, getRootStartConfirmation, settleRootStartConfirmation } from '@/lib/spaces/root-start-confirmation';

const id = 'a1b2c3d4e5f6';
const fetch = spyOn(globalThis, 'fetch');
const globals = new Map<string, PropertyDescriptor | undefined>();
let container: HTMLDivElement;
let root: Root;
let I18nProvider: typeof import('@/lib/i18n').I18nProvider;
let RootSpaceActivationDialog: typeof import('./RootSpaceActivationDialog').RootSpaceActivationDialog;
let useUIStore: typeof import('@/stores/useUIStore').useUIStore;
beforeEach(async () => {
  const window = new Window({ url: 'http://localhost:3000/' });
  for (const [key, value] of Object.entries({
    window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node, ShadowRoot: window.ShadowRoot,
    Event: window.Event, CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  container = document.createElement('div');
  document.body.append(container);
  // Base UI selects browser effects at import time, after this test owns a DOM.
  const i18n = await import('@/lib/i18n');
  I18nProvider = i18n.I18nProvider;
  ({ useUIStore } = await import('@/stores/useUIStore'));
  ({ RootSpaceActivationDialog } = await import('./RootSpaceActivationDialog'));
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container);
  i18n.useI18nStore.setState({ locale: 'en', dictionary: dict, loadingLocale: null });
});
afterEach(async () => {
  await act(async () => root.unmount());
  settleRootStartConfirmation(false);
  container.remove();
  fetch.mockReset();
  useUIStore.setState({ isMobile: false });
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
});
const render = async (isMobile = false) => {
  useUIStore.setState({ isMobile });
  await act(async () => root.render(<I18nProvider><RootSpaceActivationDialog /></I18nProvider>));
};
const click = async (label: string) => {
  const button = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === label);
  if (!button) throw new Error(`Missing action ${label}`);
  await act(async () => button.click());
};

describe('root activation warning', () => {
  it.each([false, true] as const)('shows unrestricted root access before confirmation, mobile=%s', async (isMobile) => {
    // Given
    await render(isMobile);
    let result!: Promise<boolean>;
    // When
    await act(async () => { result = confirmRootStart(id); });
    // Then
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(dict['spaces.root.warning']);
    expect(getRootStartConfirmation()).toEqual({ spaceId: id });
    // When
    await click(dict['spaces.root.confirm']);
    // Then
    expect(await result).toBe(true);
    expect(getRootStartConfirmation()).toBeNull();
  });

  it('cancels without requesting a challenge when the person dismisses the warning', async () => {
    // Given
    await render();
    let result!: ReturnType<typeof startRootSpace>;
    await act(async () => { result = startRootSpace(id, 'start'); });
    const failure = result.catch((error: Error) => error);
    // When
    await click(dict['spaces.create.cancel']);
    // Then
    expect(await failure).toMatchObject({ code: 'root_activation_cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels without requesting a challenge when the Spaces dialogs unmount', async () => {
    // Given
    await render();
    let result!: ReturnType<typeof startRootSpace>;
    await act(async () => { result = startRootSpace(id, 'restart'); });
    const failure = result.catch((error: Error) => error);
    // When
    await act(async () => root.render(null));
    // Then
    expect(await failure).toMatchObject({ code: 'root_activation_cancelled' });
    expect(fetch).not.toHaveBeenCalled();
    expect(getRootStartConfirmation()).toBeNull();
  });
});
