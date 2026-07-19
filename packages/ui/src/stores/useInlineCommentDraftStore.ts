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

export const getInlineCommentDraftKey = (runtimeKey: string, directory: string, sessionKey: string): string | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory || !sessionKey) return null;
  return JSON.stringify([runtimeKey, normalizedDirectory, sessionKey]);
};

const getCurrentKey = (target: InlineCommentDraftTarget): string | null =>
  getInlineCommentDraftKey(getRuntimeKey(), target.directory, target.sessionKey);

const serializedBytes = (drafts: Record<string, InlineCommentDraft[]>, touchedAt: Record<string, number>): number =>
  new TextEncoder().encode(JSON.stringify({ drafts, touchedAt })).byteLength;

const boundState = (
  drafts: Record<string, InlineCommentDraft[]>,
  touchedAt: Record<string, number>,
): { drafts: Record<string, InlineCommentDraft[]>; touchedAt: Record<string, number> } | null => {
  const keys = Object.keys(drafts).sort((left, right) => (touchedAt[right] ?? 0) - (touchedAt[left] ?? 0));
  const retainedDrafts: Record<string, InlineCommentDraft[]> = {};
  const retainedTouchedAt: Record<string, number> = {};
  for (const key of keys.slice(0, MAX_SESSIONS)) {
    retainedDrafts[key] = drafts[key].slice(-MAX_DRAFTS_PER_SESSION);
    retainedTouchedAt[key] = touchedAt[key] ?? Date.now();
  }
  while (Object.keys(retainedDrafts).length > 0 && serializedBytes(retainedDrafts, retainedTouchedAt) > MAX_PERSISTED_BYTES) {
    const oldest = Object.keys(retainedDrafts).sort((left, right) => retainedTouchedAt[left] - retainedTouchedAt[right])[0];
    delete retainedDrafts[oldest];
    delete retainedTouchedAt[oldest];
  }
  return Object.keys(retainedDrafts).length === 0 && Object.keys(drafts).length > 0
    ? null
    : { drafts: retainedDrafts, touchedAt: retainedTouchedAt };
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
              { ...state.drafts, [key]: [...current, nextDraft] },
              { ...state.touchedAt, [key]: Date.now() },
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
              { ...state.drafts, [key]: current.map((draft) => draft.id === draftId ? { ...draft, ...updates } : draft) },
              { ...state.touchedAt, [key]: Date.now() },
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
          return key ? get().drafts[key] ?? [] : [];
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
              { ...state.drafts, [key]: [...restored, ...current].sort((left, right) => left.createdAt - right.createdAt) },
              { ...state.touchedAt, [key]: Date.now() },
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
