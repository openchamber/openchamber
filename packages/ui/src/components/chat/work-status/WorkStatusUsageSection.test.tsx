import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { getBackgroundNetworkState, runBackgroundNetworkTask } from '@/lib/background-network';
import { useConfigStore } from '@/stores/useConfigStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { WorkStatusUsageSection } from './WorkStatusUsageSection';

test('initial visible usage waits for readiness, then runs ahead of queued background metadata', async () => {
  const dom = installHookTestDom();
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
    dom.restore();
  }
});
