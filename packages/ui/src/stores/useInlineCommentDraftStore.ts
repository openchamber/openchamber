import type { SourceControlProvider } from '@/lib/source-control/types';
import { create } from 'zustand';
import { z } from 'zod';
import { sourceControlProviderIdSchema } from '@/lib/source-control/providers/descriptor';
import { devtools, persist } from 'zustand/middleware';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { chatQuoteAnchorSchema, type ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import { diffCommentOriginSchema, type DiffCommentOrigin } from '@/lib/diffCommentOrigin';

export type InlineCommentSource = 'diff' | 'plan' | 'file' | 'preview-annotation' | 'terminal' | 'pr-comment' | 'pr-check' | 'chat-quote' | 'file-quote';

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
  /** Owning terminal session; set only for `source: 'terminal'`. */
  terminalId?: string;
  /** Where the quote sits in its message; set only for `source: 'chat-quote'`. */
  anchor?: ChatQuoteAnchor;
  /** Whose change request it came from; set only for `pr-comment` and `pr-check`, absent means GitHub. */
  provider?: SourceControlProvider;
  /** The diff a `diff` comment was written on; absent for uncommitted changes. */
  origin?: DiffCommentOrigin;
  /**
   * Filed for the chat composer (a VS Code code comment). Its text is typed in
   * the chip's card, so cancelling that card while it is still empty removes
   * it; every other draft keeps its quote even with no text.
   */
  composing?: boolean;
  createdAt: number;
}

export const EMPTY_INLINE_COMMENT_DRAFTS: InlineCommentDraft[] = [];

interface InlineCommentDraftState {
  drafts: Record<string, InlineCommentDraft[]>;
}

interface InlineCommentDraftActions {
  // Returns the draft id, or null when the draft is rejected (unresolved target,
  // no room left, or an empty terminal-context selection). A terminal selection
  // that is already attached returns the id of the draft holding it.
  // `id` lets an external owner (the VS Code editor comment thread) choose the
  // draft id up front. Omitted by every in-app caller, which gets a generated one.
  // `written` stores text with no editor left to hold it, such as context put back
  // after a failed send or a closed annotation overlay. The bounds never refuse it.
  addDraft: (target: InlineCommentDraftTarget, draft: Omit<InlineCommentDraft, 'id' | 'createdAt' | 'sessionKey'> & { id?: string }, options?: { written?: boolean }) => string | null;
  // Returns false when the draft is gone or the bounds reject the update.
  updateDraft: (target: InlineCommentDraftTarget, draftId: string, updates: Partial<Omit<InlineCommentDraft, 'id' | 'createdAt' | 'sessionKey'>>) => boolean;
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
const MAX_PERSISTED_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

type SerializedSizeIndex = {
  entries: Map<string, number>;
  total: number;
};

const serializedSizeByDrafts = new WeakMap<Record<string, InlineCommentDraft[]>, SerializedSizeIndex>();
const EMPTY_ENVELOPE_BYTES = encoder.encode(JSON.stringify({ drafts: {} })).byteLength;

export const getInlineCommentDraftKey = (runtimeKey: string, directory: string, sessionKey: string): string | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory || !sessionKey) return null;
  return JSON.stringify([runtimeKey, normalizedDirectory, sessionKey]);
};

const getCurrentKey = (target: InlineCommentDraftTarget): string | null =>
  getInlineCommentDraftKey(getRuntimeKey(), target.directory, target.sessionKey);

const serializedEntryBytes = (key: string, value: unknown): number =>
  encoder.encode(`${JSON.stringify(key)}:${JSON.stringify(value)}`).byteLength;

const indexedTotal = (entries: Map<string, number>): number => {
  let total = EMPTY_ENVELOPE_BYTES + Math.max(0, entries.size - 1);
  for (const bytes of entries.values()) total += bytes;
  return total;
};

const serializedSizeOf = (drafts: Record<string, InlineCommentDraft[]>): SerializedSizeIndex => {
  const known = serializedSizeByDrafts.get(drafts);
  if (known) return known;
  const entries = new Map<string, number>();
  for (const [key, value] of Object.entries(drafts)) entries.set(key, serializedEntryBytes(key, value));
  const index = { entries, total: indexedTotal(entries) };
  serializedSizeByDrafts.set(drafts, index);
  return index;
};

const serializedSizeAfter = (
  previous: Record<string, InlineCommentDraft[]>,
  drafts: Record<string, InlineCommentDraft[]>,
  changedKey: string,
): SerializedSizeIndex => {
  const entries = new Map(serializedSizeOf(previous).entries);
  entries.set(changedKey, serializedEntryBytes(changedKey, drafts[changedKey]));
  return { entries, total: indexedTotal(entries) };
};

// Text with no editor left to hold it is stored whatever the bounds say: a failed
// send, a reverted message or a closed annotation overlay has nowhere else to keep it.
const keepWritten = (
  previous: InlineCommentDraftState,
  drafts: Record<string, InlineCommentDraft[]>,
  changedKey: string,
): InlineCommentDraftState => {
  serializedSizeByDrafts.set(drafts, serializedSizeAfter(previous.drafts, drafts, changedKey));
  return { drafts };
};

// Refuses the change instead of making room: every stored comment is something
// the person wrote and has not sent, and nothing can bring it back. An edit
// that does not grow the store passes, so shrinking works past the bound.
const boundState = (
  previous: InlineCommentDraftState,
  drafts: Record<string, InlineCommentDraft[]>,
  changedKey: string,
): InlineCommentDraftState | null => {
  if (!(changedKey in previous.drafts) && Object.keys(drafts).length > MAX_SESSIONS) return null;
  const size = serializedSizeAfter(previous.drafts, drafts, changedKey);
  if (size.total > MAX_PERSISTED_BYTES && size.total > serializedSizeOf(previous.drafts).total) return null;
  serializedSizeByDrafts.set(drafts, size);
  return { drafts };
};

const EMPTY_PERSISTED_STATE: InlineCommentDraftState = { drafts: {} };

const persistedDraftSchema = z.object({
  id: z.string(),
  sessionKey: z.string(),
  source: z.enum(['diff', 'plan', 'file', 'preview-annotation', 'terminal', 'pr-comment', 'pr-check', 'chat-quote', 'file-quote']),
  fileLabel: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  side: z.enum(['original', 'modified']).optional(),
  code: z.string(),
  language: z.string(),
  text: z.string(),
  terminalId: z.string().optional(),
  anchor: chatQuoteAnchorSchema.optional(),
  provider: sourceControlProviderIdSchema.optional(),
  origin: diffCommentOriginSchema.optional(),
  composing: z.boolean().optional(),
  createdAt: z.number(),
});

export const persistedDraftEnvelopeSchema = z.object({
  drafts: z.record(z.string(), z.array(z.unknown())),
});

type PersistedDraftEnvelopeResult = z.ZodSafeParseResult<z.infer<typeof persistedDraftEnvelopeSchema>>;

/**
 * v2 → v3: terminal drafts carried their terminal id in `language`; move it to
 * the dedicated `terminalId` field. Drafts from the removed 'preview-console'
 * source are dropped, as are malformed entries. Pre-v2 or unreadable payloads
 * reset entirely (the pre-v3 behavior).
 */
export const migratePersistedDrafts = (envelope: PersistedDraftEnvelopeResult, version: number): InlineCommentDraftState => {
  if (version < 2) return EMPTY_PERSISTED_STATE;
  if (!envelope.success) return EMPTY_PERSISTED_STATE;

  const drafts: Record<string, InlineCommentDraft[]> = {};
  for (const [key, bucket] of Object.entries(envelope.data.drafts)) {
    const migrated: InlineCommentDraft[] = [];
    for (const entry of bucket) {
      const parsed = persistedDraftSchema.safeParse(entry);
      if (!parsed.success) continue;
      const draft = parsed.data;
      if (draft.source === 'terminal' && !draft.terminalId) {
        migrated.push({ ...draft, terminalId: draft.language, language: '' });
      } else {
        migrated.push(draft);
      }
    }
    if (migrated.length > 0) drafts[key] = migrated;
  }

  return { drafts };
};

const removeDraftKey = (state: InlineCommentDraftState, key: string): InlineCommentDraftState => {
  if (!(key in state.drafts)) return state;

  const drafts = { ...state.drafts };
  delete drafts[key];
  return { drafts };
};

export const useInlineCommentDraftStore = create<InlineCommentDraftStore>()(
  devtools(
    persist(
      (set, get) => ({
        drafts: {},
        addDraft: (target, draft, options) => {
          const key = getCurrentKey(target);
          if (!key || (draft.source === 'terminal' && !draft.code.trim())) return null;
          // A caller that owns its own view of the draft (the VS Code editor
          // thread) supplies the id so it can correlate without a round trip.
          // A colliding id would silently retarget edits and removals at an
          // unrelated draft, so it is refused rather than reused.
          const requestedId = draft.id?.trim();
          const idIsTaken = Boolean(requestedId) && (get().drafts[key] ?? []).some((item) => item.id === requestedId);
          const id = requestedId && !idIsTaken
            ? requestedId
            : `icd-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          const nextDraft: InlineCommentDraft = { ...draft, sessionKey: target.sessionKey, id, createdAt: Date.now() };
          let storedId: string | null = null;
          set((state) => {
            const current = state.drafts[key] ?? [];
            const attached = draft.source === 'terminal' ? current.find((item) => (
              item.source === 'terminal'
              && item.fileLabel === draft.fileLabel
              && item.startLine === draft.startLine
              && item.endLine === draft.endLine
              && item.code === draft.code
            )) : undefined;
            if (attached) {
              storedId = attached.id;
              return state;
            }

            const drafts = { ...state.drafts, [key]: [...current, nextDraft] };
            const stored = options?.written ? keepWritten(state, drafts, key) : boundState(state, drafts, key);
            if (!stored) return state;
            storedId = id;
            return stored;
          });
          return storedId;
        },
        updateDraft: (target, draftId, updates) => {
          const key = getCurrentKey(target);
          if (!key) return false;
          let accepted = false;
          set((state) => {
            const current = state.drafts[key] ?? [];
            if (!current.some((draft) => draft.id === draftId)) return state;
            const bounded = boundState(
              state,
              { ...state.drafts, [key]: current.map((draft) => draft.id === draftId ? { ...draft, ...updates } : draft) },
              key,
            );
            if (!bounded) return state;
            accepted = true;
            return bounded;
          });
          return accepted;
        },
        removeDraft: (target, draftId) => {
          const key = getCurrentKey(target);
          if (!key) return;
          set((state) => {
            const current = state.drafts[key] ?? [];
            const remaining = current.filter((draft) => draft.id !== draftId);
            if (remaining.length === current.length) return state;
            if (remaining.length === 0) return removeDraftKey(state, key);

            return { drafts: { ...state.drafts, [key]: remaining } };
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
            return keepWritten(
              state,
              { ...state.drafts, [key]: [...restored, ...current].sort((left, right) => left.createdAt - right.createdAt) },
              key,
            );
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
        version: 3,
        partialize: (state) => ({ drafts: state.drafts }),
        migrate: (persisted, version) => migratePersistedDrafts(persistedDraftEnvelopeSchema.safeParse(persisted), version),
      },
    ),
    { name: 'inline-comment-draft-store' },
  ),
);
