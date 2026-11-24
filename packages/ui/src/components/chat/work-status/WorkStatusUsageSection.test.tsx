import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { getBackgroundNetworkState, runBackgroundNetworkTask } from '@/lib/background-network';
import { useConfigStore } from '@/stores/useConfigStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { WorkStatusUsageSection } from './WorkStatusUsageSection';

test('the collapsed headline shows the compacted count the row shows', async () => {
  const dom = new Window({ url: 'http://usage.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    Event: dom.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const previousQuota = useQuotaStore.getState();
  const previousProvider = useConfigStore.getState().currentProviderId;
  const load = spyOn(useQuotaStore.getState(), 'ensureLoadedForRuntime').mockImplementation(async () => {});
  try {
    useConfigStore.setState({ currentProviderId: 'github-copilot' });
    useQuotaStore.setState({
      dropdownProviderIds: ['github-copilot'],
      results: [{
        providerId: 'github-copilot',
        providerName: 'GitHub Copilot',
        ok: true,
        configured: true,
        fetchedAt: 0,
        usage: { windows: { premium_interactions: {
          usedPercent: 19.8,
          remainingPercent: 80.2,
          windowSeconds: null,
          resetAfterSeconds: null,
          resetAt: null,
          resetAtFormatted: null,
          resetAfterFormatted: null,
          valueLabel: '4,074.9 / 20,000 used',
          credits: { used: 4074.9, limit: 20000 },
        } } },
      }],
    });
    await act(async () => root.render(<I18nProvider><WorkStatusUsageSection /></I18nProvider>));
    const heading = container.querySelector('button[aria-expanded]')?.textContent ?? '';
    expect(heading).toContain('AI Credits4.1K / 20K');
    expect(heading).not.toContain('used');
  } finally {
    await act(async () => root.unmount());
    load.mockRestore();
    useQuotaStore.setState({ dropdownProviderIds: previousQuota.dropdownProviderIds, results: previousQuota.results });
    useConfigStore.setState({ currentProviderId: previousProvider });
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('initial visible usage waits for readiness, then runs ahead of queued background metadata', async () => {
  const dom = installHookTestDom();
  const locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', { configurable: true, value: { protocol: 'http:' } });
  const root = createRoot(dom.container);
  const previousInitialized = useConfigStore.getState().isInitialized;
  const order: string[] = [];
  const release: Array<() => void> = [];
  const occupied = Array.from({ length: getBackgroundNetworkState().limit }, () =>
    runBackgroundNetworkTask(() => new Promise<void>((resolve) => release.push(resolve))),
  );
  const metadata = runBackgroundNetworkTask(async () => { order.push('metadata'); });
  const load = spyOn(useQuotaStore.getState(), 'ensureLoadedForRuntime').mockImplementation(async () => {
    order.push('usage');
  });
  try {
    useConfigStore.setState({ isInitialized: false });
    await act(async () => root.render(<I18nProvider><WorkStatusUsageSection /></I18nProvider>));
    expect(load.mock.calls.length).toBe(0);
    await act(async () => useConfigStore.setState({ isInitialized: true }));
    expect(load.mock.calls.length).toBe(0);
    await act(async () => {
      for (const resolve of release) resolve();
      await Promise.all([...occupied, metadata]);
    });
    expect(order).toEqual(['usage', 'metadata']);
    expect(load.mock.calls.length).toBe(1);
    expect(getBackgroundNetworkState().active).toBe(0);
  } finally {
    for (const resolve of release) resolve();
    await Promise.all([...occupied, metadata]);
    await act(async () => root.unmount());
    load.mockRestore();
    useConfigStore.setState({ isInitialized: previousInitialized });
    if (locationDescriptor) Object.defineProperty(window, 'location', locationDescriptor);
    else Reflect.deleteProperty(window, 'location');
    dom.restore();
  }
});
