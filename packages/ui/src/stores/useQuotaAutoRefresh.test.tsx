import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { initializeRuntimeEndpoint } from '@/lib/runtime-switch';
import { QUOTA_PROVIDERS } from '@/lib/quota';
import { useConfigStore } from './useConfigStore';
import { refreshTrayQuotas, useQuotaAutoRefresh, useQuotaStore } from './useQuotaStore';

test('tray launch seeds dropdown quotas and native openings share freshness even in a hidden window', async () => {
  const dom = installHookTestDom();
  const location = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', { configurable: true, value: { protocol: 'http:' } });
  const root = createRoot(dom.container);
  initializeRuntimeEndpoint({ apiBaseUrl: 'http://localhost:3000', runtimeKey: 'local' });
  const initialized = useConfigStore.getState().isInitialized;
  useConfigStore.setState({ isInitialized: true });
  useQuotaStore.getState().resetForRuntimeSwitch();
  useQuotaStore.setState({ dropdownProviderIds: ['claude'] });
  const actions = { loadSettings: useQuotaStore.getState().loadSettings, fetchProviderQuota: useQuotaStore.getState().fetchProviderQuota };
  let now = 100_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const settings = spyOn(useQuotaStore.getState(), 'loadSettings').mockResolvedValue();
  const fetch = spyOn(useQuotaStore.getState(), 'fetchProviderQuota').mockResolvedValue(true);
  const interval = spyOn(window, 'setInterval');
  const Readout = () => { useQuotaAutoRefresh(); return null; };
  const flush = async (initial = false) => { await act(async () => refreshTrayQuotas(initial)); };
  try {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await flush(true);
    expect(fetch.mock.calls.map(([id]) => id)).toEqual(['claude']);
    now += 20_000;
    await flush(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(interval).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => root.render(<Readout />));
    expect(fetch).toHaveBeenCalledTimes(2);
    now += 15_000;
    await flush();
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    for (const spy of [clock, settings, fetch, interval]) spy.mockRestore();
    useQuotaStore.setState(actions);
    useConfigStore.setState({ isInitialized: initialized });
    useQuotaStore.getState().resetForRuntimeSwitch();
    if (location) Object.defineProperty(window, 'location', location);
    else Reflect.deleteProperty(window, 'location');
    dom.restore();
  }
});

test('another credential change aborts and clears the previous account while its refresh is pending', async () => {
  const dom = installHookTestDom();
  const location = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', { configurable: true, value: { protocol: 'http:' } });
  const root = createRoot(dom.container);
  initializeRuntimeEndpoint({ apiBaseUrl: 'http://localhost:3000', runtimeKey: 'local' });
  const initialized = useConfigStore.getState().isInitialized;
  useConfigStore.setState({ isInitialized: true });
  useQuotaStore.getState().resetForRuntimeSwitch();
  const ensureLoadedForRuntime = useQuotaStore.getState().ensureLoadedForRuntime;
  const ensure = spyOn(useQuotaStore.getState(), 'ensureLoadedForRuntime').mockResolvedValue();
  const Readout = () => { useQuotaAutoRefresh(); return null; };
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  let signal: AbortSignal | null | undefined;
  const network = spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  });
  try {
    await act(async () => root.render(<Readout />));
    ensure.mockImplementation(() => pending);
    const firstChange = useQuotaStore.getState().refreshAfterCredentialChange();
    const oldRequest = useQuotaStore.getState().fetchProviderQuota('claude');
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(network).toHaveBeenCalledTimes(1);
    const sample = { providerId: 'claude' as const, providerName: 'Claude', configured: true, ok: true, usage: null, fetchedAt: 1 };
    useQuotaStore.setState({ results: [sample], loadedRuntimeKey: 'local' });
    const secondChange = useQuotaStore.getState().refreshAfterCredentialChange();
    expect(signal?.aborted).toBe(true);
    expect(useQuotaStore.getState().results).toEqual([]);
    expect(useQuotaStore.getState().loadedRuntimeKey).toBeNull();
    expect(await oldRequest).toBe(false);
    release();
    await Promise.all([firstChange, secondChange]);
    expect(useQuotaStore.getState().results).toEqual([]);
  } finally {
    release();
    await act(async () => root.unmount());
    ensure.mockRestore();
    useQuotaStore.setState({ ensureLoadedForRuntime });
    network.mockRestore();
    useConfigStore.setState({ isInitialized: initialized });
    useQuotaStore.getState().resetForRuntimeSwitch();
    if (location) Object.defineProperty(window, 'location', location);
    else Reflect.deleteProperty(window, 'location');
    dom.restore();
  }
});

test('quota fetches belong to shown readouts and stop while the document is hidden', async () => {
  const dom = installHookTestDom();
  const browserWindow: Window = window;
  const locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', { configurable: true, value: { protocol: 'http:' } });
  const root = createRoot(dom.container);
  initializeRuntimeEndpoint({ apiBaseUrl: 'http://localhost:3000', runtimeKey: 'local' });
  const previousInitialized = useConfigStore.getState().isInitialized;
  useConfigStore.setState({ isInitialized: true });
  useQuotaStore.getState().resetForRuntimeSwitch();
  useQuotaStore.setState({ dropdownProviderIds: ['claude'] });
  let now = 100_000;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const events = new EventTarget();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const interval = spyOn(browserWindow, 'setInterval').mockImplementation((callback: TimerHandler) => {
    if (!(callback instanceof Function)) throw new Error('Quota intervals must use callbacks');
    timers.set(++nextTimer, () => callback());
    return nextTimer;
  });
  const clear = spyOn(window, 'clearInterval').mockImplementation(id => { timers.delete(Number(id)); });
  const add = spyOn(document, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject | null) => {
    if (type !== 'visibilitychange' || !listener) return;
    listeners.add(listener);
    events.addEventListener(type, listener);
  });
  const remove = spyOn(document, 'removeEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject | null) => {
    if (type !== 'visibilitychange' || !listener) return;
    listeners.delete(listener);
    events.removeEventListener(type, listener);
  });
  const settings = spyOn(useQuotaStore.getState(), 'loadSettings').mockResolvedValue();
  const fetch = spyOn(useQuotaStore.getState(), 'fetchProviderQuota').mockResolvedValue(true);
  const Readout = ({ visible = true, all = false }: { visible?: boolean; all?: boolean }) => {
    useQuotaAutoRefresh(visible, all);
    return null;
  };
  const render = async (content: React.ReactNode) => { await act(async () => root.render(content)); };
  const visibility = async (value: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value });
    await act(async () => {
      events.dispatchEvent(new Event('visibilitychange'));
    });
  };
  const tick = async () => {
    now += 180_000;
    await act(async () => { for (const callback of [...timers.values()]) callback(); });
  };
  try {
    await render(null);
    await tick();
    expect(fetch).not.toHaveBeenCalled();
    expect(timers.size).toBe(0);

    await render(<Readout />);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('claude');
    expect(timers.size).toBe(1);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);

    await render(<><Readout /><Readout /></>);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(timers.size).toBe(1);
    await visibility('hidden');
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(timers.size).toBe(0);
    await visibility('visible');
    expect(fetch).toHaveBeenCalledTimes(3);

    await render(null);
    await render(<Readout />);
    expect(fetch).toHaveBeenCalledTimes(3);
    await render(<Readout visible={false} />);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(timers.size).toBe(0);

    await useQuotaStore.getState().refreshAfterCredentialChange();
    expect(fetch).toHaveBeenCalledTimes(3);
    await render(<Readout />);
    expect(fetch).toHaveBeenCalledTimes(4);
    await act(async () => useQuotaStore.getState().refreshAfterCredentialChange());
    expect(fetch).toHaveBeenCalledTimes(5);
    await render(null);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(listeners.size).toBe(0);
    // Settings also shows providers disabled in the compact readouts.
    await render(<Readout all />);
    expect(fetch.mock.calls.slice(5).map(([providerId]) => providerId)).toEqual(QUOTA_PROVIDERS.map(provider => provider.id));
    expect(timers.size).toBe(1);

    await render(null);
    useQuotaStore.getState().resetForRuntimeSwitch();
    useQuotaStore.setState({ dropdownProviderIds: ['claude'] });
    const beforeSlowSettings = fetch.mock.calls.length;
    let finishSettings = () => {};
    const slowSettings = new Promise<void>(resolve => { finishSettings = resolve; });
    settings.mockImplementation(() => slowSettings);
    await render(<Readout />);
    await render(null);
    await act(async () => { finishSettings(); await slowSettings; });
    expect(fetch).toHaveBeenCalledTimes(beforeSlowSettings);
    settings.mockResolvedValue();
    await render(<Readout />);
    expect(fetch).toHaveBeenCalledTimes(beforeSlowSettings + 1);
  } finally {
    await act(async () => root.unmount());
    for (const spy of [clock, interval, clear, add, remove, settings, fetch]) spy.mockRestore();
    useConfigStore.setState({ isInitialized: previousInitialized });
    useQuotaStore.getState().resetForRuntimeSwitch();
    if (locationDescriptor) Object.defineProperty(window, 'location', locationDescriptor);
    else Reflect.deleteProperty(window, 'location');
    dom.restore();
  }
});

test('hidden native windows stop quota requests even when Chromium reports visible', async () => {
  const dom = installHookTestDom();
  const browserWindow: Window = window;
  const root = createRoot(dom.container);
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const events = new EventTarget();
  const nativeWindowProperties = {
    __OPENCHAMBER_ELECTRON__: { configurable: true, value: { runtime: 'electron' } },
    __OPENCHAMBER_DESKTOP__: { configurable: true, value: { invoke: async () => ({ visible: false }) } },
    addEventListener: { configurable: true, value: events.addEventListener.bind(events) },
    removeEventListener: { configurable: true, value: events.removeEventListener.bind(events) },
  };
  for (const [key, descriptor] of Object.entries(nativeWindowProperties)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(window, key));
    Object.defineProperty(window, key, descriptor);
  }
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  initializeRuntimeEndpoint({ apiBaseUrl: 'http://localhost:3000', runtimeKey: 'local' });
  const previousInitialized = useConfigStore.getState().isInitialized;
  useConfigStore.setState({ isInitialized: true });
  useQuotaStore.getState().resetForRuntimeSwitch();
  useQuotaStore.setState({ dropdownProviderIds: ['claude'] });
  let now = 100_000;
  const callbacks: Array<() => void> = [];
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const interval = spyOn(browserWindow, 'setInterval').mockImplementation((callback: TimerHandler) => {
    if (!(callback instanceof Function)) throw new Error('Quota intervals must use callbacks');
    callbacks.push(() => callback());
    return callbacks.length;
  });
  const clear = spyOn(window, 'clearInterval').mockImplementation(() => {});
  const settings = spyOn(useQuotaStore.getState(), 'loadSettings').mockResolvedValue();
  const fetch = spyOn(useQuotaStore.getState(), 'fetchProviderQuota').mockResolvedValue(true);
  const Readout = () => { useQuotaAutoRefresh(); return null; };
  const nativeVisibility = async (visible: boolean) => {
    await act(async () => {
      events.dispatchEvent(new CustomEvent('openchamber:window-visibility', { detail: visible }));
    });
  };
  try {
    await act(async () => root.render(<Readout />));
    expect(fetch).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(0);
    await nativeVisibility(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(callbacks).toHaveLength(1);
    await nativeVisibility(false);
    expect(clear).toHaveBeenCalled();
    now += 180_000;
    // A timer callback already queued by the host must recheck native state.
    await act(async () => callbacks[0]());
    expect(fetch).toHaveBeenCalledTimes(1);
    await nativeVisibility(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    for (const spy of [clock, interval, clear, settings, fetch]) spy.mockRestore();
    useConfigStore.setState({ isInitialized: previousInitialized });
    useQuotaStore.getState().resetForRuntimeSwitch();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(window, key, descriptor);
      else Reflect.deleteProperty(window, key);
    }
    dom.restore();
  }
});
