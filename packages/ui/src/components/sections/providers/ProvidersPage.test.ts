import { describe, expect, test } from 'bun:test';
import { shouldLoadAvailableProviders } from './providerAvailability';
import {
  filterUnconnectedProviders,
  groupProviderOptions,
  startProviderOAuth,
  type ProviderOAuthDetails,
  type ProviderOption,
} from './providerConnect';

function createState<T>(initial: T) {
  let current = initial;
  const updates: T[] = [];

  return {
    get value() {
      return current;
    },
    updates,
    set(next: T | ((value: T) => T)) {
      current = typeof next === 'function' ? (next as (value: T) => T)(current) : next;
      updates.push(current);
    },
  };
}

describe('ProvidersPage available provider loading', () => {
  test('loads available providers only in add-provider mode', () => {
    expect(shouldLoadAvailableProviders(false)).toBe(false);
    expect(shouldLoadAvailableProviders(true)).toBe(true);
  });

  test('empty search preserves the original provider list reference', () => {
    const providers: ProviderOption[] = [
      { id: 'openai', name: 'OpenAI' },
      { id: 'anthropic', name: 'Anthropic' },
    ];

    expect(filterUnconnectedProviders(providers, '')).toBe(providers);
    expect(filterUnconnectedProviders(providers, '   ')).toBe(providers);
  });

  test('search matches provider name and id case-insensitively', () => {
    const providers: ProviderOption[] = [
      { id: 'openai-compatible', name: 'Custom OpenAI' },
      { id: 'anthropic', name: 'Anthropic' },
      { id: 'gemini', name: 'Google Gemini' },
    ];

    expect(filterUnconnectedProviders(providers, 'OPENAI')).toEqual([{ id: 'openai-compatible', name: 'Custom OpenAI' }]);
    expect(filterUnconnectedProviders(providers, 'thro')).toEqual([{ id: 'anthropic', name: 'Anthropic' }]);
    expect(filterUnconnectedProviders(providers, 'gem')).toEqual([{ id: 'gemini', name: 'Google Gemini' }]);
  });

  test('groups providers in 0-9, A-Z, then # order', () => {
    const grouped = groupProviderOptions([
      { id: 'zeta', name: 'Zeta' },
      { id: '3p-provider', name: '3P Provider' },
      { id: 'anthropic', name: 'Anthropic' },
      { id: 'emoji', name: '🙂 Emoji Cloud' },
      { id: 'beta', name: 'Beta' },
    ]);

    expect(grouped).toEqual([
      ['0-9', [{ id: '3p-provider', name: '3P Provider' }]],
      ['A', [{ id: 'anthropic', name: 'Anthropic' }]],
      ['B', [{ id: 'beta', name: 'Beta' }]],
      ['Z', [{ id: 'zeta', name: 'Zeta' }]],
      ['#', [{ id: 'emoji', name: '🙂 Emoji Cloud' }]],
    ]);
  });

  test('starts provider OAuth once, stores returned details, and does not auto-open a browser window', async () => {
    const authBusyState = createState<string | null>(null);
    const oauthDetailsState = createState<Record<string, ProviderOAuthDetails>>({});
    const pendingState = createState<{ providerId: string; methodIndex: number } | null>(null);
    const toastMessageCalls: string[] = [];
    const toastErrorCalls: string[] = [];
    const windowOpenCalls: unknown[][] = [];
    const windowOpen = (...args: unknown[]) => {
      windowOpenCalls.push(args);
      return null;
    };
    (globalThis as { window?: { open: typeof windowOpen } }).window = { open: windowOpen };

    await startProviderOAuth({
      providerId: 'openai',
      methodIndex: 0,
      authorize: async () => ({
        data: {
          verification_uri_complete: 'https://example.com/oauth',
          user_code: 'ABC123',
        },
      }),
      authBusyKeyRef: { current: null },
      setAuthBusyKey: (value) => authBusyState.set(value as string | null | ((current: string | null) => string | null)),
      setOauthDetails: (value) => oauthDetailsState.set(value as Record<string, ProviderOAuthDetails> | ((current: Record<string, ProviderOAuthDetails>) => Record<string, ProviderOAuthDetails>)),
      setPendingOAuth: (value) => pendingState.set(value as { providerId: string; methodIndex: number } | null | ((current: { providerId: string; methodIndex: number } | null) => { providerId: string; methodIndex: number } | null)),
      toastMessage: (message) => {
        toastMessageCalls.push(message);
      },
      toastError: (message) => {
        toastErrorCalls.push(message);
      },
      t: (key) => key,
    });

    expect(oauthDetailsState.value).toEqual({
      'openai:0': {
        url: 'https://example.com/oauth',
        userCode: 'ABC123',
      },
    });
    expect(pendingState.value).toEqual({ providerId: 'openai', methodIndex: 0 });
    expect(authBusyState.updates).toEqual(['oauth:openai:0', null]);
    expect(toastMessageCalls).toEqual(['settings.providers.page.toast.completeOAuthInBrowser']);
    expect(toastErrorCalls).toEqual([]);
    expect(windowOpenCalls).toEqual([]);
    delete (globalThis as { window?: unknown }).window;
  });

  test('deduplicates concurrent OAuth starts for the same provider key', async () => {
    const authBusyState = createState<string | null>(null);
    const oauthDetailsState = createState<Record<string, ProviderOAuthDetails>>({});
    const pendingState = createState<{ providerId: string; methodIndex: number } | null>(null);
    const toastMessageCalls: string[] = [];
    const toastErrorCalls: string[] = [];
    let authorizeCalls = 0;
    let resolveAuthorize!: (value: { data: unknown }) => void;
    const authorize = () => {
      authorizeCalls += 1;
      return new Promise<{ data: unknown }>((resolve) => {
        resolveAuthorize = resolve;
      });
    };
    const authBusyKeyRef = { current: null as string | null };

    const first = startProviderOAuth({
      providerId: 'openai',
      methodIndex: 1,
      authorize,
      authBusyKeyRef,
      setAuthBusyKey: (value) => authBusyState.set(value as string | null | ((current: string | null) => string | null)),
      setOauthDetails: (value) => oauthDetailsState.set(value as Record<string, ProviderOAuthDetails> | ((current: Record<string, ProviderOAuthDetails>) => Record<string, ProviderOAuthDetails>)),
      setPendingOAuth: (value) => pendingState.set(value as { providerId: string; methodIndex: number } | null | ((current: { providerId: string; methodIndex: number } | null) => { providerId: string; methodIndex: number } | null)),
      toastMessage: (message) => {
        toastMessageCalls.push(message);
      },
      toastError: (message) => {
        toastErrorCalls.push(message);
      },
      t: (key) => key,
    });
    const second = startProviderOAuth({
      providerId: 'openai',
      methodIndex: 1,
      authorize,
      authBusyKeyRef,
      setAuthBusyKey: (value) => authBusyState.set(value as string | null | ((current: string | null) => string | null)),
      setOauthDetails: (value) => oauthDetailsState.set(value as Record<string, ProviderOAuthDetails> | ((current: Record<string, ProviderOAuthDetails>) => Record<string, ProviderOAuthDetails>)),
      setPendingOAuth: (value) => pendingState.set(value as { providerId: string; methodIndex: number } | null | ((current: { providerId: string; methodIndex: number } | null) => { providerId: string; methodIndex: number } | null)),
      toastMessage: (message) => {
        toastMessageCalls.push(message);
      },
      toastError: (message) => {
        toastErrorCalls.push(message);
      },
      t: (key) => key,
    });

    expect(authorizeCalls).toBe(1);
    expect(authBusyKeyRef.current).toBe('oauth:openai:1');

    resolveAuthorize({ data: { verification_uri: 'https://example.com/device' } });
    expect(await second).toBe(false);
    expect(await first).toBe(true);

    expect(oauthDetailsState.value).toEqual({
      'openai:1': {
        url: 'https://example.com/device',
      },
    });
    expect(pendingState.value).toEqual({ providerId: 'openai', methodIndex: 1 });
    expect(authBusyState.updates).toEqual(['oauth:openai:1', null]);
    expect(toastMessageCalls).toEqual(['settings.providers.page.toast.completeOAuthInBrowser']);
    expect(toastErrorCalls).toEqual([]);
  });
});
