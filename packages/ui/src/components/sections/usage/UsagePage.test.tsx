import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  Event: browser.Event,
  CustomEvent: browser.CustomEvent,
  ResizeObserver: browser.ResizeObserver,
  MutationObserver: browser.MutationObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = new URL(input instanceof Request ? input.url : input, browser.location.href);
  if (url.pathname === '/api/fs/home') return Response.json({ home: '/workspace', chatsRoot: '/workspace/chats' });
  if (url.pathname === '/api/config/settings') return Response.json({});
  throw new Error(`Unexpected request: ${url}`);
});
afterAll(async () => {
  fetchSpy.mockRestore();
  await browser.close();
});

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useQuotaStore } = await import('@/stores/useQuotaStore');
const { UsagePage } = await import('./UsagePage');

test('attributes fallback Go meters and Console sign-in budgets to their own sources', async () => {
  const previous = useQuotaStore.getState();
  const fetchedAt = Date.now();
  useQuotaStore.setState({
    selectedProviderId: 'opencode-go',
    lastUpdated: fetchedAt,
    results: [{
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: true,
      configured: true,
      accountLabel: 'Personal Go key',
      fetchedAt,
      usage: {
        windows: {
          '5h': {
            usedPercent: 25, remainingPercent: 75, windowSeconds: 18_000,
            resetAfterSeconds: null, resetAt: null, resetAtFormatted: null, resetAfterFormatted: null,
          },
        },
        consoleBudgets: {
          workspace: 'Acme Console',
          budgets: [{
            id: 'bud_1', limit: 50, spent: 10, usedPercent: 20, reached: false,
            resetsAt: fetchedAt + 60_000, sharing: 'you', kind: 'all',
            perModel: false, vendors: [], models: [], inputPriceAtLeast: null,
          }],
        },
      },
    }],
  });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(<I18nProvider><UsagePage /></I18nProvider>));

    const pageHeading = container.querySelector('h1');
    expect(pageHeading?.parentElement?.parentElement?.textContent).not.toContain('Personal Go key');
    const meter = container.querySelector('[aria-valuenow="25"]');
    expect(meter?.closest('section')?.textContent).toContain('Personal Go key');
    expect(meter?.closest('section')?.textContent).not.toContain('Acme Console');
    const budget = container.querySelector('[aria-valuenow="20"]');
    expect(budget?.closest('section')?.textContent).toContain('Acme Console');
    expect(budget?.closest('section')?.textContent).not.toContain('Personal Go key');
  } finally {
    await React.act(async () => root.unmount());
    useQuotaStore.setState(previous);
    container.remove();
  }
});
