import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/', width: 1280, height: 800 });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, Event: browser.Event,
  getComputedStyle: browser.getComputedStyle.bind(browser), matchMedia: browser.matchMedia.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});
// React DOM reads the DOM when imported, so it goes in first.
const { createRoot } = await import('react-dom/client');
const { Dialog, DialogContent } = await import('./dialog');
const { I18nProvider } = await import('@/lib/i18n');

let reactRoot: Root | null = null;

const popupFor = async (fullWindow: boolean) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot?.render(
    <I18nProvider>
      <Dialog open>
        <DialogContent fullWindow={fullWindow} aria-label="Window">Body</DialogContent>
      </Dialog>
    </I18nProvider>,
  ));
  return document.querySelector('[data-slot="dialog-content"]');
};

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  reactRoot = null;
  document.body.innerHTML = '';
});

describe('DialogContent', () => {
  test('a dialog takes the installed-app inset and window corners, and a full-window one leaves both out', async () => {
    const docked = await popupFor(false);
    expect(docked?.classList.contains('pwa-dialog-content')).toBe(true);
    expect(docked?.classList.contains('oc-window-corners')).toBe(true);
    await act(async () => reactRoot?.unmount());
    document.body.innerHTML = '';
    const full = await popupFor(true);
    expect(full?.classList.contains('pwa-dialog-content')).toBe(false);
    expect(full?.classList.contains('oc-window-corners')).toBe(false);
  });
});
