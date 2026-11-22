import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

const disabledProvidersSchema = z.object({ providers: z.array(z.string()) });
const errorSchema = z.object({ error: z.string().min(1) });

/** Why a provider is effectively off (#218): the toggleable list, or a source Settings cannot change. */
export type ProviderOffReason = 'disabled' | 'policy' | 'allowlist';

/** The effective off state: every provider OpenCode refuses, with its binding reason. */
export interface ProviderOffState {
  offProviders: string[];
  offReasons: Record<string, ProviderOffReason>;
}

const providerOffStateSchema = z.object({
  catalogReady: z.boolean().optional(),
  providers: z.array(z.string()),
  offProviders: z.array(z.string()).optional(),
  offReasons: z.record(z.string(), z.enum(['disabled', 'policy', 'allowlist'])).optional(),
});

/**
 * Derives the effective off state from a read payload. Older servers answer
 * only `{ providers }`: then the toggleable list is the whole off set.
 */
const offStateFromPayload = (payload: z.infer<typeof providerOffStateSchema>): ProviderOffState => {
  if (!payload.offProviders || !payload.offReasons) {
    return {
      offProviders: [...payload.providers],
      offReasons: Object.fromEntries(payload.providers.map((id) => [id, 'disabled' as const])),
    };
  }
  return { offProviders: [...payload.offProviders], offReasons: { ...payload.offReasons } };
};

/**
 * Recomputes the off state after a toggle write, which answers only the new
 * toggleable list. A provider the toggle cannot affect keeps its previous
 * binding reason; a provider newly on the list reports 'disabled' unless a
 * policy already bound it (server precedence: policy over disabled).
 */
const offStateAfterToggle = (providers: string[], previous: ProviderOffState | null): ProviderOffState => {
  const offReasons: Record<string, ProviderOffReason> = {};
  for (const [id, reason] of Object.entries(previous?.offReasons ?? {})) {
    if (reason !== 'disabled') offReasons[id] = reason;
  }
  for (const id of providers) {
    if (offReasons[id] !== 'policy') offReasons[id] = 'disabled';
  }
  return { offProviders: Object.keys(offReasons), offReasons };
};

/**
 * Providers turned off in the user's OpenCode config (`disabled_providers`).
 * OpenCode leaves them out of its provider list entirely, so this is the only
 * way Settings can show them again. Null where the runtime has no OpenChamber
 * server to ask (VS Code): the feature is not offered there.
 */
const fetchDisabledProviders = async (): Promise<{ providers: string[]; offState: ProviderOffState; catalogReady: boolean } | null> => {
  const response = await runtimeFetch('/api/provider/disabled');
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read disabled providers (${response.status})`);
  const payload = providerOffStateSchema.parse(await response.json());
  // Older servers answer without the flag and awaited the catalog inline,
  // so their reads are never catalog-incomplete.
  return { providers: payload.providers, offState: offStateFromPayload(payload), catalogReady: payload.catalogReady ?? true };
};

// The last list read from the current runtime, kept so every part of the app
// filters from the same read. A location OpenCode has not reloaded since a
// provider was turned off still lists that provider; this list is what keeps
// it out of that location's picker. The snapshot belongs to the runtime it
// was read from; after a runtime switch it is ignored until a read from the
// new runtime lands. A `null` list is a read answer too: the runtime has no
// OpenChamber server, so there is nothing to filter with.
let snapshot: { runtimeKey: string; providers: string[] | null; offState: ProviderOffState | null } | null = null;
let inFlight: { runtimeKey: string; promise: Promise<string[] | null> } | null = null;
let latestRead = 0;

// A read taken while the server's models.dev catalog is still cold carries
// a config-only off state: allowlist omissions and wildcard policy denies
// for providers absent from config are missing until the catalog lands
// (#218). Such a read schedules one re-read past the catalog fetch's
// timeout, bounded so a permanently unreachable catalog does not poll
// forever; subscribers hear about the refreshed read when it lands.
const CATALOG_REFRESH_DELAY_MS = 10_000;
const CATALOG_REFRESH_MAX_ATTEMPTS = 3;
let catalogRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let catalogRefreshAttempts = 0;
const offStateListeners = new Set<() => void>();

/** Subscribes to refreshed off-state reads landing; returns the unsubscribe. */
export const subscribeProviderOffState = (listener: () => void): (() => void) => {
  offStateListeners.add(listener);
  return () => { offStateListeners.delete(listener); };
};

const notifyOffStateListeners = (): void => {
  for (const listener of [...offStateListeners]) listener();
};

const scheduleCatalogRefresh = (): void => {
  if (catalogRefreshTimer) return;
  if (catalogRefreshAttempts >= CATALOG_REFRESH_MAX_ATTEMPTS) return;
  catalogRefreshAttempts += 1;
  catalogRefreshTimer = setTimeout(() => {
    catalogRefreshTimer = null;
    void loadDisabledProviders().catch(() => {});
  }, CATALOG_REFRESH_DELAY_MS);
  catalogRefreshTimer.unref?.();
};

const settleCatalogRefresh = (catalogReady: boolean): void => {
  if (catalogReady) {
    catalogRefreshAttempts = 0;
    if (catalogRefreshTimer) {
      clearTimeout(catalogRefreshTimer);
      catalogRefreshTimer = null;
    }
    return;
  }
  scheduleCatalogRefresh();
};

/** The last list read from the current runtime, or `null` when there is none. */
export const peekDisabledProviders = (): string[] | null =>
  snapshot?.runtimeKey === getRuntimeKey() ? snapshot.providers : null;

/** The last effective off state read from the current runtime, or `null` when there is none. */
export const peekProviderOffState = (): ProviderOffState | null =>
  snapshot?.runtimeKey === getRuntimeKey() ? snapshot.offState : null;

/** Keeps a list the caller just read or wrote, so later reads reuse it. */
export const rememberDisabledProviders = (providers: string[] | null): void => {
  // A write is newer than every read already in flight: advancing the read
  // generation is what stops such a read from writing its pre-write list
  // back over this one when it lands.
  latestRead += 1;
  const previous = snapshot?.runtimeKey === getRuntimeKey() ? snapshot.offState : null;
  snapshot = {
    runtimeKey: getRuntimeKey(),
    providers,
    offState: providers === null ? null : offStateAfterToggle(providers, previous),
  };
};

/**
 * Reads the list again and keeps it. A read started earlier never replaces
 * one started later, and a Settings write (rememberDisabledProviders)
 * advances the same generation, so a slow first read cannot bring back the
 * state from before a Settings change either. Throws when the list cannot
 * be read; a failed read is never an empty list.
 */
export const loadDisabledProviders = async (): Promise<string[] | null> => {
  const runtimeKey = getRuntimeKey();
  const read = ++latestRead;
  const fetched = await fetchDisabledProviders();
  const providers = fetched?.providers ?? null;
  if (read === latestRead && runtimeKey === getRuntimeKey()) {
    snapshot = { runtimeKey, providers, offState: fetched?.offState ?? null };
    if (fetched) settleCatalogRefresh(fetched.catalogReady);
    notifyOffStateListeners();
    return providers;
  }
  // Superseded while in flight - by a newer read, a provider toggle, or a
  // runtime switch. The fetched list is stale: answer with the latest
  // snapshot for the current runtime instead, so no caller filters a
  // catalog with the pre-toggle list.
  return peekDisabledProviders();
};

/**
 * Reads the effective off state again (through the same generation guard as
 * the list read) and keeps it. Answers `null` where the runtime has no
 * OpenChamber server to ask.
 */
export const loadProviderOffState = async (): Promise<ProviderOffState | null> => {
  await loadDisabledProviders();
  return peekProviderOffState();
};

/**
 * The current runtime's list, reading it once when no read has landed yet.
 * Callers that arrive while that read runs share it. A failure answers
 * `null`, the caller keeps the providers it has, and the failure is not
 * kept: the next caller reads again.
 */
export const ensureDisabledProviders = (): Promise<string[] | null> => {
  const runtimeKey = getRuntimeKey();
  if (snapshot?.runtimeKey === runtimeKey) return Promise.resolve(snapshot.providers);
  if (inFlight?.runtimeKey === runtimeKey) return inFlight.promise;
  const promise = loadDisabledProviders()
    .catch((error) => {
      console.warn('[providers] could not read disabled providers:', error instanceof Error ? error.message : String(error));
      return null;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { runtimeKey, promise };
  return promise;
};

/**
 * Reads the list once the app has started, so the first catalog a picker
 * shows is already filtered. A failure is left for the next catalog load
 * or Settings visit to retry.
 */
export const prefetchDisabledProviders = (): void => {
  void ensureDisabledProviders();
};

/** Turns a provider off or back on; answers with the new list. */
export const setProviderDisabled = async (providerId: string, disabled: boolean): Promise<string[]> => {
  const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/disabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Could not update the provider (${response.status})`);
  }
  const providers = disabledProvidersSchema.parse(payload).providers;
  rememberDisabledProviders(providers);
  return providers;
};
