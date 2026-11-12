import { describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import {
  applyGlobalBlockingRequestEvents,
  readHostBlockingRequestsSnapshot,
  resetGlobalBlockingRequests,
} from '@/sync/global-blocking-requests';
import { SyncProvider, useDirectoryStore } from '@/sync/sync-context';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { usePendingRequests, type PendingRequests } from './usePendingRequests';

const PARENT_DIR = '/repo';
const CHILD_DIR = '/worktrees/feature';
const FAMILY = ['parent', 'child'] as const;

// SAFETY: the row reads only these fields off a session, so the fixture stands
// in for a full `Session` without building one.
const session = (id: string, directory?: string): Session => ({
  id,
  title: id,
  directory,
} as Session);

const createSdk = () => OpenCode.make({
  baseUrl: 'https://pending.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/location')
      ? { directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

type PendingCapture = { renders: number; pending: PendingRequests | null };
type StoresCapture = { parent: ReturnType<typeof useDirectoryStore> | null };

const withHarness = async (
  entities: readonly Session[],
  assert: (capture: PendingCapture, stores: StoresCapture) => Promise<void>,
  storeDirectory = PARENT_DIR,
) => {
  const dom = installHookTestDom();
  const previousSurface = window.__OPENCHAMBER_SURFACE__;
  window.__OPENCHAMBER_SURFACE__ = 'desktop';
  const mocks = [
    spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home' }),
    spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home'),
    spyOn(opencodeClient, 'getLocation').mockResolvedValue({
      directory: '/workspace',
      project: { id: 'project', directory: '/workspace', canonical: '/workspace' },
    }),
    spyOn(opencodeClient, 'getConfig').mockResolvedValue({}),
    spyOn(opencodeClient, 'listProjects').mockResolvedValue([]),
  ];
  const root = createRoot(dom.container);
  const capture: PendingCapture = { renders: 0, pending: null };
  const stores: StoresCapture = { parent: null };
  const Harness = () => {
    capture.renders += 1;
    stores.parent = useDirectoryStore(storeDirectory, { bootstrap: false });
    capture.pending = usePendingRequests(FAMILY);
    return null;
  };
  useGlobalSessionsStore.setState({
    entityById: new Map(entities.map((entity) => [entity.id, entity])),
  });
  try {
    await act(async () => root.render(
      <SyncProvider sdk={createSdk()} directory="">
        <Harness />
      </SyncProvider>,
    ));
    await assert(capture, stores);
  } finally {
    await act(async () => root.unmount());
    for (const mock of mocks) mock.mockRestore();
    window.__OPENCHAMBER_SURFACE__ = previousSurface;
    dom.restore();
    resetGlobalBlockingRequests();
  }
};

describe('usePendingRequests', () => {
  test('covers the whole family across directories, ignores other sessions, and clears on reply', async () => {
    await withHarness([
      session('parent', PARENT_DIR),
      session('child', CHILD_DIR),
      session('unrelated', PARENT_DIR),
    ], async (capture) => {
      expect(capture.pending).toEqual({ hasPermission: false, hasForm: false });

      // A request in an unrelated session neither shows nor re-renders the row.
      const idleRenders = capture.renders;
      await act(async () => applyGlobalBlockingRequestEvents(CHILD_DIR, [{
        type: 'permission.asked', properties: { id: 'p-other', sessionID: 'unrelated', action: 'bash', resources: [] },
      }]));
      expect(capture.renders).toBe(idleRenders);

      // A subagent's permission and the parent's question both land on the row,
      // even though the two sessions live in different directories.
      await act(async () => applyGlobalBlockingRequestEvents(CHILD_DIR, [
        { type: 'permission.asked', properties: { id: 'p1', sessionID: 'child', action: 'bash', resources: [] } },
        { type: 'form.created', properties: { form: { id: 'q1', sessionID: 'parent', title: 'Pick', fields: [{ key: 'answer', type: 'boolean' }] } } },
      ]));
      expect(capture.pending).toEqual({ hasPermission: true, hasForm: true });

      // A second request of the same kind changes nothing the row shows.
      const pendingRenders = capture.renders;
      await act(async () => applyGlobalBlockingRequestEvents(PARENT_DIR, [
        { type: 'permission.asked', properties: { id: 'p2', sessionID: 'parent', action: 'bash', resources: [] } },
      ]));
      expect(capture.renders).toBe(pendingRenders);

      await act(async () => applyGlobalBlockingRequestEvents(PARENT_DIR, [
        { type: 'permission.replied', properties: { sessionID: 'child', requestID: 'p1' } },
        { type: 'permission.replied', properties: { sessionID: 'parent', requestID: 'p2' } },
        { type: 'form.settled', properties: { sessionID: 'parent', formID: 'q1' } },
      ]));
      expect(capture.pending).toEqual({ hasPermission: false, hasForm: false });
    });
  });

  test('a session with no known directory still counts from the index', async () => {
    await withHarness([session('parent')], async (capture) => {
      await act(async () => applyGlobalBlockingRequestEvents('/elsewhere', [
        { type: 'permission.asked', properties: { id: 'p1', sessionID: 'parent', action: 'bash', resources: [] } },
      ]));
      // No store can answer for it, so the index is the only source.
      expect(capture.pending).toEqual({ hasPermission: true, hasForm: false });
    });
  });

  test('a directory containing a separator still resolves its own store', async () => {
    const pipedDirectory = '/repo|drafts';
    resetGlobalBlockingRequests();
    await withHarness([session('parent', pipedDirectory)], async (capture, stores) => {
      await act(async () => { await readHostBlockingRequestsSnapshot(async () => ({
        sessions: {},
        pending: { parent: { permissions: [], forms: [{ id: 'answered', sessionID: 'parent', title: 'Answer' }], pages: [] } },
        serverTime: 0,
      }), () => pipedDirectory) });
      expect(capture.pending).toEqual({ hasPermission: false, hasForm: true });

      await act(async () => stores.parent!.setState({ status: 'complete' }));
      expect(capture.pending).toEqual({ hasPermission: false, hasForm: false });
    }, pipedDirectory);
  });

  test('a bootstrapped directory outranks a form the index still holds', async () => {
    resetGlobalBlockingRequests();
    await withHarness([session('parent', PARENT_DIR)], async (capture, stores) => {
      await act(async () => { await readHostBlockingRequestsSnapshot(async () => ({
        sessions: {},
        pending: { parent: { permissions: [], forms: [{ id: 'answered', sessionID: 'parent', title: 'Answer' }], pages: [] } },
        serverTime: 0,
      }), () => PARENT_DIR) });
      expect(capture.pending).toEqual({ hasPermission: false, hasForm: true });

      // The directory's own bootstrap read its pending forms and found none.
      await act(async () => stores.parent!.setState({ status: 'complete' }));
      expect(capture.pending).toEqual({ hasPermission: false, hasForm: false });
    });
  });
});
