import { z } from 'zod';
import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { AttachedFile } from '@/stores/types/sessionTypes';

/**
 * Drafts of new sessions the user started and left before sending. The
 * server keeps them (`web/server/lib/session-drafts`) for every client, so a
 * draft begun on the desktop shows and can be sent on the phone too. The
 * sidebar lists each one where its session would go; the composer keeps the
 * draft it shows in sync (see `components/chat/composer/state/useSessionDraftPublishing.ts`).
 */

const attachmentSchema = z.object({
  id: z.string().min(1),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  kind: z.enum(['data', 'path']),
  path: z.string().optional(),
});

const draftSchema = z.object({
  id: z.string().min(1),
  directory: z.string().min(1),
  projectId: z.string().nullable(),
  text: z.string(),
  mentions: z.array(z.string()),
  attachments: z.array(attachmentSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const listSchema = z.object({ drafts: z.array(draftSchema) });
const savedSchema = z.object({ draft: draftSchema });

export type SessionDraft = z.infer<typeof draftSchema>;
type SessionDraftAttachment = z.infer<typeof attachmentSchema>;

type SessionDraftContent = {
  directory: string;
  projectId: string | null;
  text: string;
  mentions: readonly string[];
  attachments: readonly AttachedFile[];
};

type SessionDraftsState = {
  drafts: readonly SessionDraft[];
  /** Whose drafts these are; a runtime switch drops them until the new server answers. */
  runtimeKey: string | null;
};

type SessionDraftsActions = {
  load: () => Promise<void>;
  save: (draftId: string, content: SessionDraftContent) => Promise<void>;
  /**
   * Removes the draft. `final` for a draft that became a session or was
   * thrown away from its row: a save still on its way for it is dropped
   * rather than bringing it back.
   */
  discard: (draftId: string, options?: { final?: boolean }) => Promise<void>;
};

/** A new draft's id: the server keeps ids of letters, digits, `_`, `.` and `-`. */
export const createSessionDraftId = (): string => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const EMPTY: readonly SessionDraft[] = [];

// Attachments already stored for a draft travel by id only. Keyed by runtime
// and draft, cleared when the draft goes.
const uploadedAttachmentIds = new Map<string, Set<string>>();
const uploadKey = (draftId: string): string => `${getRuntimeKey()}\u0000${draftId}`;

// One write at a time per draft, so a slow save cannot land after a later one.
const writeQueues = new Map<string, Promise<void>>();
const enqueue = (draftId: string, task: () => Promise<void>): Promise<void> => {
  const previous = writeQueues.get(draftId) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(draftId, next.catch(() => undefined));
  return next;
};

// Drafts that are gone for good (sent, or discarded from their row), by
// runtime and draft. Ids are never reused, so the set only grows with use.
const finishedDraftKeys = new Set<string>();

// Drafts this device failed to store, by runtime and draft: their newest text
// is only in this device's composer, so reopening them keeps that copy.
const unsyncedDraftKeys = new Set<string>();

/** Whether this device holds a newer copy of the draft than the server. */
export const hasUnsyncedSessionDraft = (draftId: string): boolean => unsyncedDraftKeys.has(uploadKey(draftId));

/** A save the server refused because the draft's attachments are too large to keep. */
export class SessionDraftTooLargeError extends Error {}

// A load that started before a write must not bring back what the write
// changed: every write bumps its runtime's revision, which a load of the same
// runtime checks before it commits.
const revisions = new Map<string, number>();
const revisionOf = (runtimeKey: string): number => revisions.get(runtimeKey) ?? 0;
const bumpRevision = (runtimeKey: string): void => {
  revisions.set(runtimeKey, revisionOf(runtimeKey) + 1);
};

// The server keeps ids that start with a letter or digit.
const attachmentIdOf = (file: AttachedFile): string => `a${file.id.replace(/[^A-Za-z0-9_.-]/g, '-')}`;

// An attachment restored from a server path comes back as a `file://` URL.
const serverPathOf = (file: AttachedFile): string | null => {
  if (file.source === 'server' && file.serverPath) return file.serverPath;
  if (!file.dataUrl.startsWith('file://')) return null;
  try {
    return decodeURIComponent(file.dataUrl.slice('file://'.length));
  } catch {
    return null;
  }
};

export const useSessionDraftsStore = create<SessionDraftsState & SessionDraftsActions>()((set, get) => {
  /** This runtime's drafts as shown; another runtime's list counts as none. */
  const draftsOf = (runtimeKey: string): readonly SessionDraft[] => (get().runtimeKey === runtimeKey ? get().drafts : EMPTY);

  return {
    drafts: EMPTY,
    runtimeKey: null,

    load: async () => {
      const runtimeKey = getRuntimeKey();
      const startedAt = revisionOf(runtimeKey);
      const response = await runtimeFetch('/api/session-drafts').catch(() => null);
      // A failed read keeps what is shown: it never means there are no drafts.
      if (!response?.ok || runtimeKey !== getRuntimeKey() || startedAt !== revisionOf(runtimeKey)) return;
      const parsed = listSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) return;
      set({ drafts: parsed.data.drafts, runtimeKey });
    },

    save: (draftId, content) => enqueue(draftId, async () => {
      const key = uploadKey(draftId);
      if (finishedDraftKeys.has(key)) return;
      const runtimeKey = getRuntimeKey();
      bumpRevision(runtimeKey);
      const uploaded = uploadedAttachmentIds.get(key) ?? new Set<string>();
      const attachments = content.attachments.flatMap((file) => {
        const base = { id: attachmentIdOf(file), filename: file.filename, mimeType: file.mimeType, size: file.size };
        const serverPath = serverPathOf(file);
        if (serverPath) return [{ ...base, path: serverPath }];
        if (file.source !== 'local' || !file.dataUrl.startsWith('data:')) return [];
        return [uploaded.has(base.id) ? base : { ...base, dataUrl: file.dataUrl }];
      });
      const response = await runtimeFetch(`/api/session-drafts/${encodeURIComponent(draftId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directory: content.directory,
          projectId: content.projectId,
          text: content.text,
          mentions: [...content.mentions],
          attachments,
        }),
      }).catch(() => null);
      if (!response?.ok) {
        unsyncedDraftKeys.add(key);
        if (response?.status === 413) throw new SessionDraftTooLargeError('The draft\'s attachments are too large to keep');
        throw new Error(`Failed to save the draft (${response?.status ?? 'offline'})`);
      }
      unsyncedDraftKeys.delete(key);
      const parsed = savedSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success || runtimeKey !== getRuntimeKey()) return;
      const draft = parsed.data.draft;
      uploadedAttachmentIds.set(key, new Set(draft.attachments.map((attachment) => attachment.id)));
      set({ drafts: [...draftsOf(runtimeKey).filter((entry) => entry.id !== draft.id), draft], runtimeKey });
    }),

    discard: (draftId, options) => enqueue(draftId, async () => {
      const key = uploadKey(draftId);
      if (options?.final) finishedDraftKeys.add(key);
      unsyncedDraftKeys.delete(key);
      uploadedAttachmentIds.delete(key);
      const runtimeKey = getRuntimeKey();
      bumpRevision(runtimeKey);
      const previous = draftsOf(runtimeKey);
      if (get().runtimeKey === runtimeKey) set({ drafts: previous.filter((draft) => draft.id !== draftId) });
      const response = await runtimeFetch(`/api/session-drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' }).catch(() => null);
      if (response?.ok || runtimeKey !== getRuntimeKey()) return;
      // Still on the server: show it again rather than lose it from view.
      const removed = previous.find((draft) => draft.id === draftId);
      if (removed && get().runtimeKey === runtimeKey) {
        set((state) => ({ drafts: state.drafts.some((draft) => draft.id === draftId) ? state.drafts : [...state.drafts, removed] }));
      }
      throw new Error('Failed to discard the draft');
    }),
  };
});

/** A stored attachment's bytes as a data URL, for a composer opening the draft on another device. */
export const readSessionDraftAttachment = async (draftId: string, attachment: SessionDraftAttachment): Promise<string | null> => {
  if (attachment.kind !== 'data') return null;
  const response = await runtimeFetch(`/api/session-drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachment.id)}`).catch(() => null);
  if (!response?.ok) return null;
  const blob = await response.blob();
  return new Promise((resolve) => {
    const reader = new FileReader();
    // `readAsDataURL` always yields a string.
    reader.onload = () => resolve(reader.result instanceof ArrayBuffer ? null : reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
};
