import { beforeEach, describe, expect, test } from 'bun:test';
import type { SyncEvent } from '@/lib/opencode/events';
import {
  applyGlobalBlockingRequestEvents,
  applyWaitingPageEvent,
  resetGlobalBlockingRequests,
  readHostBlockingRequestsSnapshot,
  useGlobalBlockingRequestsStore,
  type BlockingFormRequest,
  type BlockingPermissionRequest,
} from './global-blocking-requests';
import type { HostSessionStatusSnapshot } from '@/lib/opencode/session-status';

/** A host status read whose pending map is `pending`, as the poller and mobile sheet receive it. */
const hostSnapshot = (pending: NonNullable<HostSessionStatusSnapshot['pending']>) =>
  async (): Promise<HostSessionStatusSnapshot> => ({ sessions: {}, pending, serverTime: 0 });

const permission = (id: string, sessionID: string): BlockingPermissionRequest => ({
  id, sessionID, action: 'bash', resources: ['rm *'],
});
const form = (id: string, sessionID: string): BlockingFormRequest => ({ id, sessionID, title: 'Pick one' });
const permissionAsked = (request: BlockingPermissionRequest): SyncEvent => ({ type: 'permission.asked', properties: request });
const formCreated = (request: BlockingFormRequest): SyncEvent => ({
  type: 'form.created',
  properties: { form: { ...request, fields: [{ key: 'answer', type: 'boolean' }] } },
});
const bySession = () => useGlobalBlockingRequestsStore.getState().bySession;

beforeEach(() => resetGlobalBlockingRequests());

describe('global blocking requests index', () => {
  test('keeps a waiting page beside the session\'s forms until the server says it stopped waiting', () => {
    const noDirectory = () => null;
    applyGlobalBlockingRequestEvents('/far', [formCreated(form('q1', 's1'))]);
    applyWaitingPageEvent({ type: 'openchamber.page-waiting', properties: { sessionID: 's1', directory: '/far/', page: { id: 'call_1', title: 'Pick a layout' } } }, noDirectory);

    expect(bySession().get('s1')).toEqual({ directory: '/far', permissions: [], forms: [form('q1', 's1')], pages: [{ id: 'call_1', sessionID: 's1', title: 'Pick a layout' }] });

    // Settling the form leaves the page; settling the page empties the session.
    applyGlobalBlockingRequestEvents('/far', [{ type: 'form.settled', properties: { sessionID: 's1', formID: 'q1' } }]);
    expect(bySession().get('s1')?.pages.map((page) => page.id)).toEqual(['call_1']);
    applyWaitingPageEvent({ type: 'openchamber.page-settled', properties: { sessionID: 's1', pageID: 'call_1' } }, noDirectory);
    expect(bySession().has('s1')).toBe(false);
  });

  test('places a waiting page by its session when the server names no directory, and skips one it cannot place', () => {
    const page = (sessionID: string) => ({ type: 'openchamber.page-waiting' as const, properties: { sessionID, directory: null, page: { id: 'call_1', title: 'Pick' } } });
    applyWaitingPageEvent(page('s1'), (sessionId) => (sessionId === 's1' ? '/known' : null));
    applyWaitingPageEvent(page('s2'), () => null);

    expect(bySession().get('s1')?.directory).toBe('/known');
    expect(bySession().has('s2')).toBe(false);
  });

  test('seeds waiting pages from the host', async () => {
    await readHostBlockingRequestsSnapshot(hostSnapshot({ s1: { permissions: [], forms: [], pages: [{ id: 'call_1', sessionID: 's1', title: 'Pick' }] } }), () => '/other');
    expect(bySession().get('s1')?.pages.map((page) => page.id)).toEqual(['call_1']);
  });

  test('tracks asks per session and settles them by request id', () => {
    applyGlobalBlockingRequestEvents('/far/', [permissionAsked(permission('p1', 's1')), formCreated(form('q1', 's1')), permissionAsked(permission('p2', 's2'))]);

    expect(bySession().get('s1')).toEqual({ directory: '/far', permissions: [permission('p1', 's1')], forms: [form('q1', 's1')], pages: [] });
    expect(bySession().get('s2')?.permissions.map((p) => p.id)).toEqual(['p2']);

    applyGlobalBlockingRequestEvents('/far', [
      { type: 'permission.replied', properties: { sessionID: 's1', requestID: 'p1' } },
      { type: 'form.settled', properties: { sessionID: 's1', formID: 'q1' } },
    ]);
    expect(bySession().has('s1')).toBe(false);
    expect(bySession().has('s2')).toBe(true);
  });

  test('a reply without a request id settles that kind for the session, and deletion clears it', () => {
    applyGlobalBlockingRequestEvents('/far', [permissionAsked(permission('p1', 's1')), permissionAsked(permission('p2', 's1')), formCreated(form('q1', 's1'))]);
    // OpenCode may omit the request id on a reply; the reducer then settles the whole kind.
    applyGlobalBlockingRequestEvents('/far', [{ type: 'permission.replied', properties: { sessionID: 's1', requestID: '' } }]);
    expect(bySession().get('s1')?.permissions).toEqual([]);
    expect(bySession().get('s1')?.forms.map((q) => q.id)).toEqual(['q1']);

    applyGlobalBlockingRequestEvents('/far', [{ type: 'session.deleted', properties: { sessionID: 's1' } }]);
    expect(bySession().has('s1')).toBe(false);
  });

  // The tray decides whether to offer "Allow always" from this flag, so an ask
  // that carries save patterns must keep them across the index (#4698).
  test('carries the save patterns an ask arrives with, and omits them when it has none', () => {
    const savable: BlockingPermissionRequest = { id: 'p1', sessionID: 's1', action: 'bash', resources: ['git *'], save: ['git *'] };
    const oneOff: BlockingPermissionRequest = { id: 'p2', sessionID: 's2', action: 'bash', resources: ['rm *'] };
    applyGlobalBlockingRequestEvents('/far', [permissionAsked(savable), permissionAsked(oneOff)]);

    expect(bySession().get('s1')?.permissions[0]?.save).toEqual(['git *']);
    expect(bySession().get('s2')?.permissions[0]?.save).toBeUndefined();
  });

  test('repeated and unrelated events do not publish', () => {
    applyGlobalBlockingRequestEvents('/far', [permissionAsked(permission('p1', 's1'))]);
    const before = bySession();
    applyGlobalBlockingRequestEvents('/far', [
      { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
      { type: 'permission.replied', properties: { sessionID: 'other', requestID: 'nope' } },
    ]);
    expect(bySession()).toBe(before);

    // OpenCode re-sends an unanswered ask; an identical repeat is a no-op.
    applyGlobalBlockingRequestEvents('/far', [permissionAsked(permission('p1', 's1')), formCreated(form('q1', 's1'))]);
    const withForm = bySession();
    applyGlobalBlockingRequestEvents('/far', [permissionAsked(permission('p1', 's1')), formCreated(form('q1', 's1'))]);
    expect(bySession()).toBe(withForm);
  });

  test('seeding adds only sessions without live entries and never clears', async () => {
    applyGlobalBlockingRequestEvents('/far', [permissionAsked(permission('p1', 's1'))]);
    applyGlobalBlockingRequestEvents('/far', [{ type: 'permission.replied', properties: { sessionID: 's1', requestID: 'p1' } }]);

    await readHostBlockingRequestsSnapshot(hostSnapshot({
      s2: { permissions: [permission('p2', 's2')], forms: [], pages: [] },
      s3: { permissions: [], forms: [], pages: [] },
    }), () => '/other');
    expect([...bySession().keys()]).toEqual(['s2']);

    // A later seed cannot resurrect a settled request or override a live entry.
    await readHostBlockingRequestsSnapshot(hostSnapshot({ s2: { permissions: [permission('p9', 's2')], forms: [], pages: [] } }), () => '/elsewhere');
    expect(bySession().get('s2')?.permissions.map((p) => p.id)).toEqual(['p2']);
    await readHostBlockingRequestsSnapshot(hostSnapshot({}), () => '/other');
    expect(bySession().has('s2')).toBe(true);
  });
});
