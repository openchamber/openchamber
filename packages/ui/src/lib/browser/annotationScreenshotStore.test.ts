import { describe, expect, test } from 'bun:test';

// A minimal in-memory IndexedDB covering what the store uses: one object store
// keyed by `draftId` with put/get/count/delete/getAll; a transaction completes
// once the requests made in it have settled.
class FakeRequest<T> {
  result: T | undefined = undefined;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private pending = 0;
  constructor(private readonly records: Map<string, { draftId: string }>) {
    queueMicrotask(() => this.settleIfIdle());
  }
  private settleIfIdle() {
    if (this.pending === 0) queueMicrotask(() => this.oncomplete?.());
  }
  private request<T>(run: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.pending += 1;
    queueMicrotask(() => {
      request.result = run();
      request.onsuccess?.();
      this.pending -= 1;
      this.settleIfIdle();
    });
    return request;
  }
  objectStore() {
    return {
      put: (record: { draftId: string }) => this.request(() => { this.records.set(record.draftId, record); return record.draftId; }),
      get: (key: string) => this.request(() => this.records.get(key)),
      count: (key: string) => this.request(() => (this.records.has(key) ? 1 : 0)),
      delete: (key: string) => this.request(() => { this.records.delete(key); return undefined; }),
      getAll: () => this.request(() => [...this.records.values()]),
    };
  }
}

const records = new Map<string, { draftId: string }>();
const database = { transaction: () => new FakeTransaction(records) };
Object.assign(globalThis, {
  indexedDB: {
    open: () => {
      const request = new FakeRequest<typeof database>();
      queueMicrotask(() => {
        request.result = database;
        request.onsuccess?.();
      });
      return request;
    },
  },
});

const { readAnnotationScreenshot, saveAnnotationScreenshot } = await import('./annotationScreenshotStore');
const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const target = { directory: '/repo', sessionKey: 'session-1' };
const screenshotFile = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
const attachment = {
  id: 'file-1', file: screenshotFile, dataUrl: 'data:image/png;base64,iVBORw==', mimeType: 'image/png',
  filename: 'shot.png', size: screenshotFile.size, source: 'local' as const,
};

describe('annotation screenshots shared by every window', () => {
  test('a screenshot saved under its draft reads back whole', async () => {
    expect(await saveAnnotationScreenshot('icd-1', attachment)).toBe(true);

    const read = await readAnnotationScreenshot('icd-1');

    expect(read).toMatchObject({ id: 'file-1', filename: 'shot.png', mimeType: 'image/png', size: 4, source: 'local' });
    expect(read?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(new Uint8Array(await read!.file.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  test('the screenshot goes when its draft is sent or removed', async () => {
    const store = useInlineCommentDraftStore.getState();
    const draftId = 'icd-2';
    await saveAnnotationScreenshot(draftId, attachment);
    store.addDraft(target, {
      id: draftId, source: 'preview-annotation', fileLabel: 'page', startLine: 1, endLine: 1,
      code: 'Screenshot: attached', language: 'markdown', text: 'look', screenshot: 'shot.png',
    }, { written: true });
    await settled();
    expect(records.has(draftId)).toBe(true);

    store.consumeDrafts(target);
    await settled();
    await settled();

    expect(records.has(draftId)).toBe(false);
    expect(await readAnnotationScreenshot(draftId)).toBeNull();
  });
});
