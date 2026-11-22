import { beforeEach, describe, expect, jest, mock, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { SourceControlAuthStatus, SourceControlIdentity } from '@/lib/api/types';
import { getSourceControlAuthKey, getSourceControlReadContextAuthState, useSourceControlAuthStore } from './useSourceControlAuthStore';

const identity = { provider: 'gitlab', instance: 'https://gitlab.example.com' } satisfies SourceControlIdentity;
const connectedStatus: SourceControlAuthStatus = {
  ...identity,
  status: 'connected',
  connected: true,
  user: { ...identity, id: 'user-one', username: 'account-owner' },
  accounts: [{
    id: 'account-one',
    credentialId: 'account-one',
    credentialRevision: 1,
    providerUserId: 'user-one',
    providerUserStatus: 'available',
    user: { ...identity, id: 'user-one', username: 'account-owner' },
    current: true,
    source: 'pat',
    status: 'valid',
  }],
  cli: { available: true, disabled: false, active: false },
};
const readContext = {
  ...identity,
  accountId: 'account-one',
  repositoryId: 'repo',
  bindingRevision: 1,
  directory: '/repo',
  primaryRemote: 'origin',
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useSourceControlAuthStore.getState().resetForRuntimeSwitch();
});

describe('source-control auth store', () => {
  test('requires the bound account to be valid in the checked inventory', () => {
    const context = {
      provider: 'github' as const,
      instance: 'github.com',
      accountId: 'account-bound',
      repositoryId: 'repo',
      bindingRevision: 1,
      directory: '/repo',
      primaryRemote: 'origin',
    };
    const status: SourceControlAuthStatus = {
      provider: 'github',
      instance: 'github.com',
      status: 'connected',
      connected: true,
      user: { provider: 'github', instance: 'github.com', id: '1', username: 'other', name: 'Other' },
      accounts: [
        { id: 'account-bound', credentialId: 'account-bound', credentialRevision: 1, providerUserId: 'github.com#1', providerUserStatus: 'unavailable', user: { provider: 'github', instance: 'github.com', id: '1', username: 'bound' }, current: false, source: 'oauth', status: 'invalid' },
        { id: 'account-other', credentialId: 'account-other', credentialRevision: 1, providerUserId: 'github.com#2', providerUserStatus: 'available', user: { provider: 'github', instance: 'github.com', id: '2', username: 'other' }, current: true, source: 'oauth', status: 'valid' },
      ],
    };

    expect(status.connected).toBe(true);
    expect(getSourceControlReadContextAuthState({ status, isLoading: false, hasChecked: true }, context))
      .toEqual({ authChecked: true, connected: false });
    expect(getSourceControlReadContextAuthState(undefined, context))
      .toEqual({ authChecked: false, connected: false });
  });
  test('deduplicates instance discovery and preserves the last complete list on failure', async () => {
    let calls = 0;
    let fail = false;
    const sourceControl = {
      authInstances: mock(async () => {
        calls += 1;
        if (fail) throw new Error('offline');
        return [identity];
      }),
    };
    await Promise.all([
      useSourceControlAuthStore.getState().refreshInstances(sourceControl, { force: true }),
      useSourceControlAuthStore.getState().refreshInstances(sourceControl, { force: true }),
    ]);
    expect(calls).toBe(1);
    fail = true;

    await useSourceControlAuthStore.getState().refreshInstances(sourceControl, { force: true });

    expect(useSourceControlAuthStore.getState().identities).toEqual([identity]);
    expect(useSourceControlAuthStore.getState().identitiesError).toBe('offline');
    fail = false;
    await useSourceControlAuthStore.getState().refreshInstances(sourceControl);
    expect(calls).toBe(3);
    expect(useSourceControlAuthStore.getState().identitiesError).toBeNull();
  });

  test('bound account authority is independent of the active credential but rejects stale inventory', () => {
    const status: SourceControlAuthStatus = {
      ...identity,
      status: 'disconnected',
      connected: false,
      accounts: connectedStatus.accounts,
    };
    const entry = { status, isLoading: false, hasChecked: true };
    expect(getSourceControlReadContextAuthState(entry, readContext).connected).toBe(true);
    expect(getSourceControlReadContextAuthState({ ...entry, status: { ...status, status: 'unreachable' } }, readContext).connected).toBe(false);
    expect(getSourceControlReadContextAuthState({ ...entry, status: { ...status, status: 'temporarily-unavailable' } }, readContext).connected).toBe(false);
  });

  test('deduplicates authoritative loads per provider instance', async () => {
    let calls = 0;
    const authStatus = async () => {
      calls += 1;
      return { ...identity, status: 'disconnected' as const, connected: false as const };
    };
    const api = { authStatus };
    await Promise.all([
      useSourceControlAuthStore.getState().refreshStatus(api, identity, { force: true }),
      useSourceControlAuthStore.getState().refreshStatus(api, identity, { force: true }),
    ]);
    expect(calls).toBe(1);
    expect(useSourceControlAuthStore.getState().entries[getSourceControlAuthKey(identity)]?.status?.status).toBe('disconnected');
  });

  test('keeps multiple accounts isolated by GitLab instance', async () => {
    const gitlabCom = { provider: 'gitlab', instance: 'https://gitlab.com' } satisfies SourceControlIdentity;
    const privateGitLab = { provider: 'gitlab', instance: 'https://gitlab.example.com' } satisfies SourceControlIdentity;
    const sourceControl = {
      authInstances: mock(async () => [gitlabCom, privateGitLab]),
      authStatus: mock(async (target: SourceControlIdentity): Promise<SourceControlAuthStatus> => {
        const isPrivate = target.instance === privateGitLab.instance;
        const firstId = `${target.instance}#${isPrivate ? '3' : '1'}`;
        const secondId = `${target.instance}#${isPrivate ? '4' : '2'}`;
        const firstUsername = isPrivate ? 'private-one' : 'com-one';
        const secondUsername = isPrivate ? 'private-two' : 'com-two';
        return {
          ...target,
          status: 'connected',
          connected: true,
          user: { ...target, id: firstId, username: firstUsername },
          accounts: [
            { id: firstId, credentialId: firstId, credentialRevision: 1, providerUserId: firstId, providerUserStatus: 'available', user: { ...target, id: firstId, username: firstUsername }, current: true, source: 'pat', status: 'valid' },
            { id: secondId, credentialId: secondId, credentialRevision: 1, providerUserId: secondId, providerUserStatus: 'available', user: { ...target, id: secondId, username: secondUsername }, current: false, source: 'oauth', status: 'valid' },
          ],
        };
      }),
    };

    await useSourceControlAuthStore.getState().refreshAll(sourceControl, { force: true });

    const state = useSourceControlAuthStore.getState();
    const gitlabComStatus = state.entries[getSourceControlAuthKey(gitlabCom)]?.status;
    const privateStatus = state.entries[getSourceControlAuthKey(privateGitLab)]?.status;
    expect(gitlabComStatus?.connected && gitlabComStatus.accounts.map((account) => account.user.username)).toEqual(['com-one', 'com-two']);
    expect(privateStatus?.connected && privateStatus.accounts.map((account) => account.user.username)).toEqual(['private-one', 'private-two']);
  });

  test('keeps transport failure distinct from disconnected', async () => {
    const api = { authStatus: mock(async () => { throw new Error('offline'); }) };
    expect(await useSourceControlAuthStore.getState().refreshStatus(api, identity, { force: true })).toBeNull();
    const status = useSourceControlAuthStore.getState().entries[getSourceControlAuthKey(identity)]?.status;
    expect(status?.status).toBe('unreachable');
    expect(status?.connected).toBe(false);
    expect(status && 'message' in status ? status.message : null).toBe('offline');
  });

  test('rejects stale completion after a runtime reset', async () => {
    let resolveStatus!: (value: { provider: string; instance: string; status: 'disconnected'; connected: false }) => void;
    const api = {
      authStatus: mock(() => new Promise<SourceControlAuthStatus>((resolve) => { resolveStatus = resolve; })),
    };
    const pending = useSourceControlAuthStore.getState().refreshStatus(api, identity, { force: true });
    useSourceControlAuthStore.getState().resetForRuntimeSwitch();
    resolveStatus({ ...identity, status: 'disconnected', connected: false });
    await pending;
    expect(useSourceControlAuthStore.getState().entries).toEqual({});
  });

  test('retains inventory after deferred failure without granting bound read authority, then retries', async () => {
    const store = useSourceControlAuthStore.getState();
    store.setStatus(identity, connectedStatus);
    const response = deferred<SourceControlAuthStatus>();
    const failedRead = store.refreshStatus({ authStatus: () => response.promise }, identity, { force: true });
    const key = getSourceControlAuthKey(identity);
    expect(useSourceControlAuthStore.getState().entries[key]?.status).toBe(connectedStatus);

    response.reject(new Error('offline'));
    expect(await failedRead).toBeNull();
    const staleEntry = useSourceControlAuthStore.getState().entries[key];
    expect(staleEntry?.status?.status).toBe('unreachable');
    expect(staleEntry?.status?.connected).toBe(false);
    expect(staleEntry?.status?.accounts).toBe(connectedStatus.accounts);
    expect(staleEntry?.status?.cli).toBe(connectedStatus.cli);
    expect(getSourceControlReadContextAuthState(staleEntry, readContext))
      .toEqual({ authChecked: true, connected: false });

    const retry = deferred<SourceControlAuthStatus>();
    let calls = 0;
    const api = { authStatus: () => { calls += 1; return retry.promise; } };
    const first = store.refreshStatus(api, identity);
    const second = store.refreshStatus(api, identity);
    expect(calls).toBe(1);
    expect(getSourceControlReadContextAuthState(useSourceControlAuthStore.getState().entries[key], readContext).connected).toBe(false);
    retry.resolve(connectedStatus);
    await Promise.all([first, second]);
    expect(getSourceControlReadContextAuthState(useSourceControlAuthStore.getState().entries[key], readContext).connected).toBe(true);
  });

  test('deferred failure retains credentials saved while the refresh was pending', async () => {
    const response = deferred<SourceControlAuthStatus>();
    const store = useSourceControlAuthStore.getState();
    const pending = store.refreshStatus({ authStatus: () => response.promise }, identity);
    store.setStatus(identity, connectedStatus);
    response.reject(new Error('offline'));
    await pending;
    expect(useSourceControlAuthStore.getState().entries[getSourceControlAuthKey(identity)]?.status?.accounts)
      .toBe(connectedStatus.accounts);
  });

  test('a subscriber that refreshes on the loading notification joins the pending read', async () => {
    const response = deferred<SourceControlAuthStatus>();
    let calls = 0;
    const api = { authStatus: () => { calls += 1; return response.promise; } };
    const unsubscribe = useSourceControlAuthStore.subscribe(() => {
      void useSourceControlAuthStore.getState().refreshStatus(api, identity);
    });
    const pending = useSourceControlAuthStore.getState().refreshStatus(api, identity);
    unsubscribe();
    expect(calls).toBe(1);
    response.resolve(connectedStatus);
    await pending;
  });

  test('a read started before an account mutation cannot overwrite the forced refresh after it', async () => {
    const stale = deferred<SourceControlAuthStatus>();
    const fresh = deferred<SourceControlAuthStatus>();
    const store = useSourceControlAuthStore.getState();
    const before = store.refreshStatus({ authStatus: () => stale.promise }, identity);
    let freshCalls = 0;
    const after = store.refreshStatus({ authStatus: () => { freshCalls += 1; return fresh.promise; } }, identity, { force: true });
    expect(freshCalls).toBe(1);
    fresh.resolve(connectedStatus);
    await after;
    stale.resolve({ ...identity, status: 'disconnected', connected: false, accounts: [] });
    await before;
    expect(useSourceControlAuthStore.getState().entries[getSourceControlAuthKey(identity)]?.status).toBe(connectedStatus);
  });

  test('an unchanged inventory keeps the held list, a changed one replaces it', async () => {
    const other = { provider: 'github', instance: 'github.com' } satisfies SourceControlIdentity;
    const store = useSourceControlAuthStore.getState();
    await store.refreshInstances({ authInstances: async () => [{ ...identity }] }, { force: true });
    const held = useSourceControlAuthStore.getState().identities;
    await store.refreshInstances({ authInstances: async () => [{ ...identity }] }, { force: true });
    expect(useSourceControlAuthStore.getState().identities).toBe(held);
    await store.refreshInstances({ authInstances: async () => [{ ...identity }, other] }, { force: true });
    expect(useSourceControlAuthStore.getState().identities).toEqual([identity, other]);
  });

  test('successful empty inventory replaces stale credentials', async () => {
    const store = useSourceControlAuthStore.getState();
    store.setStatus(identity, connectedStatus);
    await store.refreshStatus({ authStatus: async () => ({ ...identity, status: 'disconnected', connected: false, accounts: [] }) }, identity, { force: true });
    expect(useSourceControlAuthStore.getState().entries[getSourceControlAuthKey(identity)]?.status?.accounts).toEqual([]);
  });

  test('late failed refresh cannot overwrite the new runtime inventory', async () => {
    const response = deferred<SourceControlAuthStatus>();
    const store = useSourceControlAuthStore.getState();
    const pending = store.refreshStatus({ authStatus: () => response.promise }, identity);
    store.resetForRuntimeSwitch();
    store.setStatus(identity, connectedStatus);
    response.reject(new Error('old runtime offline'));
    await pending;
    expect(useSourceControlAuthStore.getState().entries[getSourceControlAuthKey(identity)]?.status).toBe(connectedStatus);
  });

  test('reset between cached discovery and status bootstrap cannot start old-runtime work', async () => {
    const store = useSourceControlAuthStore.getState();
    await store.refreshInstances({ authInstances: async () => [identity] });
    let statusCalls = 0;
    const pending = store.refreshAll({
      authInstances: async () => [identity],
      authStatus: async () => { statusCalls += 1; return connectedStatus; },
    });
    store.resetForRuntimeSwitch();
    await pending;
    expect(statusCalls).toBe(0);
    expect(useSourceControlAuthStore.getState().entries).toEqual({});
  });

  test('bootstraps inventory again after reset and isolates one failed instance', async () => {
    const otherIdentity: SourceControlIdentity = { provider: 'gitlab', instance: 'https://gitlab.com' };
    let instanceCalls = 0;
    let statusCalls = 0;
    const api = {
      authInstances: async () => { instanceCalls += 1; return [identity, otherIdentity]; },
      authStatus: async (target: SourceControlIdentity) => {
        statusCalls += 1;
        if (target.instance === otherIdentity.instance) throw new Error('offline');
        return connectedStatus;
      },
    };
    const store = useSourceControlAuthStore.getState();
    await store.refreshAll(api, { force: true });
    store.resetForRuntimeSwitch();
    await store.refreshAll(api, { force: true });
    expect(instanceCalls).toBe(2);
    expect(statusCalls).toBe(4);
    expect(useSourceControlAuthStore.getState().entries[getSourceControlAuthKey(identity)]?.status).toBe(connectedStatus);
    expect(useSourceControlAuthStore.getState().entries[getSourceControlAuthKey(otherIdentity)]?.status?.status).toBe('unreachable');
  });

  test('a forced instance refresh does not join an in-flight non-forced read', async () => {
    const nonForcedResponse = deferred<SourceControlIdentity[]>();
    const forcedResponse = deferred<SourceControlIdentity[]>();
    const firstList = [{ ...identity, instance: 'https://gitlab.example.com/first' }];
    const secondList = [{ ...identity, instance: 'https://gitlab.example.com/second' }];
    let calls = 0;
    const sourceControl = {
      authInstances: mock(() => {
        calls += 1;
        return calls === 1 ? nonForcedResponse.promise : forcedResponse.promise;
      }),
    };
    const store = useSourceControlAuthStore.getState();
    const nonForced = store.refreshInstances(sourceControl);
    const forced = store.refreshInstances(sourceControl, { force: true });
    expect(calls).toBe(2);
    nonForcedResponse.resolve(firstList);
    await nonForced;
    forcedResponse.resolve(secondList);
    expect(await forced).toEqual(secondList);
    expect(useSourceControlAuthStore.getState().identities).toEqual(secondList);
  });

  test('a stale non-forced read cannot overwrite a newer forced list', async () => {
    const staleResponse = deferred<SourceControlIdentity[]>();
    const forcedResponse = deferred<SourceControlIdentity[]>();
    const staleList = [{ ...identity, instance: 'https://gitlab.example.com/stale' }];
    const freshList = [{ ...identity, instance: 'https://gitlab.example.com/fresh' }];
    let calls = 0;
    const sourceControl = {
      authInstances: mock(() => {
        calls += 1;
        return calls === 1 ? staleResponse.promise : forcedResponse.promise;
      }),
    };
    const store = useSourceControlAuthStore.getState();
    const nonForced = store.refreshInstances(sourceControl);
    const forced = store.refreshInstances(sourceControl, { force: true });
    expect(calls).toBe(2);
    // The forced read answers first; the non-forced read that started before it
    // resolves later and must not replace the newer forced result.
    forcedResponse.resolve(freshList);
    staleResponse.resolve(staleList);
    await Promise.all([forced, nonForced]);
    expect(useSourceControlAuthStore.getState().identities).toEqual(freshList);
  });

  test('App refreshes auth on reconnect and endpoint changes without a result feedback loop', async () => {
    const browser = new Window({ url: 'http://localhost/' });
    browser.document.write('<!doctype html><html><body></body></html>');
    // Keep the real App's recovery screen mounted without loading editor workers.
    Object.assign(browser, {
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_DESKTOP_BOOT_OUTCOME__: { target: 'remote', status: 'missing', hostId: 'removed-host' },
    });
    const globals = {
      window: browser, document: browser.document, navigator: browser.navigator,
      HTMLElement: browser.HTMLElement, Element: browser.Element,
      HTMLMetaElement: browser.HTMLMetaElement, HTMLInputElement: browser.HTMLInputElement,
      HTMLTextAreaElement: browser.HTMLTextAreaElement, Node: browser.Node,
      MutationObserver: browser.MutationObserver,
      CustomEvent: browser.CustomEvent, Event: browser.Event,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
      cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
      ResizeObserver: browser.ResizeObserver,
      customElements: browser.customElements,
      localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    };
    const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.assign(globalThis, globals);
    const requests: string[] = [];
    const statuses: ReturnType<typeof deferred<Response>>[] = [];
    const network = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
      if (url.pathname === '/api/source-control/instances') {
        requests.push(url.href);
        return Response.json({ instances: [identity] });
      }
      if (url.pathname === '/api/source-control/gitlab/auth/status') {
        requests.push(url.href);
        const response = deferred<Response>();
        statuses.push(response);
        return response.promise;
      }
      // Leave unrelated bootstrap reads pending, as on a still-starting server.
      return new Promise<Response>(() => {});
    });
    const { default: App } = await import('../App');
    const { I18nProvider } = await import('@/lib/i18n');
    const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
    const { createWebAPIs } = await import('../../../web/src/api');
    const { useConfigStore } = await import('./useConfigStore');
    const { useDirectoryStore } = await import('./useDirectoryStore');
    const { getRuntimeApiBaseUrl, getRuntimeKey, initializeRuntimeEndpoint, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
    const previousEndpoint = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
    initializeRuntimeEndpoint({ apiBaseUrl: 'http://localhost', runtimeKey: 'auth-first' });
    const previousConfig = useConfigStore.getState();
    const previousDirectory = useDirectoryStore.getState();
    useDirectoryStore.setState({ currentDirectory: '/repo', isHomeReady: true });
    useConfigStore.setState({ isConnected: false });
    const apis = createWebAPIs();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    jest.useFakeTimers();
    const render = async (runtimeAPIs = apis) => {
      await act(async () => root.render(React.createElement(I18nProvider, null,
        React.createElement(ThemeSystemProvider, { children: React.createElement(App, { apis: runtimeAPIs }) }))));
    };
    const answerStatus = async (index: number) => {
      await act(async () => { statuses[index].resolve(Response.json({ ...identity, status: 'disconnected', connected: false, accounts: [] })); });
      expect(useSourceControlAuthStore.getState().entries[getSourceControlAuthKey(identity)]?.status?.status).toBe('disconnected');
      expect(statuses).toHaveLength(index + 1);
    };
    try {
      await render();
      expect(requests).toEqual([]);
      await act(async () => { useConfigStore.setState({ isConnected: true }); });
      expect(statuses).toHaveLength(1);
      await answerStatus(0);
      await act(async () => { useSourceControlAuthStore.getState().setStatus(identity, connectedStatus); });
      await render();
      expect(statuses).toHaveLength(1);

      await act(async () => { useConfigStore.setState({ isConnected: false }); });
      expect(statuses).toHaveLength(1);
      await act(async () => { useConfigStore.setState({ isConnected: true }); });
      expect(statuses).toHaveLength(2);
      await answerStatus(1);

      await act(async () => {
        switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:3001', runtimeKey: 'auth-second' });
        useConfigStore.setState({ isConnected: true });
      });
      expect(statuses).toHaveLength(3);
      expect(requests.slice(-2).map((url) => new URL(url).origin)).toEqual(['http://localhost:3001', 'http://localhost:3001']);
      await answerStatus(2);

      await render(createWebAPIs());
      expect(statuses).toHaveLength(4);
      await answerStatus(3);
      expect(requests.filter((url) => new URL(url).pathname === '/api/source-control/instances')).toHaveLength(4);
    } finally {
      await act(async () => root.unmount());
      await act(async () => { switchRuntimeEndpoint(previousEndpoint); });
      jest.useRealTimers();
      useConfigStore.setState(previousConfig);
      useDirectoryStore.setState(previousDirectory);
      await browser.happyDOM.abort();
      network.mockRestore();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }, 20_000);
});
