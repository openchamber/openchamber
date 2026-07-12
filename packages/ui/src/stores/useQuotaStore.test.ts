import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ProviderResult, QuotaProviderId } from '@/types';
import {
  resetQuotaRuntimeFetchForTests,
  setQuotaRuntimeFetchForTests,
  useQuotaStore,
} from './useQuotaStore';

let runtimeFetchImpl: (url: string) => Promise<Response> = async () =>
  new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('useQuotaStore', () => {
  beforeEach(() => {
    runtimeFetchImpl = async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    setQuotaRuntimeFetchForTests((input) => runtimeFetchImpl(String(input)));

    useQuotaStore.setState({
      results: [],
      selectedProviderId: null,
      isLoading: false,
      isFetchingProvider: {},
      lastUpdated: null,
      error: null,
      autoRefresh: false,
      refreshIntervalMs: 60000,
      displayMode: 'usage',
      showPredValues: false,
      dropdownProviderIds: [],
      selectedModels: {},
      expandedFamilies: {},
    });
  });

  afterEach(() => {
    resetQuotaRuntimeFetchForTests();
  });

  test('fetchProviderQuota rejects null response and uses fallback', async () => {
    const providerId: QuotaProviderId = 'openai';
    runtimeFetchImpl = async () =>
      new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });

    await useQuotaStore.getState().fetchProviderQuota(providerId);

    const state = useQuotaStore.getState();
    expect(state.results).toHaveLength(1);
    const result = state.results[0];
    expect(result.providerId).toBe(providerId);
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.usage).toBe(null);
    expect(typeof result.fetchedAt).toBe('number');
  });

  test('fetchProviderQuota rejects invalid JSON and uses fallback', async () => {
    const providerId: QuotaProviderId = 'claude';
    runtimeFetchImpl = async () =>
      new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } });

    await useQuotaStore.getState().fetchProviderQuota(providerId);

    const state = useQuotaStore.getState();
    expect(state.results).toHaveLength(1);
    const result = state.results[0];
    expect(result.providerId).toBe(providerId);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('fetchProviderQuota rejects mismatched providerId and uses fallback', async () => {
    const providerId: QuotaProviderId = 'openai';
    runtimeFetchImpl = async () =>
      new Response(
        JSON.stringify({
          providerId: 'claude',
          providerName: 'Claude',
          ok: true,
          configured: true,
          usage: null,
          fetchedAt: Date.now(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    await useQuotaStore.getState().fetchProviderQuota(providerId);

    const state = useQuotaStore.getState();
    expect(state.results).toHaveLength(1);
    const result = state.results[0];
    expect(result.providerId).toBe(providerId);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('fetchProviderQuota rejects missing required fields and uses fallback', async () => {
    const providerId: QuotaProviderId = 'google';
    runtimeFetchImpl = async () =>
      new Response(
        JSON.stringify({
          providerId,
          // missing providerName
          ok: true,
          configured: true,
          usage: null,
          fetchedAt: Date.now(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    await useQuotaStore.getState().fetchProviderQuota(providerId);

    const state = useQuotaStore.getState();
    expect(state.results).toHaveLength(1);
    const result = state.results[0];
    expect(result.providerId).toBe(providerId);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('fetchProviderQuota rejects non-finite fetchedAt and uses fallback', async () => {
    const providerId: QuotaProviderId = 'github-copilot';
    runtimeFetchImpl = async () =>
      new Response(
        JSON.stringify({
          providerId,
          providerName: 'GitHub Copilot',
          ok: true,
          configured: true,
          usage: null,
          fetchedAt: Infinity,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    await useQuotaStore.getState().fetchProviderQuota(providerId);

    const state = useQuotaStore.getState();
    expect(state.results).toHaveLength(1);
    const result = state.results[0];
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('fetchProviderQuota rejects usage as array and uses fallback', async () => {
    const providerId: QuotaProviderId = 'openai';
    runtimeFetchImpl = async () =>
      new Response(
        JSON.stringify({
          providerId,
          providerName: 'OpenAI',
          ok: true,
          configured: true,
          usage: [],
          fetchedAt: Date.now(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    await useQuotaStore.getState().fetchProviderQuota(providerId);

    const state = useQuotaStore.getState();
    expect(state.results).toHaveLength(1);
    const result = state.results[0];
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('fetchProviderQuota accepts valid payload', async () => {
    const providerId: QuotaProviderId = 'openai';
    const validPayload: ProviderResult = {
      providerId,
      providerName: 'OpenAI',
      ok: true,
      configured: true,
      usage: {
        windows: {
          default: {
            usedPercent: 50,
            remainingPercent: 50,
            windowSeconds: 3600,
            resetAfterSeconds: 1800,
            resetAt: Date.now() + 1800000,
            resetAtFormatted: '2:30 PM',
            resetAfterFormatted: '30 minutes',
          },
        },
      },
      fetchedAt: Date.now(),
    };

    runtimeFetchImpl = async () =>
      new Response(JSON.stringify(validPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    await useQuotaStore.getState().fetchProviderQuota(providerId);

    const state = useQuotaStore.getState();
    expect(state.results).toHaveLength(1);
    const result = state.results[0];
    expect(result.providerId).toBe(providerId);
    expect(result.providerName).toBe('OpenAI');
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeTruthy();
    expect(result.error).toBe(undefined);
  });

  const invalidWindowFields: Array<[string, Record<string, unknown>]> = [
    ['non-finite window number', { usedPercent: 'bad' }],
    ['invalid window string', { resetAtFormatted: 123 }],
    ['invalid optional value label', { valueLabel: false }],
  ];
  for (const [name, invalidField] of invalidWindowFields) {
    test(`fetchProviderQuota rejects ${name} and uses fallback`, async () => {
      const providerId: QuotaProviderId = 'openai';
      const window = {
        usedPercent: 50,
        remainingPercent: 50,
        windowSeconds: 3600,
        resetAfterSeconds: 1800,
        resetAt: 1000,
        resetAtFormatted: 'soon',
        resetAfterFormatted: 'later',
        ...invalidField,
      };
      runtimeFetchImpl = async () => Response.json({
        providerId,
        providerName: 'OpenAI',
        ok: true,
        configured: true,
        usage: { windows: { default: window } },
        fetchedAt: Date.now(),
      });

      await useQuotaStore.getState().fetchProviderQuota(providerId);

      expect(useQuotaStore.getState().results[0]?.ok).toBe(false);
    });
  }

  test('fetchProviderQuota rejects malformed model windows and non-string optional error', async () => {
    const providerId: QuotaProviderId = 'openai';
    runtimeFetchImpl = async () => Response.json({
      providerId,
      providerName: 'OpenAI',
      ok: false,
      configured: true,
      error: null,
      usage: { windows: {}, models: { gpt: { windows: { default: {} } } } },
      fetchedAt: Date.now(),
    });

    await useQuotaStore.getState().fetchProviderQuota(providerId);

    const result = useQuotaStore.getState().results[0];
    expect(result?.ok).toBe(false);
    expect(result?.usage).toBe(null);
    expect(result?.error).toContain('Invalid quota response');
  });

  test('fetchProviderQuota accepts unknown nested extras and a string error', async () => {
    const providerId: QuotaProviderId = 'openai';
    runtimeFetchImpl = async () => Response.json({
      providerId,
      providerName: 'OpenAI',
      ok: false,
      configured: true,
      error: 'limited',
      usage: {
        windows: {},
        models: { gpt: { windows: {}, extra: true } },
        extra: { future: true },
      },
      fetchedAt: Date.now(),
      extra: true,
    });

    await useQuotaStore.getState().fetchProviderQuota(providerId);

    const result = useQuotaStore.getState().results[0];
    expect(result?.error).toBe('limited');
    expect(result?.usage).not.toBe(null);
  });

  test('fetchProviderQuota replaces previous result for same providerId', async () => {
    const providerId: QuotaProviderId = 'claude';
    const oldResult: ProviderResult = {
      providerId,
      providerName: 'Claude',
      ok: false,
      configured: false,
      usage: null,
      fetchedAt: Date.now() - 10000,
    };

    useQuotaStore.setState({ results: [oldResult] });

    const newPayload: ProviderResult = {
      providerId,
      providerName: 'Claude',
      ok: true,
      configured: true,
      usage: null,
      fetchedAt: Date.now(),
    };

    runtimeFetchImpl = async () =>
      new Response(JSON.stringify(newPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    await useQuotaStore.getState().fetchProviderQuota(providerId);

    const state = useQuotaStore.getState();
    expect(state.results).toHaveLength(1);
    expect(state.results[0].ok).toBe(true);
  });
});
