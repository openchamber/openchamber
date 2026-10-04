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
const inFlightForced = new Set<string>();
// Bumped by every write that is newer than any read already on the wire: a
// forced refresh (it follows an account mutation) or a direct status write.
// A response whose read started under an older version describes the
// instance before that write and is discarded.
const versions = new Map<string, number>();
const bumpVersion = (key: string): number => {
  const next = (versions.get(key) ?? 0) + 1;
  versions.set(key, next);
  return next;
};
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
    bumpVersion(key);
    inFlight.delete(key);
    inFlightTokens.delete(key);
    inFlightForced.delete(key);
    set((state) => ({
      entries: {
        ...state.entries,
        [key]: { ...(state.entries[key] ?? createEntry()), status, isLoading: false, hasChecked: true },
      },
    }));
  },
  refreshStatus: async (sourceControl, identity, options) => {
    const key = getSourceControlAuthKey(identity);
    const current = get().entries[key];
    const pending = inFlight.get(key);
    // A forced refresh follows a mutation, so an ordinary read that started
    // before it cannot answer for it; forced reads issued together share one.
    if (pending && (!options?.force || inFlightForced.has(key))) return pending;
    if (!pending && current?.hasChecked && current.status?.status !== 'unreachable' && !options?.force) return current.status;

    const requestGeneration = generation;
    const requestVersion = bumpVersion(key);
    const requestToken = Symbol(key);
    const isCurrent = () => requestGeneration === generation
      && versions.get(key) === requestVersion
      && key === getSourceControlAuthKey(identity);
    // A superseded read hands its caller whatever replaced it.
    const superseded = () => inFlight.get(key) ?? (requestGeneration === generation ? get().entries[key]?.status ?? null : null);
    const request = (async () => {
      try {
        const status = await sourceControl.authStatus(identity);
        if (!isCurrent()) return superseded();
        set((state) => ({
          entries: {
            ...state.entries,
            [key]: { status, isLoading: false, hasChecked: true },
          },
        }));
        return status;
      } catch (error) {
        if (!isCurrent()) return superseded();
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
          inFlightForced.delete(key);
        }
      }
    })();
    // Registered before subscribers hear about the load: one that asks for
    // this instance again from inside the notification joins this read
    // instead of starting another.
    inFlightTokens.set(key, requestToken);
    inFlight.set(key, request);
    if (options?.force) inFlightForced.add(key);
    else inFlightForced.delete(key);
    set((state) => ({
      entries: {
        ...state.entries,
        [key]: { ...(state.entries[key] ?? createEntry()), isLoading: true },
      },
    }));
    return request;
  },
  resetForRuntimeSwitch: () => {
    generation += 1;
    inFlight.clear();
    inFlightTokens.clear();
    versions.clear();
    inFlightForced.clear();
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
