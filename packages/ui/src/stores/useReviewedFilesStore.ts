import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { sessionEvents } from '@/lib/sessionEvents';
import {
  doesReviewedFingerprintMatch,
  mergeReviewedFingerprint,
  reviewedFilesScopeKey,
  type ReviewedFileFingerprint,
} from '@/lib/reviewedFiles';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

const REVIEWED_FILES_STORAGE_KEY = 'openchamber.reviewed-files.v1';
const MAX_PERSISTED_SCOPES = 40;
const WORKING_TREE_SCOPES = ['working', 'staged'] as const;

interface ReviewedScopeRecord {
  updatedAt: number;
  files: Record<string, ReviewedFileFingerprint>;
}

const EMPTY_FILES: Readonly<Record<string, ReviewedFileFingerprint>> = Object.freeze({});

const trimScopes = (
  scopes: Record<string, ReviewedScopeRecord>,
): Record<string, ReviewedScopeRecord> => {
  const entries = Object.entries(scopes).filter(([, record]) => Object.keys(record.files).length > 0);
  if (entries.length <= MAX_PERSISTED_SCOPES) {
    return Object.fromEntries(entries);
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_PERSISTED_SCOPES));
};

type ReviewedFilesState = {
  scopes: Record<string, ReviewedScopeRecord>;
  markReviewed: (scopeKey: string, path: string, fingerprint: ReviewedFileFingerprint) => void;
  unmarkReviewed: (scopeKey: string, path: string) => void;
  toggleReviewed: (scopeKey: string, path: string, fingerprint: ReviewedFileFingerprint) => boolean;
  reconcileScope: (
    scopeKey: string,
    currentFiles: ReadonlyMap<string, ReviewedFileFingerprint>,
    options?: { pruneMissing?: boolean },
  ) => string[];
  invalidateWorkingTreePaths: (runtimeKey: string, directory: string, paths: readonly string[]) => void;
  clearScope: (scopeKey: string) => void;
};

export const useReviewedFilesStore = create<ReviewedFilesState>()(
  persist(
    (set, get) => ({
      scopes: {},

      markReviewed: (scopeKey, path, fingerprint) => {
        if (!scopeKey || !path) return;
        set((state) => {
          const existing = state.scopes[scopeKey];
          const nextFiles = { ...(existing?.files ?? {}), [path]: { ...fingerprint } };
          const nextScopes = trimScopes({
            ...state.scopes,
            [scopeKey]: { updatedAt: Date.now(), files: nextFiles },
          });
          return { scopes: nextScopes };
        });
      },

      unmarkReviewed: (scopeKey, path) => {
        if (!scopeKey || !path) return;
        set((state) => {
          const existing = state.scopes[scopeKey];
          if (!existing || !(path in existing.files)) return state;
          const nextFiles = { ...existing.files };
          delete nextFiles[path];
          const nextScopes = { ...state.scopes };
          if (Object.keys(nextFiles).length === 0) {
            delete nextScopes[scopeKey];
          } else {
            nextScopes[scopeKey] = { updatedAt: Date.now(), files: nextFiles };
          }
          return { scopes: nextScopes };
        });
      },

      toggleReviewed: (scopeKey, path, fingerprint) => {
        if (!scopeKey || !path) return false;
        const existing = get().scopes[scopeKey]?.files[path];
        if (existing && doesReviewedFingerprintMatch(existing, fingerprint)) {
          get().unmarkReviewed(scopeKey, path);
          return false;
        }
        get().markReviewed(scopeKey, path, fingerprint);
        return true;
      },

      reconcileScope: (scopeKey, currentFiles, options) => {
        if (!scopeKey) return [];
        const existing = get().scopes[scopeKey];
        if (!existing) return [];

        const pruneMissing = options?.pruneMissing === true;
        const invalidated: string[] = [];
        let changed = false;
        const nextFiles: Record<string, ReviewedFileFingerprint> = {};

        for (const [path, stored] of Object.entries(existing.files)) {
          const current = currentFiles.get(path);
          if (!current) {
            if (pruneMissing) {
              changed = true;
              continue;
            }
            nextFiles[path] = stored;
            continue;
          }
          if (!doesReviewedFingerprintMatch(stored, current)) {
            changed = true;
            invalidated.push(path);
            continue;
          }
          const merged = mergeReviewedFingerprint(stored, current);
          if (merged) {
            changed = true;
            nextFiles[path] = merged;
          } else {
            nextFiles[path] = stored;
          }
        }

        if (!changed) return [];

        set((state) => {
          const latest = state.scopes[scopeKey];
          if (latest !== existing) {
            const mergedFiles = { ...(latest?.files ?? {}) };
            for (const path of invalidated) delete mergedFiles[path];
            const nextScopes = { ...state.scopes };
            if (Object.keys(mergedFiles).length === 0) delete nextScopes[scopeKey];
            else nextScopes[scopeKey] = { updatedAt: Date.now(), files: mergedFiles };
            return { scopes: nextScopes };
          }
          const nextScopes = { ...state.scopes };
          if (Object.keys(nextFiles).length === 0) {
            delete nextScopes[scopeKey];
          } else {
            nextScopes[scopeKey] = { updatedAt: existing.updatedAt, files: nextFiles };
          }
          return { scopes: nextScopes };
        });

        return invalidated;
      },

      invalidateWorkingTreePaths: (runtimeKey, directory, paths) => {
        if (!directory || paths.length === 0) return;
        const pathSet = new Set(paths);
        set((state) => {
          let changed = false;
          const nextScopes = { ...state.scopes };
          for (const scope of WORKING_TREE_SCOPES) {
            const key = reviewedFilesScopeKey(runtimeKey, directory, { kind: 'working-tree', scope });
            const existing = nextScopes[key];
            if (!existing) continue;
            let scopeChanged = false;
            const nextFiles = { ...existing.files };
            for (const path of pathSet) {
              if (path in nextFiles) {
                delete nextFiles[path];
                scopeChanged = true;
              }
            }
            if (!scopeChanged) continue;
            changed = true;
            if (Object.keys(nextFiles).length === 0) {
              delete nextScopes[key];
            } else {
              nextScopes[key] = { updatedAt: Date.now(), files: nextFiles };
            }
          }
          return changed ? { scopes: nextScopes } : state;
        });
      },

      clearScope: (scopeKey) => {
        if (!scopeKey) return;
        set((state) => {
          if (!(scopeKey in state.scopes)) return state;
          const nextScopes = { ...state.scopes };
          delete nextScopes[scopeKey];
          return { scopes: nextScopes };
        });
      },
    }),
    {
      name: REVIEWED_FILES_STORAGE_KEY,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ scopes: state.scopes }),
    },
  ),
);

export const selectReviewedFilesForScope = (
  scopeKey: string | null,
) => (state: ReviewedFilesState): Readonly<Record<string, ReviewedFileFingerprint>> =>
  (scopeKey ? state.scopes[scopeKey]?.files : undefined) ?? EMPTY_FILES;

sessionEvents.onGitRefreshHint((hint) => {
  if (!hint.paths?.length) return;
  useReviewedFilesStore.getState().invalidateWorkingTreePaths(getRuntimeKey(), hint.directory, hint.paths);
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== REVIEWED_FILES_STORAGE_KEY) return;
    void useReviewedFilesStore.persist.rehydrate();
  });
}
