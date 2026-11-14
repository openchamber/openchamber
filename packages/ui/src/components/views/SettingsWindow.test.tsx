import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

// The settings contents are unrelated to which surface Cmd/Ctrl+W closes, and
// the target registry has its own tests; this file checks the wiring between
// the window and that registry.
mock.module('./SettingsView', () => ({ SettingsView: () => null }));

const registrations: Array<{
  close: () => void;
  area: { current: Element | null };
  priority: number;
  released: boolean;
}> = [];

mock.module('@/lib/closeTabTarget', () => ({
  registerCloseTabTarget: (
    close: () => void,
    area: { current: Element | null },
    priority = 0,
  ) => {
    const registration = { close, area, priority, released: false };
    registrations.push(registration);
    return () => {
      registration.released = true;
    };
  },
}));

import { I18nProvider } from '@/lib/i18n';
let SettingsWindow: typeof import('./SettingsWindow').SettingsWindow;

let windowInstance: Window;
let host: HTMLDivElement;
let root: Root;
let descriptors: Map<string, PropertyDescriptor | undefined>;

beforeEach(async () => {
  registrations.length = 0;
  windowInstance = new Window({ url: 'http://localhost' });
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    HTMLElement: windowInstance.HTMLElement,
    Element: windowInstance.Element,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
    ResizeObserver: windowInstance.ResizeObserver,
    MutationObserver: windowInstance.MutationObserver,
    requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
    cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
    localStorage: windowInstance.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, globals);
  ({ SettingsWindow } = await import('./SettingsWindow'));
  host = document.createElement('div');
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  await windowInstance.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('an open settings window registers a covering target that closes it', async () => {
  const changes: boolean[] = [];
  await act(async () => {
    root.render(<I18nProvider><SettingsWindow open onOpenChange={(next) => changes.push(next)} /></I18nProvider>);
  });

  expect(registrations).toHaveLength(1);
  const [registration] = registrations;
  expect(registration.priority).toBe(1);
  expect(registration.area.current).not.toBeNull();

  await act(async () => registration.close());
  expect(changes).toEqual([false]);
});

test('closing the settings window releases its target', async () => {
  await act(async () => {
    root.render(<I18nProvider><SettingsWindow open onOpenChange={() => undefined} /></I18nProvider>);
  });
  await act(async () => {
    root.render(<I18nProvider><SettingsWindow open={false} onOpenChange={() => undefined} /></I18nProvider>);
  });

  expect(registrations.map((registration) => registration.released)).toEqual([true]);
});

test('settings that never opened register nothing', async () => {
  await act(async () => {
    root.render(<I18nProvider><SettingsWindow open={false} onOpenChange={() => undefined} /></I18nProvider>);
  });

  expect(registrations).toHaveLength(0);
});
