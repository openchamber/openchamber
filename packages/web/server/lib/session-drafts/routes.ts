import express from 'express';
import { z } from 'zod';
import type { Application } from '../shared/http-contracts.js';

export interface SessionDraftDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'readFile' | 'mkdir' | 'writeFile' | 'rename' | 'unlink' | 'readdir' | 'rmdir'>;
  path: Pick<typeof import('node:path'), 'join' | 'resolve' | 'dirname'>;
  openchamberDataDir: string;
  onChanged?: (updatedAt: number) => void;
  now?: () => number;
}

const FILE_NAME = 'session-drafts.json';
const ATTACHMENT_DIRECTORY = 'session-drafts';
const MAX_DRAFTS = 200;
const MAX_TEXT_LENGTH = 200_000;
const MAX_ATTACHMENTS = 20;
const MAX_BODY = '40mb';
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

const storedAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('data'), id, filename: z.string().max(1024), mimeType: z.string().max(256), size: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('path'), id, filename: z.string().max(1024), mimeType: z.string().max(256), size: z.number().int().nonnegative(), path: z.string().min(1).max(4096) }),
]);

const storedDraftSchema = z.object({
  id,
  directory: z.string().min(1).max(4096),
  projectId: z.string().max(512).nullable(),
  targetFolderId: z.string().min(1).max(512).optional(),
  lead: z.literal(true).optional(),
  text: z.string().max(MAX_TEXT_LENGTH),
  mentions: z.array(z.string().max(4096)).max(500),
  attachments: z.array(storedAttachmentSchema).max(MAX_ATTACHMENTS),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const storeSchema = z.object({ version: z.literal(1), drafts: z.array(storedDraftSchema) });

type StoredAttachment = z.infer<typeof storedAttachmentSchema>;
type StoredDraft = z.infer<typeof storedDraftSchema>;
type DraftStore = z.infer<typeof storeSchema>;

const incomingAttachmentSchema = z.object({
  id,
  filename: z.string().max(1024),
  mimeType: z.string().max(256),
  size: z.number().int().nonnegative(),
  dataUrl: z.string().startsWith('data:').optional(),
  path: z.string().min(1).max(4096).optional(),
});

const putBodySchema = z.object({
  directory: z.string().min(1).max(4096),
  projectId: z.string().max(512).nullable().optional(),
  targetFolderId: z.string().min(1).max(512).optional(),
  lead: z.literal(true).optional(),
  text: z.string().max(MAX_TEXT_LENGTH),
  mentions: z.array(z.string().max(4096)).max(500).optional(),
  attachments: z.array(incomingAttachmentSchema).max(MAX_ATTACHMENTS).optional(),
});

const decodeDataUrl = (dataUrl: string) => {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.slice(0, comma).toLowerCase().endsWith(';base64')) return null;
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
};

const toPublicDraft = (draft: StoredDraft) => ({
  id: draft.id,
  directory: draft.directory,
  projectId: draft.projectId,
  targetFolderId: draft.targetFolderId,
  lead: draft.lead,
  text: draft.text,
  mentions: draft.mentions,
  attachments: draft.attachments.map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind,
    path: attachment.kind === 'path' ? attachment.path : undefined,
  })),
  createdAt: draft.createdAt,
  updatedAt: draft.updatedAt,
});

const isMissingFileError = (error: unknown): error is { code: 'ENOENT' } => (
  error !== null
  && (typeof error === 'object' || typeof error === 'function')
  && 'code' in error
  && error.code === 'ENOENT'
);

export const registerSessionDraftRoutes = (app: Application, dependencies: SessionDraftDependencies) => {
  const {
    fsPromises,
    path,
    openchamberDataDir,
    onChanged = () => {},
    now = Date.now,
  } = dependencies;

  const filePath = path.join(openchamberDataDir, FILE_NAME);
  const attachmentRoot = path.join(openchamberDataDir, ATTACHMENT_DIRECTORY);
  const draftFolder = (draftId: string) => {
    const folder = path.resolve(attachmentRoot, draftId);
    if (path.dirname(folder) !== path.resolve(attachmentRoot)) throw new Error('Invalid session draft id');
    return folder;
  };
  const attachmentPath = (draftId: string, attachmentId: string) => {
    const file = path.resolve(draftFolder(draftId), attachmentId);
    if (path.dirname(file) !== draftFolder(draftId)) throw new Error('Invalid attachment id');
    return file;
  };
  let queue = Promise.resolve();
  const serialize = <T,>(task: () => Promise<T>) => {
    const pending = queue.then(task, task);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const readStore = async (): Promise<DraftStore> => {
    const raw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    if (raw === null) return { version: 1, drafts: [] };
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error('Stored session drafts are malformed');
    return parsed.data;
  };

  const writeStore = async (store: DraftStore) => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await fsPromises.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.unlink(tmp).catch(() => {});
      throw error;
    }
  };

  const announce = () => {
    try {
      onChanged(now());
    } catch {
      return;
    }
  };

  const removeAttachmentFiles = (draftId: string, keep = new Set<string>()) => Promise.resolve()
    .then(() => fsPromises.readdir(draftFolder(draftId)))
    .then((entries) => Promise.all(entries.filter((entry) => !keep.has(entry)).map((entry) => (
      fsPromises.unlink(attachmentPath(draftId, entry)).catch(() => {})
    ))))
    .then(() => keep.size === 0 ? fsPromises.rmdir(draftFolder(draftId)).catch(() => {}) : undefined)
    .catch(() => {});

  app.get('/api/session-drafts', async (_req, res) => {
    try {
      const store = await readStore();
      res.json({ drafts: store.drafts.map(toPublicDraft) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read session drafts' });
    }
  });

  app.put('/api/session-drafts/:id', express.json({ limit: MAX_BODY }), async (req, res) => {
    const draftId = id.safeParse(req.params.id);
    const body = putBodySchema.safeParse(req.body);
    if (!draftId.success || !body.success) return res.status(400).json({ error: 'Invalid session draft' });
    return serialize(async () => {
      try {
        const store = await readStore();
        const existing = store.drafts.find((draft) => draft.id === draftId.data) ?? null;
        if (!existing && store.drafts.length >= MAX_DRAFTS) {
          return res.status(409).json({ error: `At most ${MAX_DRAFTS} drafts are kept; send or discard one first` });
        }
        const prepared: Array<{ attachment: StoredAttachment; data?: Buffer }> = [];
        let bytes = 0;
        for (const incoming of body.data.attachments ?? []) {
          const kept = existing?.attachments.find((attachment) => attachment.id === incoming.id);
          if (incoming.dataUrl) {
            const data = decodeDataUrl(incoming.dataUrl);
            if (!data) return res.status(400).json({ error: `Attachment ${incoming.filename} is not a base64 data URL` });
            bytes += data.length;
            prepared.push({
              attachment: { kind: 'data', id: incoming.id, filename: incoming.filename, mimeType: incoming.mimeType, size: data.length },
              data,
            });
          } else if (incoming.path) {
            prepared.push({
              attachment: { kind: 'path', id: incoming.id, filename: incoming.filename, mimeType: incoming.mimeType, size: incoming.size, path: incoming.path },
            });
          } else if (kept) {
            if (kept.kind === 'data') bytes += kept.size;
            prepared.push({ attachment: kept });
          }
        }
        if (bytes > MAX_ATTACHMENT_BYTES && prepared.some(({ data }) => data)) {
          return res.status(413).json({ error: 'The draft\'s attachments are too large' });
        }

        for (const { attachment, data } of prepared) {
          if (!data) continue;
          await fsPromises.mkdir(draftFolder(draftId.data), { recursive: true });
          await fsPromises.writeFile(attachmentPath(draftId.data, attachment.id), data);
        }
        const attachments = prepared.map(({ attachment }) => attachment);
        const at = now();
        const draft = {
          id: draftId.data,
          directory: body.data.directory,
          projectId: body.data.projectId ?? null,
          targetFolderId: body.data.targetFolderId,
          lead: body.data.lead,
          text: body.data.text,
          mentions: body.data.mentions ?? [],
          attachments,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
        };
        await writeStore({ version: 1, drafts: [...store.drafts.filter((entry) => entry.id !== draft.id), draft] });
        await removeAttachmentFiles(draft.id, new Set(attachments.filter((attachment) => attachment.kind === 'data').map((attachment) => attachment.id)));
        announce();
        return res.json({ draft: toPublicDraft(draft) });
      } catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save the session draft' });
      }
    });
  });

  app.delete('/api/session-drafts/:id', async (req, res) => {
    const draftId = id.safeParse(req.params.id);
    if (!draftId.success) return res.status(400).json({ error: 'Invalid session draft id' });
    return serialize(async () => {
      try {
        const store = await readStore();
        const drafts = store.drafts.filter((draft) => draft.id !== draftId.data);
        if (drafts.length !== store.drafts.length) {
          await writeStore({ version: 1, drafts });
          announce();
        }
        await removeAttachmentFiles(draftId.data);
        return res.json({ deleted: drafts.length !== store.drafts.length });
      } catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to discard the session draft' });
      }
    });
  });

  app.get('/api/session-drafts/:id/attachments/:attachmentId', async (req, res) => {
    const draftId = id.safeParse(req.params.id);
    const attachmentId = id.safeParse(req.params.attachmentId);
    if (!draftId.success || !attachmentId.success) return res.status(400).json({ error: 'Invalid attachment' });
    try {
      const store = await readStore();
      const attachment = store.drafts.find((draft) => draft.id === draftId.data)?.attachments
        .find((entry) => entry.id === attachmentId.data && entry.kind === 'data');
      if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
      const data = await fsPromises.readFile(attachmentPath(draftId.data, attachmentId.data));
      res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.send(data);
    } catch (error) {
      return res.status(isMissingFileError(error) ? 404 : 500).json({ error: error instanceof Error ? error.message : 'Failed to read the attachment' });
    }
  });
};
