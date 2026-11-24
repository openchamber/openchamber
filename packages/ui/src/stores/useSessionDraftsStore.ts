import { z } from 'zod';
import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';


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

const putAttachmentSchema = z.object({
  id: z.string().min(1),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  path: z.string().optional(),
  dataUrl: z.string().optional(),
});

const putBodySchema = z.object({
  directory: z.string().min(1),
  projectId: z.string().nullable(),
  targetFolderId: z.string().min(1).optional(),
  lead: z.literal(true).optional(),
  text: z.string(),
  mentions: z.array(z.string()),
  attachments: z.array(putAttachmentSchema),
});

type PutBody = z.infer<typeof putBodySchema>;

const unsyncedSchema = z.object({ runtimeKey: z.string(), body: putBodySchema, draft: draftSchema, tooLarge: z.boolean().optional() });
type UnsyncedDraft = z.infer<typeof unsyncedSchema>;

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
const keyOf = (runtimeKey: string, draftId: string): string => `${runtimeKey}\u0000${draftId}`;
const uploadKey = (draftId: string): string => keyOf(getRuntimeKey(), draftId);

const writeQueues = new Map<string, Promise<void>>();
const enqueue = (draftId: string, task: () => Promise<void>): Promise<void> => {
  const previous = writeQueues.get(draftId) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(draftId, next.catch(() => undefined));
  return next;
};

const finishedDraftKeys = new Set<string>();

const UNSYNCED_STORAGE_KEY = 'openchamber.sessionDrafts.unsynced.v1';
const storage = getDeferredSafeStorage();

const readStoredUnsynced = (): Map<string, UnsyncedDraft> => {
  const parsed = z.array(unsyncedSchema).safeParse((() => {
    try {
      return JSON.parse(storage.getItem(UNSYNCED_STORAGE_KEY) ?? '[]');
    } catch {
      return null;
    }
  })());
  return new Map((parsed.success ? parsed.data : []).map((entry) => [keyOf(entry.runtimeKey, entry.draft.id), entry]));
};

const unsyncedDrafts = readStoredUnsynced();

const persistUnsynced = (key: string): void => {
  const stored = readStoredUnsynced();
  const entry = unsyncedDrafts.get(key);
  if (entry) {
    stored.set(key, {
      runtimeKey: entry.runtimeKey,
      draft: entry.draft,
      body: { ...entry.body, attachments: entry.body.attachments.map(({ dataUrl: _bytes, ...attachment }) => attachment) },
    });
  } else {
    stored.delete(key);
  }
  if (stored.size === 0) storage.removeItem(UNSYNCED_STORAGE_KEY);
  else storage.setItem(UNSYNCED_STORAGE_KEY, JSON.stringify([...stored.values()]));
};

const forgetUnsynced = (key: string): void => {
  if (unsyncedDrafts.delete(key)) persistUnsynced(key);
};

const serverDraftKeys = new Set<string>();

export const hasUnsyncedSessionDraft = (draftId: string): boolean => unsyncedDrafts.has(uploadKey(draftId));

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

const unsyncedRowOf = (draftId: string, body: PutBody, previous: SessionDraft | undefined): SessionDraft => {
  const at = Date.now();
  return {
    id: draftId,
    directory: body.directory,
    projectId: body.projectId,
    targetFolderId: body.targetFolderId,
    lead: body.lead,
    text: body.text,
    mentions: body.mentions,
    attachments: body.attachments.map(({ id, filename, mimeType, size, path }) => (
      path ? { id, filename, mimeType, size, kind: 'path' as const, path } : { id, filename, mimeType, size, kind: 'data' as const }
    )),
    createdAt: previous?.createdAt ?? at,
    updatedAt: at,
  };
};

export const useSessionDraftsStore = create<SessionDraftsState & SessionDraftsActions>()((set, get) => {
  const draftsOf = (runtimeKey: string): readonly SessionDraft[] => (get().runtimeKey === runtimeKey ? get().drafts : EMPTY);

  const showRow = (runtimeKey: string, draft: SessionDraft): void => {
    set({ drafts: [...draftsOf(runtimeKey).filter((entry) => entry.id !== draft.id), draft], runtimeKey });
  };

  const put = async (draftId: string, runtimeKey: string, body: PutBody, keepFailed = true): Promise<void> => {
    const key = keyOf(runtimeKey, draftId);
    const response = await runtimeFetch(`/api/session-drafts/${encodeURIComponent(draftId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!response?.ok) {
      if (keepFailed) {
        const previous = draftsOf(runtimeKey).find((entry) => entry.id === draftId);
        const draft = unsyncedRowOf(draftId, body, previous);
        unsyncedDrafts.set(key, { runtimeKey, body, draft, tooLarge: response?.status === 413 });
        persistUnsynced(key);
        if (runtimeKey === getRuntimeKey()) showRow(runtimeKey, draft);
      }
      if (response?.status === 413) throw new SessionDraftTooLargeError('The draft\'s attachments are too large to keep');
      throw new Error(`Failed to save the draft (${response?.status ?? 'offline'})`);
    }
    forgetUnsynced(key);
    serverDraftKeys.add(key);
    const parsed = savedSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success || runtimeKey !== getRuntimeKey()) return;
    const draft = parsed.data.draft;
    uploadedAttachmentIds.set(key, new Set(draft.attachments.map((attachment) => attachment.id)));
    showRow(runtimeKey, draft);
  };

  const unsyncedRowsOf = (runtimeKey: string): SessionDraft[] => (
    [...unsyncedDrafts.values()].filter((entry) => entry.runtimeKey === runtimeKey).map((entry) => entry.draft)
  );

  const retryUnsynced = (runtimeKey: string): void => {
    for (const [key, entry] of unsyncedDrafts) {
      if (entry.runtimeKey !== runtimeKey || entry.tooLarge) continue;
      void enqueue(entry.draft.id, async () => {
        const current = unsyncedDrafts.get(key);
        if (!current || current.tooLarge || finishedDraftKeys.has(key) || runtimeKey !== getRuntimeKey()) return;
        bumpRevision(runtimeKey);
        await put(current.draft.id, runtimeKey, current.body);
      }).catch(() => undefined);
    }
  };

  return {
    drafts: EMPTY,
    runtimeKey: null,

    load: async () => {
      const runtimeKey = getRuntimeKey();
      if (get().runtimeKey !== runtimeKey) set({ drafts: unsyncedRowsOf(runtimeKey), runtimeKey });
      const startedAt = revisionOf(runtimeKey);
      const response = await runtimeFetch('/api/session-drafts').catch(() => null);
      if (!response?.ok || runtimeKey !== getRuntimeKey() || startedAt !== revisionOf(runtimeKey)) return;
      const parsed = listSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) return;
      for (const key of serverDraftKeys) if (key.startsWith(keyOf(runtimeKey, ''))) serverDraftKeys.delete(key);
      for (const draft of parsed.data.drafts) serverDraftKeys.add(keyOf(runtimeKey, draft.id));
      const unsynced = unsyncedRowsOf(runtimeKey);
      const unsyncedIds = new Set(unsynced.map((draft) => draft.id));
      set({ drafts: [...parsed.data.drafts.filter((draft) => !unsyncedIds.has(draft.id)), ...unsynced], runtimeKey });
      retryUnsynced(runtimeKey);
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
      await put(draftId, runtimeKey, {
        directory: content.directory,
        projectId: content.projectId,
        targetFolderId: content.targetFolderId,
        lead: content.lead === true ? true : undefined,
        text: content.text,
        mentions: [...content.mentions],
        attachments,
      });
    }),

    discard: (draftId, options) => enqueue(draftId, async () => {
      const key = uploadKey(draftId);
      if (options?.final) finishedDraftKeys.add(key);
      forgetUnsynced(key);
      uploadedAttachmentIds.delete(key);
      const runtimeKey = getRuntimeKey();
      bumpRevision(runtimeKey);
      const previous = draftsOf(runtimeKey);
      if (get().runtimeKey === runtimeKey) set({ drafts: previous.filter((draft) => draft.id !== draftId) });
      const response = await runtimeFetch(`/api/session-drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' }).catch(() => null);
      const onServer = serverDraftKeys.has(key);
      if (response?.ok) serverDraftKeys.delete(key);
      if (response?.ok || !onServer || runtimeKey !== getRuntimeKey()) return;
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
      const unsynced = unsyncedDrafts.get(key);
      await put(draftId, runtimeKey, unsynced ? { ...unsynced.body, directory } : {
        directory,
        projectId: draft.projectId,
        text: draft.text,
        mentions: draft.mentions,
        attachments: draft.attachments.map(({ id, filename, mimeType, size }) => ({ id, filename, mimeType, size })),
      }, false).catch(() => {
        throw new Error('Failed to move the draft');
      });
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
