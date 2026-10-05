import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/useUIStore';
import { TitlebarLeftControls } from './TitlebarLeftControls';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

const OVERLAY_SELECTOR = 'div.app-region-no-drag.absolute.left-0.top-0';

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    InputEvent: browser.InputEvent,
    KeyboardEvent: browser.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function renderControls() {
  await act(async () => root.render(
    <I18nProvider>
      <TooltipProvider>
        <TitlebarLeftControls />
      </TooltipProvider>
    </I18nProvider>,
  ));
}

describe('TitlebarLeftControls', () => {
  test('caps the overlay to the sidebar width when the sidebar is open', async () => {
    useUIStore.getState().setSidebarOpen(true);
    await renderControls();

    const overlay = document.querySelector<HTMLElement>(OVERLAY_SELECTOR);
    expect(overlay).not.toBeNull();
    expect(overlay!.style.maxWidth).toBe('var(--oc-left-sidebar-width, 100%)');
  });

  test('drops the cap when the sidebar is closed', async () => {
    useUIStore.getState().setSidebarOpen(false);
    await renderControls();

    const overlay = document.querySelector<HTMLElement>(OVERLAY_SELECTOR);
    expect(overlay).not.toBeNull();
    expect(overlay!.style.maxWidth).toBe('');
  });

  test('lets the labelled New session button shrink so its label truncates', async () => {
    useUIStore.getState().setSidebarOpen(true);
    await renderControls();

    const button = document.querySelector<HTMLButtonElement>('button.w-auto');
    expect(button).not.toBeNull();
    expect(button!.classList.contains('shrink-0')).toBe(false);
    expect(button!.classList.contains('min-w-0')).toBe(true);

    const label = button!.querySelector<HTMLSpanElement>('span');
    expect(label).not.toBeNull();
    expect(label!.classList.contains('truncate')).toBe(true);

    const icon = button!.querySelector<SVGElement>('svg');
    expect(icon).not.toBeNull();
    expect(icon!.classList.contains('shrink-0')).toBe(true);
  });
});