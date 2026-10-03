import { beforeEach, describe, expect, test } from 'bun:test';
import type { SyncEvent } from '@/lib/opencode/events';
import {
  applyGlobalBlockingRequestEvents,
  resetGlobalBlockingRequests,
  seedGlobalBlockingRequests,
  useGlobalBlockingRequestsStore,
  type BlockingFormRequest,
  type BlockingPermissionRequest,
} from './global-blocking-requests';

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
  test('tracks asks per session and settles them by request id', () => {
    applyGlobalBlockingRequestEvents('/far/', [permissionAsked(permission('p1', 's1')), formCreated(form('q1', 's1')), permissionAsked(permission('p2', 's2'))]);

    expect(bySession().get('s1')).toEqual({ directory: '/far', permissions: [permission('p1', 's1')], forms: [form('q1', 's1')] });
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

  test('seeding adds only sessions without live entries and never clears', () => {
    applyGlobalBlockingRequestEvents('/far', [permissionAsked(permission('p1', 's1'))]);
    applyGlobalBlockingRequestEvents('/far', [{ type: 'permission.replied', properties: { sessionID: 's1', requestID: 'p1' } }]);

    seedGlobalBlockingRequests([
      { sessionId: 's2', directory: '/other', permissions: [permission('p2', 's2')], forms: [] },
      { sessionId: 's3', directory: '/other', permissions: [], forms: [] },
    ]);
    expect([...bySession().keys()]).toEqual(['s2']);

    // A later seed cannot resurrect a settled request or override a live entry.
    seedGlobalBlockingRequests([{ sessionId: 's2', directory: '/elsewhere', permissions: [permission('p9', 's2')], forms: [] }]);
    expect(bySession().get('s2')?.permissions.map((p) => p.id)).toEqual(['p2']);
    seedGlobalBlockingRequests([]);
    expect(bySession().has('s2')).toBe(true);
  });
});
