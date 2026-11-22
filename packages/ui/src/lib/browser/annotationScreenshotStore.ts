import { z } from 'zod';

import type { AttachedFile } from '@/stores/types/sessionTypes';
import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';

const DATABASE = 'openchamber-annotation-screenshots';
const DATABASE_VERSION = 1;
const STORE = 'screenshots';
const ORPHAN_GRACE_MS = 60_000;

const recordSchema = z.object({
  draftId: z.string(),
  savedAt: z.number(),
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  file: z.instanceof(Blob),
});

type ScreenshotRecord = z.infer<typeof recordSchema>;

let databasePromise: Promise<IDBDatabase | null> | null = null;

const openDatabase = (): Promise<IDBDatabase | null> => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase | null>((resolve) => {
    const factory = globalThis.indexedDB;
    if (!factory) {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DATABASE, DATABASE_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'draftId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return databasePromise;
};

const settle = <T>(request: IDBRequest<T>): Promise<T | null> => new Promise((resolve) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => resolve(null);
});

const committed = (transaction: IDBTransaction): Promise<boolean> => new Promise((resolve) => {
  transaction.oncomplete = () => resolve(true);
  transaction.onerror = () => resolve(false);
  transaction.onabort = () => resolve(false);
});

const withStore = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>, fallback: T): Promise<T> => {
  const database = await openDatabase();
  if (!database) return fallback;
  try {
    const transaction = database.transaction(STORE, mode);
    const done = committed(transaction);
    const result = await work(transaction.objectStore(STORE));
    return (await done) ? result : fallback;
  } catch {
    return fallback;
  }
};

const BASE64_CHUNK = 0x8000;

const readDataUrl = async (blob: Blob, mimeType: string): Promise<string | null> => {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
};

export const saveAnnotationScreenshot = (draftId: string, attachment: AttachedFile): Promise<boolean> => (
  withStore('readwrite', async (store) => {
    const record: ScreenshotRecord = {
      draftId,
      savedAt: Date.now(),
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      file: attachment.file,
    };
    return (await settle(store.put(record))) !== null;
  }, false)
);

export const hasAnnotationScreenshot = (draftId: string): Promise<boolean> => (
  withStore('readonly', async (store) => (await settle(store.count(draftId))) === 1, false)
);

export const readAnnotationScreenshot = async (draftId: string): Promise<AttachedFile | null> => {
  const stored = await withStore('readonly', (store) => settle(store.get(draftId)), null);
  const record = recordSchema.safeParse(stored);
  if (!record.success) return null;
  const dataUrl = await readDataUrl(record.data.file, record.data.mimeType);
  if (!dataUrl) return null;
  const { id, filename, mimeType, size } = record.data;
  return { id, filename, mimeType, size, dataUrl, source: 'local', file: new File([record.data.file], filename, { type: mimeType }) };
};

const deleteScreenshots = (draftIds: readonly string[]): Promise<void> => (
  draftIds.length === 0 ? Promise.resolve() : withStore('readwrite', async (store) => {
    for (const draftId of draftIds) store.delete(draftId);
  }, undefined)
);

const screenshotDraftIds = (drafts: Record<string, InlineCommentDraft[]>): Set<string> => new Set(
  Object.values(drafts).flat().flatMap((draft) => (draft.screenshot ? [draft.id] : [])),
);

const pruneOrphans = (live: Set<string>): Promise<void> => withStore('readwrite', async (store) => {
  const records = await settle(store.getAll());
  const cutoff = Date.now() - ORPHAN_GRACE_MS;
  for (const stored of records ?? []) {
    const record = recordSchema.safeParse(stored);
    if (!record.success) continue;
    if (!live.has(record.data.draftId) && record.data.savedAt < cutoff) store.delete(record.data.draftId);
  }
}, undefined);

let knownScreenshotDrafts = screenshotDraftIds(useInlineCommentDraftStore.getState().drafts);
void pruneOrphans(knownScreenshotDrafts);
useInlineCommentDraftStore.subscribe((state, previous) => {
  if (state.drafts === previous.drafts) return;
  const next = screenshotDraftIds(state.drafts);
  void deleteScreenshots([...knownScreenshotDrafts].filter((draftId) => !next.has(draftId)));
  knownScreenshotDrafts = next;
});
