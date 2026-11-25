import { describe, expect, jest, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { opencodeClient } from '@/lib/opencode/client';
import type { FormRequest, PermissionRequest, Session } from '@/lib/opencode/model';
import type { SessionNode } from '@/components/session/sidebar/types';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { applyGlobalBlockingRequestEvents, readHostBlockingRequestsSnapshot, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { createEventRoutingIndex, reconcileActivityAfterGap, SyncProvider, useChildStoreManager, useDirectoryStore } from '@/sync/sync-context';
import { resyncDirectoryAfterReconnect } from '@/sync/session-reconnect-recovery';
import { useConfigStore } from '@/stores/useConfigStore';
import { usePendingRequests, type PendingRequests } from './usePendingRequests';

const CURRENT_DIR = '/workspace';
const PARENT_DIR = '/repo';
const CHILD_DIR = '/worktrees/feature';

const createSdk = (stream = () => new ReadableStream<Uint8Array>()) => OpenCode.make({
  baseUrl: 'https://pending.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(stream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/location')
      ? { directory: CURRENT_DIR, project: { id: 'project', directory: CURRENT_DIR, canonical: CURRENT_DIR } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

// SAFETY: the scope lookup reads only the id, parent and directory, which the fixture sets.
const session = (id: string, directory: string, parentID?: string): Session => ({ id, title: id, directory, parentID } as Session);

/** A parent row in the repo with one subagent in a worktree, as the phone's list builds it. */
const FAMILY: SessionNode = {
  session: session('parent', PARENT_DIR),
  children: [{ session: session('child', CHILD_DIR, 'parent'), children: [], worktree: null }],
  worktree: null,
};

const permission = (id: string, sessionID: string): PermissionRequest => ({ id, sessionID, action: 'bash', resources: [] });

type Capture = {
  renders: number;
  pending: PendingRequests | null;
  parent: ReturnType<typeof useDirectoryStore> | null;
  child: ReturnType<typeof useDirectoryStore> | null;
  childStores: ReturnType<typeof useChildStoreManager> | null;
};

const Harness: React.FC<{ capture: Capture; expanded: boolean; showSubagentSessions: boolean }> = ({ capture, expanded, showSubagentSessions }) => {
  capture.renders += 1;
  capture.parent = useDirectoryStore(PARENT_DIR, { bootstrap: false });
  capture.child = useDirectoryStore(CHILD_DIR, { bootstrap: false });
  capture.childStores = useChildStoreManager();
  capture.pending = usePendingRequests(FAMILY, expanded, showSubagentSessions, null);
  return null;
};

const withRow = async (expanded: boolean, assert: (capture: Capture, setMounted: (mounted: boolean) => Promise<void>) => Promise<void>, showSubagentSessions = true, stream?: () => ReadableStream<Uint8Array>) => {
  const dom = installHookTestDom();
  const previousSurface = window.__OPENCHAMBER_SURFACE__;
  window.__OPENCHAMBER_SURFACE__ = 'desktop';
  const mocks = [
    spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home' }),
    spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home'),
    spyOn(opencodeClient, 'getLocation').mockResolvedValue({
      directory: CURRENT_DIR,
      project: { id: 'project', directory: CURRENT_DIR, canonical: CURRENT_DIR },
    }),
    spyOn(opencodeClient, 'getConfig').mockResolvedValue({}),
    spyOn(opencodeClient, 'listProjects').mockResolvedValue([]),
  ];
  const root = createRoot(dom.container);
  const capture: Capture = { renders: 0, pending: null, parent: null, child: null, childStores: null };
  resetGlobalBlockingRequests();
  try {
    const sdk = createSdk(stream);
    const setMounted = (mounted: boolean) => act(async () => root.render(
      <SyncProvider sdk={sdk} directory="">
        {mounted ? <Harness capture={capture} expanded={expanded} showSubagentSessions={showSubagentSessions} /> : null}
      </SyncProvider>,
    ));
    await setMounted(!stream);
    await assert(capture, setMounted);
  } finally {
    await act(async () => root.unmount());
    for (const mock of mocks) mock.mockRestore();
    window.__OPENCHAMBER_SURFACE__ = previousSurface;
    dom.restore();
    resetGlobalBlockingRequests();
  }
};

describe('usePendingRequests', () => {
  test('a folded row counts its subsession in another directory, and an unrelated session changes nothing', async () => {
    await withRow(false, async (capture) => {
      expect(capture.pending).toEqual({ hasPermission: false, hasForm: false });

      const idleRenders = capture.renders;
      await act(async () => applyGlobalBlockingRequestEvents(CHILD_DIR, [{ type: 'permission.asked', properties: permission('p-other', 'unrelated') }]));
      expect(capture.renders).toBe(idleRenders);

      await act(async () => capture.child!.setState({ permission: { child: [permission('p1', 'child')] } }));
      expect(capture.pending).toEqual({ hasPermission: true, hasForm: false });
    });
  });

  test('an unfolded row counts only its own requests', async () => {
    await withRow(true, async (capture) => {
      await act(async () => capture.child!.setState({ permission: { child: [permission('p1', 'child')] } }));
      expect(capture.pending?.hasPermission).toBe(false);

      await act(async () => capture.parent!.setState({ permission: { parent: [permission('p2', 'parent')] } }));
      expect(capture.pending?.hasPermission).toBe(true);
    });
  });

  test('an unfolded row still counts a subagent the list hides', async () => {
    await withRow(true, async (capture) => {
      await act(async () => capture.child!.setState({ permission: { child: [permission('p1', 'child')] } }));
      expect(capture.pending?.hasPermission).toBe(true);
    }, false);
  });

  test('a directory that has not loaded yet shows what the cross-directory index holds', async () => {
    await withRow(false, async (capture) => {
      // A project this phone never opened: only the index knows about the request.
      await act(async () => applyGlobalBlockingRequestEvents(CHILD_DIR, [{ type: 'permission.asked', properties: permission('p1', 'child') }]));
      expect(capture.child!.getState().permission.child).toBeUndefined();
      expect(capture.pending?.hasPermission).toBe(true);
    });
  });

  test('a request settled during a stream gap clears once the directory store re-reads it (#6802)', async () => {
    await withRow(false, async (capture) => {
      await act(async () => applyGlobalBlockingRequestEvents(PARENT_DIR, [
        { type: 'permission.asked', properties: permission('p1', 'parent') },
        { type: 'form.created', properties: { form: { id: 'q1', sessionID: 'child', title: 'Pick', fields: [{ key: 'answer', type: 'boolean' }] } } },
      ]));
      expect(capture.pending).toEqual({ hasPermission: true, hasForm: true });

      // Both were answered on another client and neither settlement arrived; the
      // reconnect bootstrap read both directories and found nothing pending.
      await act(async () => {
        capture.parent!.setState({ status: 'complete', session: [FAMILY.session], requestCoverage: new Set(['parent']) });
        capture.child!.setState({ status: 'complete', session: [session('child', CHILD_DIR, 'parent')], requestCoverage: new Set(['child']) });
      });
      expect(capture.pending).toEqual({ hasPermission: false, hasForm: false });

      // A request the loaded store holds still shows.
      await act(async () => capture.parent!.setState({ permission: { parent: [permission('p2', 'parent')] } }));
      expect(capture.pending).toEqual({ hasPermission: true, hasForm: false });
    });
  });

  const pendingForm: FormRequest = { id: 'q1', sessionID: 'child', title: 'Pick', fields: [{ key: 'answer', type: 'boolean' }] };
  const reconnect = (capture: Capture) => act(async () => {
    const routing = createEventRoutingIndex();
    for (const [directory, store] of [[PARENT_DIR, capture.parent!], [CHILD_DIR, capture.child!]] as const) {
      await resyncDirectoryAfterReconnect(directory, store, routing, 'stream-reconnect', () => false);
    }
  });

  for (const status of ['loading', 'complete'] as const) {
    test(`an ordinary reconnect re-reads a row whose only live state is a pending request (${status} store)`, async () => {
      const permissions = spyOn(opencodeClient, 'listPendingPermissions').mockRejectedValue(new Error('offline'));
      const forms = spyOn(opencodeClient, 'listPendingForms').mockRejectedValue(new Error('offline'));
      try {
        await withRow(false, async (capture) => {
          await act(async () => {
            applyGlobalBlockingRequestEvents(PARENT_DIR, [{ type: 'permission.asked', properties: permission('p1', 'parent') }]);
            applyGlobalBlockingRequestEvents(CHILD_DIR, [{ type: 'form.created', properties: { form: pendingForm } }]);
            capture.parent!.setState({ status, session: [FAMILY.session], permission: { parent: [permission('p1', 'parent')] } });
            capture.child!.setState({ status, session: [session('child', CHILD_DIR, 'parent')], form: { child: [pendingForm] } });
          });
          await reconnect(capture);
          expect(capture.pending).toEqual({ hasPermission: true, hasForm: true });

          permissions.mockResolvedValue([]);
          forms.mockResolvedValue([]);
          await reconnect(capture);
          expect(capture.pending).toEqual({ hasPermission: false, hasForm: false });
        });
      } finally {
        permissions.mockRestore();
        forms.mockRestore();
      }
    });
  }

  test('a request the host seed found in a project never opened clears on reconnect', async () => {
    const permissions = spyOn(opencodeClient, 'listPendingPermissions').mockResolvedValue([]);
    const forms = spyOn(opencodeClient, 'listPendingForms').mockResolvedValue([]);
    try {
      await withRow(false, async (capture) => {
        await act(async () => { await readHostBlockingRequestsSnapshot(async () => ({
          sessions: {},
          pending: { child: { permissions: [permission('p1', 'child')], forms: [], pages: [] } },
          serverTime: 0,
        }), () => CHILD_DIR); });
        expect(capture.pending?.hasPermission).toBe(true);
        await reconnect(capture);
        expect(capture.pending?.hasPermission).toBe(false);
        expect(permissions.mock.calls).toEqual([[{ directories: [CHILD_DIR] }]]);

        // A host that missed the settlement still lists it, beside a new request.
        const seed = (ids: string[]) => act(async () => { await readHostBlockingRequestsSnapshot(async () => ({
          sessions: {},
          pending: { child: { permissions: ids.map((id) => permission(id, 'child')), forms: [], pages: [] } },
          serverTime: 0,
        }), () => CHILD_DIR); });
        await seed(['p1']);
        expect(capture.pending?.hasPermission).toBe(false);
        await seed(['p1', 'p2']);
        expect(capture.pending?.hasPermission).toBe(true);
        await act(async () => applyGlobalBlockingRequestEvents(CHILD_DIR, [
          { type: 'permission.replied', properties: { sessionID: 'child', requestID: 'p2' } },
        ]));
        expect(capture.pending?.hasPermission).toBe(false);
      });
    } finally {
      permissions.mockRestore();
      forms.mockRestore();
    }
  });

  test('a reconnect settles a request of a project whose rows mount only afterwards', async () => {
    const permissions = spyOn(opencodeClient, 'listPendingPermissions').mockResolvedValue([]);
    const forms = spyOn(opencodeClient, 'listPendingForms').mockResolvedValue([]);
    const previousTransport = useConfigStore.getState().settingsMessageStreamTransport;
    useConfigStore.setState({ settingsMessageStreamTransport: 'sse' });
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const openStream = () => new ReadableStream<Uint8Array>({
      start: (controller) => {
        streams.push(controller);
        controller.enqueue(new TextEncoder().encode('data: {"id":"evt","type":"server.connected","data":{}}\n\n'));
      },
    });
    const until = async (done: () => boolean) => {
      for (let tick = 0; tick < 100 && !done(); tick += 1) await act(async () => {
        jest.advanceTimersByTime(10);
        for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      });
      expect(done()).toBe(true);
    };
    jest.useFakeTimers();
    const realNow = Date.now;
    const clock = spyOn(Date, 'now');
    try {
      await withRow(false, async (capture, setMounted) => {
        await until(() => streams.length === 1 && useConfigStore.getState().isConnected);
        await act(async () => applyGlobalBlockingRequestEvents(CHILD_DIR, [{ type: 'permission.asked', properties: permission('p1', 'child') }]));
        expect(capture.renders).toBe(0);
        // Past the window in which a reconnect counts as part of startup.
        clock.mockImplementation(() => realNow() + 10_000);
        streams[0].close();
        await until(() => permissions.mock.calls.length > 0);
        await setMounted(true);
        expect(capture.pending?.hasPermission).toBe(false);
        expect(capture.child!.getState().status).toBe('loading');
        expect(permissions.mock.calls).toEqual([[{ directories: [CHILD_DIR] }]]);
      }, true, openStream);
    } finally {
      jest.useRealTimers();
      clock.mockRestore();
      useConfigStore.setState({ settingsMessageStreamTransport: previousTransport });
      permissions.mockRestore();
      forms.mockRestore();
    }
  });

  test('a loaded inactive project shows a seeded request of a session it never saw, and keeps a settled one cleared', async () => {
    await withRow(false, async (capture) => {
      await act(async () => {
        capture.parent!.setState({ status: 'complete', session: [FAMILY.session], requestCoverage: new Set(['parent']) });
        capture.child!.setState({ status: 'complete', session: [session('other', CHILD_DIR)], requestCoverage: new Set(['other']) });
      });
      await act(async () => { await readHostBlockingRequestsSnapshot(async () => ({
        sessions: {},
        pending: {
          parent: { permissions: [], forms: [{ id: 'answered', sessionID: 'parent', title: 'Pick' }], pages: [] },
          child: { permissions: [permission('p1', 'child')], forms: [], pages: [] },
        },
        serverTime: 0,
      }), (sessionId) => (sessionId === 'parent' ? PARENT_DIR : CHILD_DIR)); });
      expect(capture.pending).toEqual({ hasPermission: true, hasForm: false });

      // Joining the list reads no requests, so the unanswered one stays.
      await act(async () => capture.child!.setState({ session: [session('other', CHILD_DIR), session('child', CHILD_DIR, 'parent')] }));
      await act(async () => applyGlobalBlockingRequestEvents(CHILD_DIR, [{ type: 'permission.asked', properties: permission('p-other', 'unrelated') }]));
      expect(capture.pending).toEqual({ hasPermission: true, hasForm: false });

      await act(async () => applyGlobalBlockingRequestEvents(CHILD_DIR, [
        { type: 'permission.replied', properties: { sessionID: 'child', requestID: 'p1' } },
      ]));
      expect(capture.pending?.hasPermission).toBe(false);
    });
  });

  test('a known idle session that asked during the gap shows without opening its project', async () => {
    const active = spyOn(opencodeClient, 'getActiveSessionStatuses').mockResolvedValue({ child: { type: 'busy' } });
    const permissions = spyOn(opencodeClient, 'listPendingPermissions').mockResolvedValue([permission('p1', 'child')]);
    const forms = spyOn(opencodeClient, 'listPendingForms').mockResolvedValue([]);
    try {
      await withRow(false, async (capture) => {
        await act(async () => {
          capture.parent!.setState({ status: 'complete', session: [FAMILY.session], requestCoverage: new Set(['parent']) });
          capture.child!.setState({ status: 'complete', session: [session('child', CHILD_DIR, 'parent')], requestCoverage: new Set(['child']) });
        });
        await act(async () => reconcileActivityAfterGap(capture.childStores!));
        expect(capture.pending?.hasPermission).toBe(true);
        expect(permissions.mock.calls).toEqual([[{ directories: [CHILD_DIR] }]]);
      });
    } finally {
      active.mockRestore();
      permissions.mockRestore();
      forms.mockRestore();
    }
  });
});
