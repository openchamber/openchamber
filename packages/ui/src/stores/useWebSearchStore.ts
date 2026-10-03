/**
 * Settings → Web search state: the providers OpenCode offers, the `websearch`
 * config choice, and how each provider's optional key is supplied.
 *
 * OpenCode owns all three. The store reads them on demand (the page asks, and
 * `catalogRefresh` re-reads after `websearch.updated`, `config.updated` or a
 * credential change once the page has asked at least once). A failed read
 * never replaces a good snapshot of the same scope with an empty one.
 */

import { create } from 'zustand';
import { z } from 'zod';
import { opencodeClient } from '@/lib/opencode/client';
import {
  listWebSearchProviders,
  readWebSearchAccess,
  readWebSearchSelection,
  removeWebSearchKey,
  saveWebSearchKey,
  webSearchSelectionToConfig,
  type WebSearchProvider,
  type WebSearchProviderAccess,
  type WebSearchSelection,
} from '@/lib/opencode/websearch';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

export type WebSearchSnapshot = {
  scope: string;
  providers: WebSearchProvider[];
  selection: WebSearchSelection;
  /** `null` when the integration list could not be read: key status unknown, not "no key". */
  access: Record<string, WebSearchProviderAccess> | null;
  /**
   * The project config whose `websearch` overrides what Settings writes, so a
   * choice here would snap back. `null` when none, or when the check failed
   * (unknown is treated as "not overridden" so the page stays usable).
   */
  projectOverride: string | null;
};

type WebSearchState =
  | { kind: 'idle' }
  | { kind: 'loading'; scope: string }
  | { kind: 'ready'; snapshot: WebSearchSnapshot }
  | { kind: 'failed'; scope: string };

type WebSearchStore = {
  state: WebSearchState;
  load: () => Promise<void>;
  /** Resolves `false` when the write failed; the previous choice is restored. */
  setSelection: (selection: WebSearchSelection) => Promise<boolean>;
  saveKey: (providerId: string, key: string) => Promise<boolean>;
  removeKey: (providerId: string) => Promise<boolean>;
};

const currentDirectory = (): string | null => opencodeClient.getDirectory()?.trim() || null;

export const getWebSearchScopeKey = (): string => JSON.stringify([getRuntimeKey(), currentDirectory()]);

// Only the newest read may commit, and a choice written while a read was in
// flight wins over the config that read saw.
let readGeneration = 0;
let selectionRevision = 0;
let selectionWritesInFlight = 0;

const errorBodySchema = z.object({ error: z.string() });
const sourceBodySchema = z.object({ projectPath: z.string().min(1).nullable() });

const readProjectOverride = async (directory: string | null): Promise<string | null> => {
  try {
    const response = await runtimeFetch('/api/config/websearch', {
      headers: { Accept: 'application/json' },
      query: directory ? { directory } : undefined,
    });
    if (!response.ok) return null;
    return sourceBodySchema.safeParse(await response.json()).data?.projectPath ?? null;
  } catch (error) {
    console.warn('[web-search] failed to read where the choice is set', error);
    return null;
  }
};

const readSelectionError = async (response: Response): Promise<string> => {
  const body = errorBodySchema.safeParse(await response.json().catch(() => null));
  return body.data?.error ?? `HTTP ${response.status}`;
};

export const useWebSearchStore = create<WebSearchStore>()((set, get) => ({
  state: { kind: 'idle' },

  load: async () => {
    const scope = getWebSearchScopeKey();
    const directory = currentDirectory();
    const generation = ++readGeneration;
    const revisionAtStart = selectionRevision;
    const previous = get().state;
    const hasSnapshot = previous.kind === 'ready' && previous.snapshot.scope === scope;
    if (!hasSnapshot) set({ state: { kind: 'loading', scope } });

    try {
      const overridePromise = readProjectOverride(directory);
      const [providers, config] = await Promise.all([
        listWebSearchProviders(directory),
        opencodeClient.getConfig(directory),
      ]);
      const projectOverride = await overridePromise;
      const access = await readWebSearchAccess(directory, providers.map((provider) => provider.id)).catch(() => null);
      if (generation !== readGeneration || getWebSearchScopeKey() !== scope) return;
      const current = get().state;
      const localChoiceIsNewer = selectionRevision !== revisionAtStart || selectionWritesInFlight > 0;
      const selection = localChoiceIsNewer && current.kind === 'ready' && current.snapshot.scope === scope
        ? current.snapshot.selection
        : readWebSearchSelection(config);
      set({ state: { kind: 'ready', snapshot: { scope, providers, selection, access, projectOverride } } });
    } catch (error) {
      if (generation !== readGeneration || getWebSearchScopeKey() !== scope) return;
      console.warn('[web-search] failed to read providers', error);
      const current = get().state;
      if (current.kind === 'ready' && current.snapshot.scope === scope) return;
      set({ state: { kind: 'failed', scope } });
    }
  },

  setSelection: async (selection) => {
    const current = get().state;
    if (current.kind !== 'ready' || current.snapshot.projectOverride) return false;
    const previous = current.snapshot.selection;
    selectionRevision += 1;
    const revision = selectionRevision;
    set({ state: { kind: 'ready', snapshot: { ...current.snapshot, selection } } });
    reportSettingsSaveState('saving');

    let failed = false;
    selectionWritesInFlight += 1;
    try {
      const response = await runtimeFetch('/api/config/websearch', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ selection: webSearchSelectionToConfig(selection) }),
      });
      if (!response.ok) {
        console.warn('[web-search] failed to save the choice', await readSelectionError(response));
        failed = true;
      }
    } catch (error) {
      console.warn('[web-search] failed to save the choice', error);
      failed = true;
    } finally {
      selectionWritesInFlight -= 1;
    }

    if (!failed) {
      reportSettingsSaveState('saved');
      // OpenCode reads its config fresh on the next request; drop the copy
      // cached for the page's read.
      opencodeClient.clearConfigCache();
      return true;
    }
    reportSettingsSaveState('error');
    // Roll back only if no newer choice was made meanwhile.
    const latest = get().state;
    if (revision === selectionRevision && latest.kind === 'ready' && latest.snapshot.scope === current.snapshot.scope) {
      set({ state: { kind: 'ready', snapshot: { ...latest.snapshot, selection: previous } } });
    }
    return false;
  },

  saveKey: async (providerId, key) => {
    try {
      await saveWebSearchKey(providerId, key);
    } catch (error) {
      console.warn('[web-search] failed to save the key', error);
      return false;
    }
    // OpenCode announces the credential change; reading now shows it without
    // waiting for the event's debounce.
    void get().load();
    return true;
  },

  removeKey: async (providerId) => {
    const current = get().state;
    if (current.kind !== 'ready') return false;
    const status = current.snapshot.access?.[providerId]?.key;
    if (status?.kind !== 'stored') return false;
    try {
      await removeWebSearchKey(status.ids);
    } catch (error) {
      console.warn('[web-search] failed to remove the key', error);
      void get().load();
      return false;
    }
    void get().load();
    return true;
  },
}));

/** Re-read after a catalog event, but only once something asked for the data. */
export const refreshWebSearchIfLoaded = async (): Promise<void> => {
  if (useWebSearchStore.getState().state.kind === 'idle') return;
  await useWebSearchStore.getState().load();
};
