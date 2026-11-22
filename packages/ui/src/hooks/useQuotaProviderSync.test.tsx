import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { initializeRuntimeEndpoint } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import type { ProviderResult } from '@/types';
import { useQuotaProviderSync } from './useQuotaProviderSync';

const claudeA: ProviderResult = { providerId: 'claude', providerName: 'Claude', ok: true, configured: true, usage: null, fetchedAt: 1, selection: 'home-a' };
const codex: ProviderResult = { providerId: 'codex', providerName: 'Codex', ok: true, configured: true, usage: null, fetchedAt: 1 };

test('a reconnect or home change reconciles only Claude, by its selection revision', async () => {
  const dom = installHookTestDom();
  const location = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', { configurable: true, value: { protocol: 'http:' } });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const originalEventSource = globalThis.EventSource;
  const sources: Array<{ onmessage: ((event: { data: string }) => void) | null }> = [];
  class EventSourceFixture {
    static CLOSED = 2;
    readyState = 1;
    onopen = null;
    onerror = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor() { sources.push(this); }
    close() { this.readyState = EventSourceFixture.CLOSED; }
  }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, writable: true, value: EventSourceFixture });
  const root = createRoot(dom.container);
  initializeRuntimeEndpoint({ apiBaseUrl: 'http://localhost:3000', runtimeKey: 'local' });
  const initialized = useConfigStore.getState().isInitialized;
  useConfigStore.setState({ isInitialized: true });
  useQuotaStore.getState().resetForRuntimeSwitch();
  useQuotaStore.setState({ dropdownProviderIds: ['claude', 'codex'] });
  let claudeResponse: ProviderResult = claudeA;
  const requested: string[] = [];
  let heldProviders: Promise<string[]> | null = null;
  const network = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost:3000');
    if (url.pathname === '/api/quota/extensions') return Response.json({ extensions: [] });
    if (url.pathname === '/api/quota/providers') return Response.json({ providers: heldProviders ? await heldProviders : ['claude', 'codex'] });
    if (url.pathname === '/api/quota/claude') { requested.push('claude'); return Response.json(claudeResponse); }
    if (url.pathname === '/api/quota/codex') { requested.push('codex'); return Response.json(codex); }
    return Response.json({});
  });
  const flush = async () => { for (let index = 0; index < 50; index += 1) await Promise.resolve(); };
  const send = async (type: string) => {
    await act(async () => {
      sources[0].onmessage?.({ data: JSON.stringify({ type, properties: {} }) });
      await flush();
    });
  };
  const ReadoutSync = ({ readout = true }: { readout?: boolean }) => { useQuotaProviderSync(); useQuotaAutoRefresh(readout); return null; };
  const claude = () => useQuotaStore.getState().results.find((entry) => entry.providerId === 'claude');
  try {
    await act(async () => { root.render(<ReadoutSync />); await flush(); });
    expect(sources).toHaveLength(1);
    useQuotaStore.setState({ results: [claudeA, codex], loadedRuntimeKey: 'local' });
    requested.length = 0;

    // Same home, failed refresh: the numbers stay as a transient failure.
    claudeResponse = { ...claudeA, ok: false, error: 'socket hang up' };
    await send('openchamber:event-stream-ready');
    expect(requested).toEqual(['claude']);
    expect(claude()).toEqual(claudeA);

    // Another client changed the home during a gap; only readiness arrives here.
    const unavailable = { ...claudeA, ok: false, error: 'Selected Claude home is unavailable', selection: 'home-b' };
    claudeResponse = unavailable;
    await send('openchamber:event-stream-ready');
    expect(claude()).toEqual(unavailable);
    expect(useQuotaStore.getState().results.find((entry) => entry.providerId === 'codex')).toEqual(codex);

    // An announced home change drops Claude at once and reads the new home; other providers stay.
    useQuotaStore.setState({ results: [claudeA, codex] });
    requested.length = 0;
    await send('openchamber:quota-credentials-changed');
    expect(requested).toEqual(['claude']);
    expect(claude()).toEqual(unavailable);
    expect(useQuotaStore.getState().results.find((entry) => entry.providerId === 'codex')).toEqual(codex);

    // A provider list requested before the home change cannot erase the new home's result when it lands.
    const claudeB: ProviderResult = { ...claudeA, selection: 'home-b', fetchedAt: 2 };
    claudeResponse = claudeB;
    let releaseProviders: (providers: string[]) => void = () => undefined;
    heldProviders = new Promise((resolve) => { releaseProviders = resolve; });
    const staleList = useQuotaStore.getState().fetchQuotas(['claude', 'codex']);
    await flush();
    await send('openchamber:quota-credentials-changed');
    expect(claude()).toEqual(claudeB);
    await act(async () => { releaseProviders(['codex']); await staleList; await flush(); });
    heldProviders = null;
    expect(claude()).toEqual(claudeB);

    // A home change while nothing shows usage leaves Claude to the next readout that opens.
    await act(async () => { root.render(<ReadoutSync readout={false} />); await flush(); });
    useQuotaStore.setState({ results: [claudeA, codex], loadedRuntimeKey: 'local' });
    requested.length = 0;
    await send('openchamber:quota-credentials-changed');
    expect(requested).toEqual([]);
    expect(claude()).toBeUndefined();
    expect(useQuotaStore.getState().results.find((entry) => entry.providerId === 'codex')).toEqual(codex);
    expect(useQuotaStore.getState().loadedRuntimeKey).toBeNull();
    await act(async () => { root.render(<ReadoutSync />); await flush(); });
    await act(async () => { await flush(); });
    expect(requested).toContain('claude');
  } finally {
    await act(async () => root.unmount());
    network.mockRestore();
    useConfigStore.setState({ isInitialized: initialized });
    useQuotaStore.getState().resetForRuntimeSwitch();
    Object.defineProperty(globalThis, 'EventSource', { configurable: true, writable: true, value: originalEventSource });
    if (location) Object.defineProperty(window, 'location', location);
    else Reflect.deleteProperty(window, 'location');
    dom.restore();
  }
});
