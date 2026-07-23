import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

export type InlineCommentSource = 'diff' | 'plan' | 'file' | 'preview-console' | 'preview-annotation' | 'terminal';

export type InlineCommentDraftTarget = {
  directory: string;
  sessionKey: string;
};

export interface InlineCommentDraft {
  id: string;
  sessionKey: string;
  source: InlineCommentSource;
  fileLabel: string;
  startLine: number;
  endLine: number;
  side?: 'original' | 'modified';
  code: string;
  language: string;
  text: string;
  createdAt: number;
}

export const EMPTY_INLINE_COMMENT_DRAFTS: InlineCommentDraft[] = [];

interface InlineCommentDraftState {
  drafts: Record<string, InlineCommentDraft[]>;
  touchedAt: Record<string, number>;
}

interface InlineCommentDraftActions {
  addDraft: (target: InlineCommentDraftTarget, draft: Omit<InlineCommentDraft, 'id' | 'createdAt' | 'sessionKey'>) => string | null;
  updateDraft: (target: InlineCommentDraftTarget, draftId: string, updates: Partial<Omit<InlineCommentDraft, 'id' | 'createdAt' | 'sessionKey'>>) => void;
  removeDraft: (target: InlineCommentDraftTarget, draftId: string) => void;
  clearDrafts: (target: InlineCommentDraftTarget) => void;
  getDrafts: (target: InlineCommentDraftTarget) => InlineCommentDraft[];
  consumeDrafts: (target: InlineCommentDraftTarget) => InlineCommentDraft[];
  restoreDrafts: (target: InlineCommentDraftTarget, drafts: InlineCommentDraft[]) => void;
  getDraftCount: (target: InlineCommentDraftTarget) => number;
  hasDrafts: (target: InlineCommentDraftTarget) => boolean;
  clearSessionDrafts: (runtimeKey: string, directory: string, sessionId: string) => void;
}

type InlineCommentDraftStore = InlineCommentDraftState & InlineCommentDraftActions;

const MAX_SESSIONS = 50;
const MAX_DRAFTS_PER_SESSION = 20;
const MAX_PERSISTED_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

type SerializedSizeIndex = {
  draftEntries: Map<string, number>;
  touchedEntries: Map<string, number>;
  total: number;
};

const serializedSizeByDrafts = new WeakMap<Record<string, InlineCommentDraft[]>, SerializedSizeIndex>();
const EMPTY_ENVELOPE_BYTES = encoder.encode(JSON.stringify({ drafts: {}, touchedAt: {} })).byteLength;

export const getInlineCommentDraftKey = (runtimeKey: string, directory: string, sessionKey: string): string | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory || !sessionKey) return null;
  return JSON.stringify([runtimeKey, normalizedDirectory, sessionKey]);
};

const getCurrentKey = (target: InlineCommentDraftTarget): string | null =>
  getInlineCommentDraftKey(getRuntimeKey(), target.directory, target.sessionKey);

const serializedEntryBytes = (key: string, value: unknown): number =>
  encoder.encode(`${JSON.stringify(key)}:${JSON.stringify(value)}`).byteLength;

const sumEntryBytes = (entries: Map<string, number>): number => {
  let total = 0;
  for (const bytes of entries.values()) total += bytes;
  return total;
};

const indexedTotal = (draftEntries: Map<string, number>, touchedEntries: Map<string, number>): number => (
  EMPTY_ENVELOPE_BYTES
  + sumEntryBytes(draftEntries)
  + Math.max(0, draftEntries.size - 1)
  + sumEntryBytes(touchedEntries)
  + Math.max(0, touchedEntries.size - 1)
);

const buildSerializedSizeIndex = (
  drafts: Record<string, InlineCommentDraft[]>,
  touchedAt: Record<string, number>,
): SerializedSizeIndex => {
  const draftEntries = new Map<string, number>();
  const touchedEntries = new Map<string, number>();
  for (const [key, value] of Object.entries(drafts)) draftEntries.set(key, serializedEntryBytes(key, value));
  for (const [key, value] of Object.entries(touchedAt)) touchedEntries.set(key, serializedEntryBytes(key, value));
  const index = { draftEntries, touchedEntries, total: indexedTotal(draftEntries, touchedEntries) };
  serializedSizeByDrafts.set(drafts, index);
  return index;
};

const updateSerializedSizeIndex = (
  previous: InlineCommentDraftState,
  drafts: Record<string, InlineCommentDraft[]>,
  touchedAt: Record<string, number>,
  changedKey: string,
): SerializedSizeIndex => {
  const previousIndex = serializedSizeByDrafts.get(previous.drafts)
    ?? buildSerializedSizeIndex(previous.drafts, previous.touchedAt);
  const draftEntries = new Map(previousIndex.draftEntries);
  const touchedEntries = new Map(previousIndex.touchedEntries);
  const bucket = drafts[changedKey];
  if (bucket) draftEntries.set(changedKey, serializedEntryBytes(changedKey, bucket));
  else draftEntries.delete(changedKey);
  const touched = touchedAt[changedKey];
  if (typeof touched === 'number') touchedEntries.set(changedKey, serializedEntryBytes(changedKey, touched));
  else touchedEntries.delete(changedKey);
  return { draftEntries, touchedEntries, total: indexedTotal(draftEntries, touchedEntries) };
};

const boundState = (
  previous: InlineCommentDraftState,
  drafts: Record<string, InlineCommentDraft[]>,
  touchedAt: Record<string, number>,
  changedKey: string,
): { drafts: Record<string, InlineCommentDraft[]>; touchedAt: Record<string, number> } | null => {
  const keys = Object.keys(drafts).sort((left, right) => (touchedAt[right] ?? 0) - (touchedAt[left] ?? 0));
  const retainedKeys = keys.slice(0, MAX_SESSIONS);
  const retainedDrafts: Record<string, InlineCommentDraft[]> = {};
  const retainedTouchedAt: Record<string, number> = {};
  for (const key of retainedKeys) {
    retainedDrafts[key] = drafts[key].length > MAX_DRAFTS_PER_SESSION
      ? drafts[key].slice(-MAX_DRAFTS_PER_SESSION)
      : drafts[key];
    retainedTouchedAt[key] = touchedAt[key] ?? Date.now();
  }
  const sizeIndex = updateSerializedSizeIndex(previous, retainedDrafts, retainedTouchedAt, changedKey);
  for (const key of keys) {
    if (!(key in retainedDrafts)) {
      sizeIndex.draftEntries.delete(key);
      sizeIndex.touchedEntries.delete(key);
    } else if (retainedDrafts[key] !== drafts[key]) {
      sizeIndex.draftEntries.set(key, serializedEntryBytes(key, retainedDrafts[key]));
    }
    if (key !== changedKey && retainedTouchedAt[key] !== previous.touchedAt[key]) {
      sizeIndex.touchedEntries.set(key, serializedEntryBytes(key, retainedTouchedAt[key]));
    }
  }
  sizeIndex.total = indexedTotal(sizeIndex.draftEntries, sizeIndex.touchedEntries);
  const evictionKeys = [...retainedKeys];
  while (evictionKeys.length > 0 && sizeIndex.total > MAX_PERSISTED_BYTES) {
    const oldest = evictionKeys.pop()!;
    delete retainedDrafts[oldest];
    delete retainedTouchedAt[oldest];
    sizeIndex.draftEntries.delete(oldest);
    sizeIndex.touchedEntries.delete(oldest);
    sizeIndex.total = indexedTotal(sizeIndex.draftEntries, sizeIndex.touchedEntries);
  }
  if (sizeIndex.draftEntries.size === 0 && keys.length > 0) return null;
  serializedSizeByDrafts.set(retainedDrafts, sizeIndex);
  return { drafts: retainedDrafts, touchedAt: retainedTouchedAt };
};

const removeDraftKey = (state: InlineCommentDraftState, key: string): InlineCommentDraftState => {
  if (!(key in state.drafts)) return state;

  const drafts = { ...state.drafts };
  const touchedAt = { ...state.touchedAt };
  delete drafts[key];
  delete touchedAt[key];
  return { drafts, touchedAt };
};

export const useInlineCommentDraftStore = create<InlineCommentDraftStore>()(
  devtools(
    persist(
      (set, get) => ({
        drafts: {},
        touchedAt: {},
        addDraft: (target, draft) => {
          const key = getCurrentKey(target);
          if (!key || (draft.source === 'terminal' && !draft.code.trim())) return null;
          const id = `icd-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          const nextDraft: InlineCommentDraft = { ...draft, sessionKey: target.sessionKey, id, createdAt: Date.now() };
          let accepted = false;
          set((state) => {
            const current = state.drafts[key] ?? [];
            const isDuplicateTerminalDraft = draft.source === 'terminal' && current.some((item) => (
              item.source === 'terminal'
              && item.fileLabel === draft.fileLabel
              && item.startLine === draft.startLine
              && item.endLine === draft.endLine
              && item.code === draft.code
            ));
            if (isDuplicateTerminalDraft) return state;

            const bounded = boundState(
              state,
              { ...state.drafts, [key]: [...current, nextDraft] },
              { ...state.touchedAt, [key]: Date.now() },
              key,
            );
            if (!bounded || !bounded.drafts[key]?.some((item) => item.id === id)) return state;
            accepted = true;
            return bounded;
          });
          return accepted ? id : null;
        },
        updateDraft: (target, draftId, updates) => {
          const key = getCurrentKey(target);
          if (!key) return;
          set((state) => {
            const current = state.drafts[key] ?? [];
            if (!current.some((draft) => draft.id === draftId)) return state;
            const bounded = boundState(
              state,
              { ...state.drafts, [key]: current.map((draft) => draft.id === draftId ? { ...draft, ...updates } : draft) },
              { ...state.touchedAt, [key]: Date.now() },
              key,
            );
            return bounded ?? state;
          });
        },
        removeDraft: (target, draftId) => {
          const key = getCurrentKey(target);
          if (!key) return;
          set((state) => {
            const current = state.drafts[key] ?? [];
            const remaining = current.filter((draft) => draft.id !== draftId);
            if (remaining.length === current.length) return state;
            if (remaining.length === 0) return removeDraftKey(state, key);

            const drafts = { ...state.drafts };
            const touchedAt = { ...state.touchedAt };
            drafts[key] = remaining;
            touchedAt[key] = Date.now();
            return { drafts, touchedAt };
          });
        },
        clearDrafts: (target) => {
          const key = getCurrentKey(target);
          if (!key) return;
          set((state) => removeDraftKey(state, key));
        },
        getDrafts: (target) => {
          const key = getCurrentKey(target);
          return key ? get().drafts[key] ?? EMPTY_INLINE_COMMENT_DRAFTS : EMPTY_INLINE_COMMENT_DRAFTS;
        },
        consumeDrafts: (target) => {
          const key = getCurrentKey(target);
          if (!key) return [];
          const drafts = [...(get().drafts[key] ?? [])].sort((left, right) => left.createdAt - right.createdAt);
          if (drafts.length > 0) set((state) => removeDraftKey(state, key));
          return drafts;
        },
        restoreDrafts: (target, draftsToRestore) => {
          const key = getCurrentKey(target);
          if (!key || draftsToRestore.length === 0) return;
          set((state) => {
            const current = state.drafts[key] ?? [];
            const currentIds = new Set(current.map((draft) => draft.id));
            const restored = draftsToRestore.filter((draft) => draft.sessionKey === target.sessionKey && !currentIds.has(draft.id));
            if (restored.length === 0) return state;
            return boundState(
              state,
              { ...state.drafts, [key]: [...restored, ...current].sort((left, right) => left.createdAt - right.createdAt) },
              { ...state.touchedAt, [key]: Date.now() },
              key,
            ) ?? state;
          });
        },
        getDraftCount: (target) => get().getDrafts(target).length,
        hasDrafts: (target) => get().getDrafts(target).length > 0,
        clearSessionDrafts: (runtimeKey, directory, sessionId) => {
          const key = getInlineCommentDraftKey(runtimeKey, directory, sessionId);
          if (!key) return;
          set((state) => removeDraftKey(state, key));
        },
      }),
      {
        name: 'openchamber-inline-comment-drafts',
        storage: createDeferredSafeJSONStorage(),
        version: 2,
        partialize: (state) => ({ drafts: state.drafts, touchedAt: state.touchedAt }),
        migrate: () => ({ drafts: {}, touchedAt: {} }),
      },
    ),
    { name: 'inline-comment-draft-store' },
  ),
);
