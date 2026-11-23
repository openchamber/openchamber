import { afterEach, describe, expect, test } from 'bun:test';

import { getRuntimeKey } from '@/lib/runtime-switch';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { hasUnsyncedSessionDraft, useSessionDraftsStore, type SessionDraft } from './useSessionDraftsStore';

const originalFetch = globalThis.fetch;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const image: AttachedFile = { id: 'img', file: new File([], 'shot.png'), filename: 'shot.png', mimeType: 'image/png', size: 8, source: 'local', dataUrl: PNG };
const content = (text: string) => ({ directory: '/repo', projectId: 'p1', text, mentions: [], attachments: [image] });

type SentBody = { directory?: string; text?: string; attachments?: Array<{ id: string; dataUrl?: string }> };
type Request = { method: string; path: string; body: SentBody | null };

const serve = (online: () => boolean, requests: Request[]) => {
  const stored = new Map<string, SessionDraft>();
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://host').pathname;
    const method = init?.method ?? 'GET';
    const body: SentBody | null = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, path, body });
    if (!online()) throw new TypeError('Failed to fetch');
    if (method === 'GET') return new Response(JSON.stringify({ drafts: [...stored.values()] }));
    const id = path.split('/').at(-1) ?? '';
    if (method === 'DELETE') {
      stored.delete(id);
      return new Response(JSON.stringify({ deleted: true }));
    }
    const draft: SessionDraft = {
      id, directory: String(body?.directory), projectId: 'p1', text: String(body?.text), mentions: [],
      attachments: [{ id: 'aimg', filename: 'shot.png', mimeType: 'image/png', size: 8, kind: 'data' }], createdAt: 1, updatedAt: 2,
    };
    stored.set(id, draft);
    return new Response(JSON.stringify({ draft }));
  }, originalFetch);
};

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await useSessionDraftsStore.getState().discard('d1').catch(() => undefined);
  useSessionDraftsStore.setState({ drafts: [], runtimeKey: null });
});

describe('a new session draft the server did not get', () => {
  test('keeps a row with its text and is sent again once the server answers', async () => {
    let online = false;
    const requests: Request[] = [];
    serve(() => online, requests);
    const store = useSessionDraftsStore.getState();

    await expect(store.save('d1', content('Fix the login page'))).rejects.toThrow();

    expect(hasUnsyncedSessionDraft('d1')).toBe(true);
    expect(useSessionDraftsStore.getState().drafts).toMatchObject([{ id: 'd1', text: 'Fix the login page', attachments: [{ kind: 'data' }] }]);
    expect(useSessionDraftsStore.getState().runtimeKey).toBe(getRuntimeKey());
    const kept = JSON.parse(getDeferredSafeStorage().getItem('openchamber.sessionDrafts.unsynced.v1') ?? '[]');
    // The stored copy names the image without its bytes, so a send that did reach the server keeps it there.
    expect(kept).toMatchObject([{ draft: { id: 'd1', text: 'Fix the login page' }, body: { attachments: [{ id: 'aimg' }] } }]);
    expect(kept[0].body.attachments[0].dataUrl).toBeUndefined();

    // A window that starts with no connection shows the row before any list arrives.
    useSessionDraftsStore.setState({ drafts: [], runtimeKey: null });
    await store.load();
    expect(useSessionDraftsStore.getState().drafts.map((draft) => draft.id)).toEqual(['d1']);

    // Back online: the list comes back without the draft, the row stays and the draft is sent again with its image.
    online = true;
    requests.length = 0;
    await store.load();
    expect(useSessionDraftsStore.getState().drafts.map((draft) => draft.id)).toEqual(['d1']);
    // A move to where the draft already is does nothing, and finishes after the retry queued before it.
    await useSessionDraftsStore.getState().move('d1', '/repo');

    const puts = requests.filter((request) => request.method === 'PUT');
    expect(puts[0]?.body).toMatchObject({ text: 'Fix the login page', attachments: [{ id: 'aimg', dataUrl: PNG }] });
    expect(hasUnsyncedSessionDraft('d1')).toBe(false);
    expect(getDeferredSafeStorage().getItem('openchamber.sessionDrafts.unsynced.v1')).toBeNull();
    expect(useSessionDraftsStore.getState().drafts).toMatchObject([{ id: 'd1', updatedAt: 2 }]);
  });

  test('loses its row when the user throws it away offline', async () => {
    serve(() => false, []);
    await useSessionDraftsStore.getState().save('d2', content('Draft')).catch(() => undefined);
    await useSessionDraftsStore.getState().discard('d2');

    expect(hasUnsyncedSessionDraft('d2')).toBe(false);
    expect(useSessionDraftsStore.getState().drafts).toEqual([]);
  });
});
