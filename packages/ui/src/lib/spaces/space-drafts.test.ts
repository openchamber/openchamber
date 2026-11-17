import { afterEach, describe, expect, test } from 'bun:test';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDraftsStore, type SessionDraft } from '@/stores/useSessionDraftsStore';
import { prepareGoneSpaceDraftMove } from './space-drafts';

const originalFetch = globalThis.fetch;
const PROJECT = { id: 'p1', path: '/home/me/app' };
const draft = (id: string, directory: string): SessionDraft => ({ id, directory, projectId: PROJECT.id, text: `text of ${id}`, mentions: [], attachments: [{ id: 'a1', filename: 'a.png', mimeType: 'image/png', size: 3, kind: 'data' }], createdAt: 1, updatedAt: 1 });

afterEach(() => {
  globalThis.fetch = originalFetch;
  useSessionDraftsStore.setState({ drafts: [], runtimeKey: null });
});

describe('the drafts of a space that is gone', () => {
  test('move to their project\'s root with their text and stored attachments; a listed space keeps its drafts', async () => {
    const writes: Array<{ path: string; body: unknown }> = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://host').pathname;
      writes.push({ path, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ draft: draft(path.split('/').at(-1) ?? '', PROJECT.path) }), { status: 200 });
    }, originalFetch);
    useProjectsStore.setState({ projects: [{ ...PROJECT, label: 'app', addedAt: 1, lastOpenedAt: 1 }] });
    useSessionDraftsStore.setState({ drafts: [draft('dgone', '/spaces/aaaaaaaaaaaa/app'), draft('dlive', '/spaces/bbbbbbbbbbbb/app'), draft('dhost', PROJECT.path)], runtimeKey: getRuntimeKey() });
    const moveGoneSpaceDrafts = prepareGoneSpaceDraftMove();

    // A draft the window learned of after the list was asked for is left to the next list.
    useSessionDraftsStore.setState({ drafts: [...useSessionDraftsStore.getState().drafts, draft('dnew', '/spaces/cccccccccccc/app')] });
    await moveGoneSpaceDrafts(new Set(['bbbbbbbbbbbb']));

    expect(writes).toEqual([{
      path: '/api/session-drafts/dgone',
      body: { directory: PROJECT.path, projectId: PROJECT.id, text: 'text of dgone', mentions: [], attachments: [{ id: 'a1', filename: 'a.png', mimeType: 'image/png', size: 3 }] },
    }]);
    expect(useSessionDraftsStore.getState().drafts.find((entry) => entry.id === 'dgone')?.directory).toBe(PROJECT.path);
  });
});
