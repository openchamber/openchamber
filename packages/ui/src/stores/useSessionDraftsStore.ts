import { z } from 'zod';
import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { AttachedFile } from '@/stores/types/sessionTypes';


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
  targetFolderId: z.string().min(1).optional(),
  lead: z.boolean().optional(),
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
  targetFolderId?: string;
  lead?: boolean;
  text: string;
  mentions: readonly string[];
  attachments: readonly AttachedFile[];
};

type SessionDraftsState = {
  drafts: readonly SessionDraft[];
  runtimeKey: string | null;
};

type SessionDraftsActions = {
  load: () => Promise<void>;
  save: (draftId: string, content: SessionDraftContent) => Promise<void>;
  discard: (draftId: string, options?: { final?: boolean }) => Promise<void>;
  move: (draftId: string, directory: string) => Promise<void>;
};

export const createSessionDraftId = (): string => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const EMPTY: readonly SessionDraft[] = [];

const uploadedAttachmentIds = new Map<string, Set<string>>();
const uploadKey = (draftId: string): string => `${getRuntimeKey()}\u0000${draftId}`;

const writeQueues = new Map<string, Promise<void>>();
const enqueue = (draftId: string, task: () => Promise<void>): Promise<void> => {
  const previous = writeQueues.get(draftId) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(draftId, next.catch(() => undefined));
  return next;
};

const finishedDraftKeys = new Set<string>();

const unsyncedDraftKeys = new Set<string>();

export const hasUnsyncedSessionDraft = (draftId: string): boolean => unsyncedDraftKeys.has(uploadKey(draftId));

export class SessionDraftTooLargeError extends Error {}

const revisions = new Map<string, number>();
const revisionOf = (runtimeKey: string): number => revisions.get(runtimeKey) ?? 0;
const bumpRevision = (runtimeKey: string): void => {
  revisions.set(runtimeKey, revisionOf(runtimeKey) + 1);
};

const attachmentIdOf = (file: AttachedFile): string => `a${file.id.replace(/[^A-Za-z0-9_.-]/g, '-')}`;

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
  const draftsOf = (runtimeKey: string): readonly SessionDraft[] => (get().runtimeKey === runtimeKey ? get().drafts : EMPTY);

  return {
    drafts: EMPTY,
    runtimeKey: null,

    load: async () => {
      const runtimeKey = getRuntimeKey();
      const startedAt = revisionOf(runtimeKey);
      const response = await runtimeFetch('/api/session-drafts').catch(() => null);
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
          targetFolderId: content.targetFolderId,
          lead: content.lead === true ? true : undefined,
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
      const removed = previous.find((draft) => draft.id === draftId);
      if (removed && get().runtimeKey === runtimeKey) {
        set((state) => ({ drafts: state.drafts.some((draft) => draft.id === draftId) ? state.drafts : [...state.drafts, removed] }));
      }
      throw new Error('Failed to discard the draft');
    }),

    move: (draftId, directory) => enqueue(draftId, async () => {
      const key = uploadKey(draftId);
      const runtimeKey = getRuntimeKey();
      const draft = draftsOf(runtimeKey).find((entry) => entry.id === draftId);
      if (!draft || finishedDraftKeys.has(key) || draft.directory === directory) return;
      bumpRevision(runtimeKey);
      const response = await runtimeFetch(`/api/session-drafts/${encodeURIComponent(draftId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directory,
          projectId: draft.projectId,
          text: draft.text,
          mentions: draft.mentions,
          attachments: draft.attachments.map(({ id, filename, mimeType, size }) => ({ id, filename, mimeType, size })),
        }),
      }).catch(() => null);
      if (!response?.ok) throw new Error(`Failed to move the draft (${response?.status ?? 'offline'})`);
      const parsed = savedSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success || runtimeKey !== getRuntimeKey()) return;
      set({ drafts: [...draftsOf(runtimeKey).filter((entry) => entry.id !== draftId), parsed.data.draft], runtimeKey });
    }),
  };
});

export const readSessionDraftAttachment = async (draftId: string, attachment: SessionDraftAttachment): Promise<string | null> => {
  if (attachment.kind !== 'data') return null;
  const response = await runtimeFetch(`/api/session-drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachment.id)}`).catch(() => null);
  if (!response?.ok) return null;
  const blob = await response.blob();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result instanceof ArrayBuffer ? null : reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
};
