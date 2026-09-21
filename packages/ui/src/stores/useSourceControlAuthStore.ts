import React from 'react';
import { create } from 'zustand';
import type { SourceControlAPI, SourceControlAuthStatus, SourceControlIdentity, SourceControlReadContext } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';

export const getSourceControlAuthKey = (identity: SourceControlIdentity): string =>
  JSON.stringify([getRuntimeKey(), identity.provider, identity.instance]);

type SourceControlAuthEntry = {
  status: SourceControlAuthStatus | null;
  isLoading: boolean;
  hasChecked: boolean;
};

type SourceControlReadContextAuthState = {
  authChecked: boolean;
  connected: boolean;
};

export const getSourceControlReadContextAuthState = (
  entry: SourceControlAuthEntry | undefined,
  context: SourceControlReadContext,
): SourceControlReadContextAuthState => ({
  authChecked: entry?.hasChecked ?? false,
  connected: entry?.hasChecked === true
    && entry.status?.status !== 'unreachable'
    && entry.status?.status !== 'temporarily-unavailable'
    && entry.status?.accounts?.some((account) => account.id === context.accountId && account.status === 'valid') === true,
});

type SourceControlAuthStore = {
  identities: SourceControlIdentity[];
  identitiesLoaded: boolean;
  identitiesError: string | null;
  entries: Record<string, SourceControlAuthEntry>;
  refreshInstances: (sourceControl: Pick<SourceControlAPI, 'authInstances'>, options?: { force?: boolean }) => Promise<SourceControlIdentity[]>;
  refreshAll: (sourceControl: Pick<SourceControlAPI, 'authInstances' | 'authStatus'>, options?: { force?: boolean }) => Promise<void>;
  /**
   * Reads the accounts of the instances these identities name. An instance
   * whose last account was removed disappears from the configured list, so
   * `refreshAll` would never look at it again and an identity pointing into it
   * would look connected forever.
   */
  refreshIdentityAccounts: (
    sourceControl: Pick<SourceControlAPI, 'authStatus'>,
    identities: Array<SourceControlIdentity | null | undefined>,
  ) => Promise<void>;
  setStatus: (identity: SourceControlIdentity, status: SourceControlAuthStatus | null) => void;
  refreshStatus: (
    sourceControl: Pick<SourceControlAPI, 'authStatus'>,
    identity: SourceControlIdentity,
    options?: { force?: boolean },
  ) => Promise<SourceControlAuthStatus | null>;
  resetForRuntimeSwitch: () => void;
};

const inFlight = new Map<string, Promise<SourceControlAuthStatus | null>>();
const inFlightTokens = new Map<string, symbol>();
let instancesInFlight: Promise<SourceControlIdentity[]> | null = null;
let generation = 0;

const createEntry = (): SourceControlAuthEntry => ({ status: null, isLoading: false, hasChecked: false });

export const useSourceControlAuthStore = create<SourceControlAuthStore>((set, get) => ({
  identities: [],
  identitiesLoaded: false,
  identitiesError: null,
  entries: {},
  refreshInstances: async (sourceControl, options) => {
    const current = get();
    if (instancesInFlight) return instancesInFlight;
    if (current.identitiesLoaded && !current.identitiesError && !options?.force) return current.identities;
    const requestGeneration = generation;
    set({ identitiesError: null });
    const request = (async () => {
      try {
        const identities = await sourceControl.authInstances();
        if (requestGeneration !== generation) return [];
        set({ identities, identitiesLoaded: true, identitiesError: null });
        return identities;
      } catch (error) {
        if (requestGeneration !== generation) return [];
        const message = error instanceof Error ? error.message : String(error);
        set({ identitiesError: message });
        return get().identities;
      } finally {
        if (requestGeneration === generation) instancesInFlight = null;
      }
    })();
    instancesInFlight = request;
    return request;
  },
  refreshAll: async (sourceControl, options) => {
    const requestGeneration = generation;
    const runtimeKey = getRuntimeKey();
    const identities = await get().refreshInstances(sourceControl, options);
    if (requestGeneration !== generation || runtimeKey !== getRuntimeKey()) return;
    await Promise.all(identities.map((identity) => get().refreshStatus(sourceControl, identity, options)));
  },
  refreshIdentityAccounts: async (sourceControl, identities) => {
    const seen = new Set<string>();
    const targets: SourceControlIdentity[] = [];
    for (const entry of identities) {
      if (!entry) continue;
      const identity = { provider: entry.provider, instance: entry.instance };
      const key = getSourceControlAuthKey(identity);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(identity);
    }
    await Promise.all(targets.map((identity) => get().refreshStatus(sourceControl, identity, { force: true })));
  },
  setStatus: (identity, status) => {
    const key = getSourceControlAuthKey(identity);
    set((state) => ({
      entries: {
        ...state.entries,
        [key]: { ...(state.entries[key] ?? createEntry()), status, hasChecked: true },
      },
    }));
  },
  refreshStatus: async (sourceControl, identity, options) => {
    const key = getSourceControlAuthKey(identity);
    const current = get().entries[key];
    const pending = inFlight.get(key);
    if (pending) return pending;
    if (current?.hasChecked && current.status?.status !== 'unreachable' && !options?.force) return current.status;

    const requestGeneration = generation;
    const requestToken = Symbol(key);
    set((state) => ({
      entries: {
        ...state.entries,
        [key]: { ...(state.entries[key] ?? createEntry()), isLoading: true },
      },
    }));
    const request = (async () => {
      try {
        const status = await sourceControl.authStatus(identity);
        if (requestGeneration !== generation || key !== getSourceControlAuthKey(identity)) return null;
        set((state) => ({
          entries: {
            ...state.entries,
            [key]: { status, isLoading: false, hasChecked: true },
          },
        }));
        return status;
      } catch (error) {
        if (requestGeneration !== generation || key !== getSourceControlAuthKey(identity)) return null;
        const message = error instanceof Error ? error.message : String(error);
        const status: SourceControlAuthStatus = {
          ...identity,
          status: 'unreachable',
          connected: false,
          // Retain credential metadata for account management, not read authority.
          accounts: get().entries[key]?.status?.accounts,
          cli: get().entries[key]?.status?.cli,
          message,
        };
        set((state) => ({
          entries: {
            ...state.entries,
            [key]: { status, isLoading: false, hasChecked: true },
          },
        }));
        return null;
      } finally {
        if (inFlightTokens.get(key) === requestToken) {
          inFlightTokens.delete(key);
          inFlight.delete(key);
        }
      }
    })();
    inFlightTokens.set(key, requestToken);
    inFlight.set(key, request);
    return request;
  },
  resetForRuntimeSwitch: () => {
    generation += 1;
    inFlight.clear();
    inFlightTokens.clear();
    instancesInFlight = null;
    set({ identities: [], identitiesLoaded: false, identitiesError: null, entries: {} });
  },
}));

export const useSourceControlAuthEntry = (identity: SourceControlIdentity): SourceControlAuthEntry | undefined => {
  const key = getSourceControlAuthKey(identity);
  return useSourceControlAuthStore((state) => state.entries[key]);
};

/**
 * The credential IDs connected for a provider instance, or null when that
 * instance has not been read yet. Callers use it to tell an identity whose
 * account was disconnected from one whose accounts are simply not loaded.
 */
export const useConnectedAccountIds = (): ((identity: SourceControlIdentity) => string[] | null) => {
  const entries = useSourceControlAuthStore((state) => state.entries);
  return React.useCallback((identity: SourceControlIdentity) => {
    const accounts = entries[getSourceControlAuthKey(identity)]?.status?.accounts;
    return accounts ? accounts.map((account) => account.id) : null;
  }, [entries]);
};
