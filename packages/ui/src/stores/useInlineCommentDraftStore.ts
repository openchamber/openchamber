import { create } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import { getSafeStorage } from './utils/safeStorage';

export type InlineCommentSource = 'diff' | 'plan' | 'file' | 'preview-console' | 'preview-annotation';

export interface InlineCommentDraft {
  id: string;
  sessionKey: string; // sessionId or 'draft' for new sessions
  source: InlineCommentSource;
  fileLabel: string; // filename or 'plan'
  startLine: number;
  endLine: number;
  side?: 'original' | 'modified'; // diff only
  code: string;
  language: string;
  text: string;
  createdAt: number;
}

interface InlineCommentDraftState {
  drafts: Record<string, InlineCommentDraft[]>; // sessionKey -> drafts
}

interface InlineCommentDraftActions {
  addDraft: (draft: Omit<InlineCommentDraft, 'id' | 'createdAt'>) => void;
  updateDraft: (sessionKey: string, draftId: string, updates: Partial<Omit<InlineCommentDraft, 'id' | 'createdAt' | 'sessionKey'>>) => void;
  removeDraft: (sessionKey: string, draftId: string) => void;
  clearDrafts: (sessionKey: string) => void;
  getDrafts: (sessionKey: string) => InlineCommentDraft[];
  consumeDrafts: (sessionKey: string) => InlineCommentDraft[];
  getDraftCount: (sessionKey: string) => number;
  hasDrafts: (sessionKey: string) => boolean;
}

type InlineCommentDraftStore = InlineCommentDraftState & InlineCommentDraftActions;

const isValidSource = (value: unknown): value is InlineCommentSource =>
  value === 'diff' || value === 'plan' || value === 'file' || value === 'preview-console' || value === 'preview-annotation';

const isValidSide = (value: unknown): value is 'original' | 'modified' =>
  value === 'original' || value === 'modified';

const toPositiveLine = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.floor(parsed));
};

const sanitizeDraft = (input: unknown): InlineCommentDraft | null => {
  if (!input || typeof input !== 'object') return null;
  const draft = input as Partial<InlineCommentDraft>;

  if (typeof draft.sessionKey !== 'string' || draft.sessionKey.trim().length === 0) return null;
  if (!isValidSource(draft.source)) return null;

  const startLine = toPositiveLine(draft.startLine);
  const endLine = toPositiveLine(draft.endLine);
  if (!startLine || !endLine) return null;

  const id = typeof draft.id === 'string' && draft.id.trim().length > 0
    ? draft.id
    : `icd-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  return {
    id,
    sessionKey: draft.sessionKey,
    source: draft.source,
    fileLabel: typeof draft.fileLabel === 'string' ? draft.fileLabel : 'unknown',
    startLine,
    endLine,
    side: isValidSide(draft.side) ? draft.side : undefined,
    code: typeof draft.code === 'string' ? draft.code : '',
    language: typeof draft.language === 'string' ? draft.language : 'text',
    text: typeof draft.text === 'string' ? draft.text : '',
    createdAt: Number.isFinite(draft.createdAt) ? Number(draft.createdAt) : Date.now(),
  };
};

const sanitizeDraftMap = (input: unknown): Record<string, InlineCommentDraft[]> => {
  if (!input || typeof input !== 'object') return {};

  const entries = Object.entries(input as Record<string, unknown>);
  const result: Record<string, InlineCommentDraft[]> = {};

  for (const [sessionKey, sessionDrafts] of entries) {
    if (!Array.isArray(sessionDrafts)) continue;

    const sanitized = sessionDrafts
      .map(sanitizeDraft)
      .filter((draft): draft is InlineCommentDraft => Boolean(draft))
      .filter((draft) => draft.sessionKey === sessionKey);

    if (sanitized.length > 0) {
      result[sessionKey] = sanitized;
    }
  }

  return result;
};

export const useInlineCommentDraftStore = create<InlineCommentDraftStore>()(
  devtools(
    persist(
      (set, get) => ({
        drafts: {},

        addDraft: (draft) => {
          const id = `icd-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          const newDraft: InlineCommentDraft = {
            ...draft,
            id,
            createdAt: Date.now(),
          };

          set((state) => {
            const currentDrafts = state.drafts[draft.sessionKey] ?? [];
            return {
              drafts: {
                ...state.drafts,
                [draft.sessionKey]: [...currentDrafts, newDraft],
              },
            };
          });

          return id;
        },

        updateDraft: (sessionKey, draftId, updates) => {
          set((state) => {
            const currentDrafts = state.drafts[sessionKey] ?? [];
            const newDrafts = currentDrafts.map((draft) => {
              if (draft.id !== draftId) {
                return draft;
              }
              return {
                ...draft,
                ...updates,
              };
            });

            return {
              drafts: {
                ...state.drafts,
                [sessionKey]: newDrafts,
              },
            };
          });
        },

        removeDraft: (sessionKey, draftId) => {
          set((state) => {
            const currentDrafts = state.drafts[sessionKey] ?? [];
            const newDrafts = currentDrafts.filter((d) => d.id !== draftId);

            if (newDrafts.length === 0) {
              const { [sessionKey]: _removed, ...rest } = state.drafts;
              void _removed;
              return { drafts: rest };
            }

            return {
              drafts: {
                ...state.drafts,
                [sessionKey]: newDrafts,
              },
            };
          });
        },

        clearDrafts: (sessionKey) => {
          set((state) => {
            const { [sessionKey]: _removed, ...rest } = state.drafts;
            void _removed;
            return { drafts: rest };
          });
        },

        getDrafts: (sessionKey) => {
          return get().drafts[sessionKey] ?? [];
        },

        consumeDrafts: (sessionKey) => {
          const drafts = get().drafts[sessionKey] ?? [];
          if (drafts.length === 0) return [];

          // Sort by creation time to maintain order
          const sortedDrafts = [...drafts].sort((a, b) => a.createdAt - b.createdAt);

          // Clear drafts after consuming
          set((state) => {
            const { [sessionKey]: _removed, ...rest } = state.drafts;
            void _removed;
            return { drafts: rest };
          });

          return sortedDrafts;
        },

        getDraftCount: (sessionKey) => {
          return (get().drafts[sessionKey] ?? []).length;
        },

        hasDrafts: (sessionKey) => {
          return (get().drafts[sessionKey] ?? []).length > 0;
        },
      }),
      {
        name: 'openchamber-inline-comment-drafts',
        storage: createJSONStorage(() => getSafeStorage()),
        version: 1,
        migrate: (persistedState: unknown) => {
          if (!persistedState || typeof persistedState !== 'object') {
            return { drafts: {} };
          }

          const state = persistedState as { drafts?: unknown };
          return {
            drafts: sanitizeDraftMap(state.drafts),
          };
        },
      }
    ),
    { name: 'inline-comment-draft-store' }
  )
);

export default useInlineCommentDraftStore;
