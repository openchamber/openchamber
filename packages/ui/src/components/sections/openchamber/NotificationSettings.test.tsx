import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const globals = {
  window: browser, document: browser.document, navigator: browser.navigator,
  Event: browser.Event, CustomEvent: browser.CustomEvent, PointerEvent: browser.PointerEvent,
  localStorage: browser.localStorage, HTMLElement: browser.HTMLElement, Element: browser.Element,
  Node: browser.Node, ResizeObserver: browser.ResizeObserver, MutationObserver: browser.MutationObserver,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.assign(globalThis, globals);
Object.assign(window, { __OPENCHAMBER_ELECTRON__: { runtime: 'electron' } });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ home: '/home', directory: '/project', project: { directory: '/project' }, data: [] });

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { dict } = await import('@/lib/i18n/messages/en');
const { useUIStore } = await import('@/stores/useUIStore');
const { useRoutingStore } = await import('@/stores/useRoutingStore');
const { NotificationSettings } = await import('./NotificationSettings');
const initialUI = useUIStore.getState();
const initialRouting = useRoutingStore.getState();
const container = document.createElement('div');
document.body.append(container);
let root: ReturnType<typeof createRoot>;
const render = () => act(async () => root.render(<I18nProvider><NotificationSettings /></I18nProvider>));
const classifier = () => container.querySelector<HTMLElement>('[data-settings-item="notifications.classifier"] [role="checkbox"]');

beforeEach(() => {
  root = createRoot(container);
  useUIStore.setState({ nativeNotificationsEnabled: true, notifyOnCompletion: true, notificationClassifierEnabled: false });
  useRoutingStore.setState({ available: true, jevAvailable: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  useUIStore.setState(initialUI, true);
  useRoutingStore.setState(initialRouting, true);
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  container.remove();
  browser.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('the notification classifier can be enabled when Jev is available', async () => {
  // Given
  await render();
  const control = classifier();
  if (!control) throw new Error('Missing notification classifier');

  // When
  await act(async () => control.click());

  // Then
  expect(useUIStore.getState().notificationClassifierEnabled).toBe(true);
  expect(classifier()?.getAttribute('aria-checked')).toBe('true');
});

test('an unavailable Jev keeps the saved preference and offers setup outside the disabled checkbox', async () => {
  // Given
  useUIStore.setState({ notificationClassifierEnabled: true });
  useRoutingStore.setState({ jevAvailable: false });

  // When
  await render();

  // Then
  expect(classifier()?.closest('[role="button"]')?.getAttribute('aria-disabled')).toBe('true');
  expect(classifier()?.getAttribute('aria-checked')).toBe('false');
  expect(useUIStore.getState().notificationClassifierEnabled).toBe(true);
  const setup = [...container.querySelectorAll('button')].find((button) => button.textContent === dict['settings.jevAccess.setUp']);
  expect(setup).toBeDefined();
  expect(setup?.closest('[role="checkbox"]')).toBeNull();
});

for (const settings of [{ nativeNotificationsEnabled: false }, { notifyOnCompletion: false }]) {
  test(`the classifier stays hidden with ${JSON.stringify(settings)}`, async () => {
    // Given
    useUIStore.setState(settings);

    // When
    await render();

    // Then
    expect(classifier()).toBeNull();
  });
}
