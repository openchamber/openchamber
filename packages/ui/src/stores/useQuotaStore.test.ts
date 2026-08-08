import { afterEach, describe, expect, test } from 'bun:test';

import { QUOTA_PROVIDERS } from '@/lib/quota';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { useQuotaStore } from './useQuotaStore';

const originalFetchProviderQuota = useQuotaStore.getState().fetchProviderQuota;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  useQuotaStore.setState({
    results: [],
    isLoading: false,
    isFetchingProvider: {},
    lastUpdated: null,
    error: null,
    fetchProviderQuota: originalFetchProviderQuota,
  });
});

describe('quota refresh', () => {
  test('preserves results and shares the pending full refresh with duplicate callers', async () => {
    let finishProviderFetch!: () => void;
    const providerFetch = new Promise<void>((resolve) => {
      finishProviderFetch = resolve;
    });
    const fetchedProviderIds: QuotaProviderId[] = [];
    const fetchProviderQuota = async (providerId: QuotaProviderId) => {
      fetchedProviderIds.push(providerId);
      await providerFetch;
    };
    const existingResults: ProviderResult[] = [{
      providerId: 'claude',
      providerName: 'Claude',
      ok: true,
      configured: true,
      usage: null,
      fetchedAt: 1,
    }];
    useQuotaStore.setState({ results: existingResults, fetchProviderQuota });

    const firstRefresh = useQuotaStore.getState().fetchAllQuotas();
    const duplicateRefresh = useQuotaStore.getState().fetchAllQuotas();
    let duplicateSettled = false;
    void duplicateRefresh.then(() => {
      duplicateSettled = true;
    });

    await Promise.resolve();

    expect(duplicateRefresh).toBe(firstRefresh);
    expect(useQuotaStore.getState().results).toBe(existingResults);
    expect(fetchedProviderIds).toEqual(QUOTA_PROVIDERS.map((provider) => provider.id));
    expect(duplicateSettled).toBe(false);

    finishProviderFetch();
    await Promise.all([firstRefresh, duplicateRefresh]);
    expect(duplicateSettled).toBe(true);
    expect(useQuotaStore.getState().isLoading).toBe(false);
  });

  test('clears loading after an unexpected provider rejection', async () => {
    useQuotaStore.setState({
      fetchProviderQuota: async () => {
        throw new Error('unexpected failure');
      },
    });

    await useQuotaStore.getState().fetchAllQuotas();

    expect(useQuotaStore.getState().isLoading).toBe(false);
    expect(useQuotaStore.getState().error).toBe('unexpected failure');
  });

  test('deduplicates per runtime without joining another runtime request', async () => {
    const originalApiBaseUrl = getRuntimeApiBaseUrl();
    const originalRuntimeKey = getRuntimeKey();
    let finishRuntimeA!: () => void;
    let finishRuntimeB!: () => void;
    const runtimeAProviderFetch = new Promise<void>((resolve) => {
      finishRuntimeA = resolve;
    });
    const runtimeBProviderFetch = new Promise<void>((resolve) => {
      finishRuntimeB = resolve;
    });
    const callsByRuntime = new Map<string, number>();
    useQuotaStore.setState({
      fetchProviderQuota: async () => {
        const runtimeKey = getRuntimeKey();
        callsByRuntime.set(runtimeKey, (callsByRuntime.get(runtimeKey) ?? 0) + 1);
        await (runtimeKey === 'runtime-a' ? runtimeAProviderFetch : runtimeBProviderFetch);
      },
    });

    let runtimeARequest: Promise<void> | null = null;
    let runtimeBRequest: Promise<void> | null = null;
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.test', runtimeKey: 'runtime-a' });
      runtimeARequest = useQuotaStore.getState().fetchAllQuotas();
      expect(useQuotaStore.getState().fetchAllQuotas()).toBe(runtimeARequest);

      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.test', runtimeKey: 'runtime-b' });
      runtimeBRequest = useQuotaStore.getState().fetchAllQuotas();
      expect(runtimeBRequest).not.toBe(runtimeARequest);
      expect(useQuotaStore.getState().fetchAllQuotas()).toBe(runtimeBRequest);
      expect(callsByRuntime.get('runtime-a')).toBe(QUOTA_PROVIDERS.length);
      expect(callsByRuntime.get('runtime-b')).toBe(QUOTA_PROVIDERS.length);

      finishRuntimeA();
      await runtimeARequest;
      expect(useQuotaStore.getState().fetchAllQuotas()).toBe(runtimeBRequest);
      expect(useQuotaStore.getState().isLoading).toBe(true);

      finishRuntimeB();
      await runtimeBRequest;
    } finally {
      finishRuntimeA();
      finishRuntimeB();
      await Promise.allSettled([runtimeARequest, runtimeBRequest].filter((request): request is Promise<void> => request !== null));
      switchRuntimeEndpoint({ apiBaseUrl: originalApiBaseUrl, runtimeKey: originalRuntimeKey });
    }
  });

  test('clears loading when an old runtime finishes and the current runtime is idle', async () => {
    const originalApiBaseUrl = getRuntimeApiBaseUrl();
    const originalRuntimeKey = getRuntimeKey();
    let finishRuntimeA!: () => void;
    const runtimeAProviderFetch = new Promise<void>((resolve) => {
      finishRuntimeA = resolve;
    });
    useQuotaStore.setState({
      fetchProviderQuota: async () => {
        await runtimeAProviderFetch;
      },
    });

    let runtimeARequest: Promise<void> | null = null;
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.test', runtimeKey: 'runtime-a' });
      runtimeARequest = useQuotaStore.getState().fetchAllQuotas();
      expect(useQuotaStore.getState().isLoading).toBe(true);

      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.test', runtimeKey: 'runtime-b' });
      finishRuntimeA();
      await runtimeARequest;

      expect(useQuotaStore.getState().isLoading).toBe(false);
    } finally {
      finishRuntimeA();
      if (runtimeARequest) await runtimeARequest;
      switchRuntimeEndpoint({ apiBaseUrl: originalApiBaseUrl, runtimeKey: originalRuntimeKey });
    }
  });

  test('does not commit a provider response after the runtime changes', async () => {
    const originalApiBaseUrl = getRuntimeApiBaseUrl();
    const originalRuntimeKey = getRuntimeKey();
    let finishRuntimeA!: (response: Response) => void;
    const runtimeAResponse = new Promise<Response>((resolve) => {
      finishRuntimeA = resolve;
    });
    const runtimeBResult: ProviderResult = {
      providerId: 'claude',
      providerName: 'Runtime B Claude',
      ok: true,
      configured: true,
      usage: null,
      fetchedAt: 2,
    };
    globalThis.fetch = (async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/api/quota/claude')) return runtimeAResponse;
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    let runtimeARequest: Promise<void> | null = null;
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.test', runtimeKey: 'runtime-a' });
      runtimeARequest = useQuotaStore.getState().fetchProviderQuota('claude');
      await Promise.resolve();

      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.test', runtimeKey: 'runtime-b' });
      useQuotaStore.getState().resetForRuntimeSwitch();
      useQuotaStore.setState({ results: [runtimeBResult] });

      finishRuntimeA(new Response(JSON.stringify({
        providerId: 'claude',
        providerName: 'Runtime A Claude',
        ok: true,
        configured: true,
        usage: null,
        fetchedAt: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      await runtimeARequest;

      expect(useQuotaStore.getState().results).toEqual([runtimeBResult]);
      expect(useQuotaStore.getState().isFetchingProvider).toEqual({});
    } finally {
      finishRuntimeA(new Response(null, { status: 500 }));
      if (runtimeARequest) await runtimeARequest;
      switchRuntimeEndpoint({ apiBaseUrl: originalApiBaseUrl, runtimeKey: originalRuntimeKey });
      useQuotaStore.getState().resetForRuntimeSwitch();
    }
  });

  test('invalidates a pending full refresh when the runtime resets', async () => {
    let finishProviderFetch!: () => void;
    const providerFetch = new Promise<void>((resolve) => {
      finishProviderFetch = resolve;
    });
    useQuotaStore.setState({
      fetchProviderQuota: async () => providerFetch,
      autoRefresh: true,
      refreshIntervalMs: 30000,
      displayMode: 'remaining',
      showPredValues: true,
      dropdownProviderIds: ['claude'],
      selectedModels: { claude: ['opus'] },
      expandedFamilies: { claude: ['opus'] },
    });

    const pendingRefresh = useQuotaStore.getState().fetchAllQuotas();
    useQuotaStore.getState().resetForRuntimeSwitch();
    const resetState = useQuotaStore.getState();
    expect({
      autoRefresh: resetState.autoRefresh,
      refreshIntervalMs: resetState.refreshIntervalMs,
      displayMode: resetState.displayMode,
      showPredValues: resetState.showPredValues,
      dropdownProviderIds: resetState.dropdownProviderIds,
      selectedModels: resetState.selectedModels,
      expandedFamilies: resetState.expandedFamilies,
    }).toEqual({
      autoRefresh: false,
      refreshIntervalMs: 60000,
      displayMode: 'usage',
      showPredValues: false,
      dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
      selectedModels: {},
      expandedFamilies: {},
    });
    const currentResults: ProviderResult[] = [{
      providerId: 'codex',
      providerName: 'Current runtime Codex',
      ok: true,
      configured: true,
      usage: null,
      fetchedAt: 2,
    }];
    useQuotaStore.setState({ results: currentResults });

    finishProviderFetch();
    await pendingRefresh;

    expect(useQuotaStore.getState().results).toBe(currentResults);
    expect(useQuotaStore.getState().lastUpdated).toBeNull();
    expect(useQuotaStore.getState().isLoading).toBe(false);
  });
});
