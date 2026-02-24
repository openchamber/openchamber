import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import type {
  SkillsCatalogResponse,
  SkillsCatalogSource,
  SkillsCatalogItem,
  SkillsRepoScanRequest,
  SkillsRepoScanResponse,
  SkillsInstallRequest,
  SkillsInstallResponse,
  SkillsInstallError,
  SkillsCatalogSourceResponse,
} from '@/lib/api/types';

import { refreshSkillsAfterOpenCodeRestart, useSkillsStore } from '@/stores/useSkillsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { startConfigUpdate, finishConfigUpdate, updateConfigUpdateMessage } from '@/lib/configUpdate';

const FALLBACK_SOURCES: SkillsCatalogSource[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: "Anthropic's public skills repository",
    source: 'anthropics/skills',
    defaultSubpath: 'skills',
    sourceType: 'github',
  },
  {
    id: 'clawdhub',
    label: 'ClawdHub',
    description: 'Community skill registry with vector search',
    source: 'clawdhub:registry',
    sourceType: 'clawdhub',
  },
];

const getCurrentDirectory = (): string | null => {
  const opencodeDirectory = opencodeClient.getDirectory();
  if (typeof opencodeDirectory === 'string' && opencodeDirectory.trim().length > 0) {
    return opencodeDirectory;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__zustand_directory_store__;
    if (store) {
      return store.getState().currentDirectory;
    }
  } catch {
    // ignore
  }

  return null;
};

export interface SkillsCatalogState {
  sources: SkillsCatalogSource[];
  itemsBySource: Record<string, SkillsCatalogItem[]>;
  selectedSourceId: string | null;
  pageInfoBySource: Record<string, { nextCursor?: string | null }>;
  loadedSourceIds: Record<string, boolean>;
  clawdhubHasMoreBySource: Record<string, boolean>;

  isLoadingCatalog: boolean;
  isLoadingSource: boolean;
  isLoadingMore: boolean;
  isScanning: boolean;
  isInstalling: boolean;

  lastCatalogError: SkillsCatalogResponse['error'] | null;
  lastScanError: SkillsRepoScanResponse['error'] | null;
  lastInstallError: SkillsInstallError | null;

  scanResults: SkillsCatalogItem[] | null;

  setSelectedSource: (id: string | null) => void;

  loadCatalog: (options?: { refresh?: boolean }) => Promise<boolean>;
  loadSource: (sourceId: string, options?: { refresh?: boolean }) => Promise<boolean>;
  loadMoreClawdHub: () => Promise<boolean>;
  scanRepo: (request: SkillsRepoScanRequest) => Promise<SkillsRepoScanResponse>;
  installSkills: (request: SkillsInstallRequest, options?: { directory?: string | null }) => Promise<SkillsInstallResponse>;
}

export const useSkillsCatalogStore = create<SkillsCatalogState>()(
  devtools(
    (set, get) => ({
      sources: FALLBACK_SOURCES,
      itemsBySource: {},
      selectedSourceId: FALLBACK_SOURCES[0]?.id ?? null,
      pageInfoBySource: {},
      loadedSourceIds: {},
      clawdhubHasMoreBySource: {},

      isLoadingCatalog: false,
      isLoadingSource: false,
      isLoadingMore: false,
      isScanning: false,
      isInstalling: false,

      lastCatalogError: null,
      lastScanError: null,
      lastInstallError: null,

      scanResults: null,

      setSelectedSource: (id) => set({ selectedSourceId: id }),

      loadCatalog: async (options) => {
        set({ isLoadingCatalog: true, lastCatalogError: null });

        const previous = {
          sources: get().sources,
          itemsBySource: get().itemsBySource,
          pageInfoBySource: get().pageInfoBySource,
          loadedSourceIds: get().loadedSourceIds,
          clawdhubHasMoreBySource: get().clawdhubHasMoreBySource,
        };

        let lastError: SkillsCatalogResponse['error'] | null = null;

        try {
          const refresh = options?.refresh ? '?refresh=true' : '';
          const controller = new AbortController();
          const timeoutId = window.setTimeout(() => controller.abort(), 3000);

          try {
            const response = await fetch(`/api/config/skills/catalog${refresh}`, {
              method: 'GET',
              headers: { Accept: 'application/json' },
              signal: controller.signal,
            });

            const payload = (await response.json().catch(() => null)) as SkillsCatalogResponse | null;
            if (!response.ok || !payload?.ok) {
              lastError = payload?.error || { kind: 'unknown', message: `Failed to load catalog (${response.status})` };
              throw new Error(lastError.message);
            }

            const sources = (payload.sources && payload.sources.length > 0) ? payload.sources : previous.sources;
            const itemsBySource = options?.refresh ? {} : (get().itemsBySource || {});
            const pageInfoBySource = options?.refresh ? {} : (get().pageInfoBySource || {});
            const loadedSourceIds = options?.refresh ? {} : (get().loadedSourceIds || {});
            const clawdhubHasMoreBySource = options?.refresh ? {} : (get().clawdhubHasMoreBySource || {});
            const currentSelected = get().selectedSourceId;
            const selectedSourceId =
              (currentSelected && sources.some((s) => s.id === currentSelected))
                ? currentSelected
                : (sources[0]?.id ?? null);

            set({
              sources,
              itemsBySource,
              pageInfoBySource,
              loadedSourceIds,
              clawdhubHasMoreBySource,
              selectedSourceId,
            });

            return true;
          } finally {
            window.clearTimeout(timeoutId);
          }
        } catch (error) {
          lastError = lastError || { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
        
          set({
            sources: previous.sources,
            itemsBySource: previous.itemsBySource,
            pageInfoBySource: previous.pageInfoBySource,
            loadedSourceIds: previous.loadedSourceIds,
            clawdhubHasMoreBySource: previous.clawdhubHasMoreBySource,
            lastCatalogError: lastError || { kind: 'unknown', message: 'Failed to load catalog' },
          });

          return false;
        } finally {
          set({ isLoadingCatalog: false });
        }
      },

      loadSource: async (sourceId, options) => {
        if (!sourceId) {
          return false;
        }

        set({ isLoadingSource: true, lastCatalogError: null });

        try {
          const currentDirectory = getCurrentDirectory();
          const refresh = options?.refresh ? '&refresh=true' : '';
          const queryParams = currentDirectory
            ? `?directory=${encodeURIComponent(currentDirectory)}&sourceId=${encodeURIComponent(sourceId)}${refresh}`
            : `?sourceId=${encodeURIComponent(sourceId)}${refresh}`;

          const response = await fetch(`/api/config/skills/catalog/source${queryParams}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });

          const payload = (await response.json().catch(() => null)) as SkillsCatalogSourceResponse | null;
          const hasItems = Array.isArray((payload as SkillsCatalogSourceResponse | null)?.items);
          if (!response.ok || (!payload?.ok && !hasItems)) {
            const fallback = await fetch(`/api/config/skills/catalog${queryParams}`, {
              method: 'GET',
              headers: { Accept: 'application/json' },
            });
            const fallbackPayload = (await fallback.json().catch(() => null)) as SkillsCatalogResponse | null;
            const fallbackItems = fallbackPayload?.itemsBySource?.[sourceId];
            if (fallback.ok && fallbackPayload?.ok && Array.isArray(fallbackItems)) {
              set((state) => ({
                itemsBySource: { ...state.itemsBySource, [sourceId]: fallbackItems },
                pageInfoBySource: { ...state.pageInfoBySource, [sourceId]: { nextCursor: null } },
                loadedSourceIds: { ...state.loadedSourceIds, [sourceId]: true },
                clawdhubHasMoreBySource: { ...state.clawdhubHasMoreBySource, [sourceId]: false },
              }));
              return true;
            }

            set({
              lastCatalogError: payload?.error || { kind: 'unknown', message: `Failed to load source (${response.status})` },
            });
            return false;
          }

          const items = payload?.items || [];
          const nextCursor = payload?.nextCursor ?? null;

          set((state) => ({
            itemsBySource: { ...state.itemsBySource, [sourceId]: items },
            pageInfoBySource: { ...state.pageInfoBySource, [sourceId]: { nextCursor } },
            loadedSourceIds: { ...state.loadedSourceIds, [sourceId]: true },
            clawdhubHasMoreBySource: {
              ...state.clawdhubHasMoreBySource,
              [sourceId]: items.length > 0,
            },
          }));

          return true;
        } catch (error) {
          set({
            lastCatalogError: { kind: 'unknown', message: error instanceof Error ? error.message : String(error) },
          });
          return false;
        } finally {
          set({ isLoadingSource: false });
        }
      },

      loadMoreClawdHub: async () => {
        const selectedSourceId = get().selectedSourceId;
        if (!selectedSourceId) {
          return false;
        }

        const pageInfo = get().pageInfoBySource[selectedSourceId];
        const cursor = pageInfo?.nextCursor || null;

        set({ isLoadingMore: true });
        try {
          const currentDirectory = getCurrentDirectory();
          const parts = [`sourceId=${encodeURIComponent(selectedSourceId)}`];
          if (currentDirectory) {
            parts.push(`directory=${encodeURIComponent(currentDirectory)}`);
          }
          if (cursor) {
            parts.push(`cursor=${encodeURIComponent(cursor)}`);
          }
          const queryParams = `?${parts.join('&')}`;

          const response = await fetch(`/api/config/skills/catalog/source${queryParams}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });

          const payload = (await response.json().catch(() => null)) as SkillsCatalogSourceResponse | null;
          if (!response.ok || !payload?.ok) {
            return false;
          }

          const nextCursor = payload.nextCursor ?? null;
          const currentItems = get().itemsBySource[selectedSourceId] || [];
          const items = payload.items || [];
          const merged = new Map(currentItems.map((item) => [`${item.sourceId}:${item.skillDir}`, item]));
          let newCount = 0;

          for (const item of items) {
            const key = `${item.sourceId}:${item.skillDir}`;
            if (!merged.has(key)) {
              newCount += 1;
            }
            merged.set(key, item);
          }

          const noMore = items.length === 0 || newCount === 0;

          set((state) => ({
            itemsBySource: {
              ...state.itemsBySource,
              [selectedSourceId]: Array.from(merged.values()),
            },
            pageInfoBySource: {
              ...state.pageInfoBySource,
              [selectedSourceId]: { nextCursor },
            },
            clawdhubHasMoreBySource: {
              ...state.clawdhubHasMoreBySource,
              [selectedSourceId]: !noMore,
            },
          }));

          return true;
        } catch {
          return false;
        } finally {
          set({ isLoadingMore: false });
        }
      },

      scanRepo: async (request) => {
        set({ isScanning: true, lastScanError: null, scanResults: null });
        try {
          const currentDirectory = getCurrentDirectory();
          const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';

          const response = await fetch(`/api/config/skills/scan${queryParams}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(request),
          });

          const payload = (await response.json().catch(() => null)) as SkillsRepoScanResponse | null;
          if (!response.ok || !payload) {
            const error = payload?.error || { kind: 'unknown', message: 'Failed to scan repository' };
            set({ lastScanError: error });
            return { ok: false, error };
          }

          if (!payload.ok) {
            set({ lastScanError: payload.error || { kind: 'unknown', message: 'Failed to scan repository' } });
            return payload;
          }

          set({ scanResults: payload.items || [] });
          return payload;
        } finally {
          set({ isScanning: false });
        }
      },

      installSkills: async (request, options) => {
        startConfigUpdate('Installing skills…');
        set({ isInstalling: true, lastInstallError: null });
        let requiresReload = false;
        try {
          const directoryOverride = typeof options?.directory === 'string' && options.directory.trim().length > 0
            ? options.directory.trim()
            : null;
          const currentDirectory = directoryOverride ?? getCurrentDirectory();
          const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';

          const response = await fetch(`/api/config/skills/install${queryParams}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(request),
          });

          const payload = (await response.json().catch(() => null)) as SkillsInstallResponse | null;
          if (!payload) {
            const error = { kind: 'unknown', message: 'Failed to install skills' } as SkillsInstallError;
            set({ lastInstallError: error });
            updateConfigUpdateMessage('Failed to install skills. Please retry.');
            return { ok: false, error };
          }

          if (!response.ok || !payload.ok) {
            const error = payload.error || ({ kind: 'unknown', message: 'Failed to install skills' } as SkillsInstallError);
            set({ lastInstallError: error });
            updateConfigUpdateMessage(error.message || 'Failed to install skills. Please retry.');
            return { ok: false, error };
          }

          if (payload.requiresReload) {
            requiresReload = true;
            await refreshSkillsAfterOpenCodeRestart({
              message: payload.message,
              delayMs: payload.reloadDelayMs,
            });
          } else {
            updateConfigUpdateMessage(payload.message || 'Refreshing skills…');
            void useSkillsStore.getState().loadSkills();
          }

          return payload;
        } catch (error) {
          const err = { kind: 'unknown', message: error instanceof Error ? error.message : String(error) } as SkillsInstallError;
          set({ lastInstallError: err });
          updateConfigUpdateMessage('Failed to install skills. Please retry.');
          return { ok: false, error: err };
        } finally {
          set({ isInstalling: false });
          if (!requiresReload) {
            finishConfigUpdate();
          }
        }
      },
    }),
    { name: 'skills-catalog-store' }
  )
);
