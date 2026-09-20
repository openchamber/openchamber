import { beforeEach, describe, expect, test } from 'bun:test';
import type { Event } from '@opencode-ai/sdk/v2/client';
import {
  applyGlobalBlockingRequestEvents,
  resetGlobalBlockingRequests,
  seedGlobalBlockingRequests,
  useGlobalBlockingRequestsStore,
} from './global-blocking-requests';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';

const permission = (id: string, sessionID: string): PermissionRequest => ({
  id, sessionID, permission: 'bash', patterns: ['rm *'], metadata: {}, always: [],
});
const question = (id: string, sessionID: string): QuestionRequest => ({
  id, sessionID, questions: [{ header: 'Pick', question: 'Which?', options: [] }],
});
const asked = (request: PermissionRequest | QuestionRequest): Event => ({
  id: `e-${request.id}`,
  type: 'permission' in request ? 'permission.asked' : 'question.asked',
  // SAFETY: test payloads mirror the SDK ask event shape.
  properties: request as never,
});
const bySession = () => useGlobalBlockingRequestsStore.getState().bySession;

beforeEach(() => resetGlobalBlockingRequests());

describe('global blocking requests index', () => {
  test('tracks asks per session and settles them by request id', () => {
    applyGlobalBlockingRequestEvents('/far/', [asked(permission('p1', 's1')), asked(question('q1', 's1')), asked(permission('p2', 's2'))]);

    expect(bySession().get('s1')).toEqual({ directory: '/far', permissions: [permission('p1', 's1')], questions: [question('q1', 's1')] });
    expect(bySession().get('s2')?.permissions.map((p) => p.id)).toEqual(['p2']);

    applyGlobalBlockingRequestEvents('/far', [
      { id: 'r1', type: 'permission.replied', properties: { sessionID: 's1', requestID: 'p1', reply: 'once' } },
      { id: 'r2', type: 'question.rejected', properties: { sessionID: 's1', requestID: 'q1' } },
    ]);
    expect(bySession().has('s1')).toBe(false);
    expect(bySession().has('s2')).toBe(true);
  });

  test('a reply without a request id settles that kind for the session, and deletion clears it', () => {
    applyGlobalBlockingRequestEvents('/far', [asked(permission('p1', 's1')), asked(permission('p2', 's1')), asked(question('q1', 's1'))]);
    // SAFETY: OpenCode may omit requestID on a reply; the SDK type requires it, the reducer contract does not.
    applyGlobalBlockingRequestEvents('/far', [{ id: 'r', type: 'permission.replied', properties: { sessionID: 's1', reply: 'once' } as never }]);
    expect(bySession().get('s1')?.permissions).toEqual([]);
    expect(bySession().get('s1')?.questions.map((q) => q.id)).toEqual(['q1']);

    // SAFETY: only the deleted session's id matters here; the full SDK session record is irrelevant to the index.
    applyGlobalBlockingRequestEvents('/far', [{ id: 'd', type: 'session.deleted', properties: { info: { id: 's1' } } as never }]);
    expect(bySession().has('s1')).toBe(false);
  });

  test('repeated and unrelated events do not publish', () => {
    applyGlobalBlockingRequestEvents('/far', [asked(permission('p1', 's1'))]);
    const before = bySession();
    applyGlobalBlockingRequestEvents('/far', [
      { id: 'x', type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
      { id: 'y', type: 'permission.replied', properties: { sessionID: 'other', requestID: 'nope', reply: 'once' } },
    ]);
    expect(bySession()).toBe(before);
  });

  test('seeding adds only sessions without live entries and never clears', () => {
    applyGlobalBlockingRequestEvents('/far', [asked(permission('p1', 's1'))]);
    applyGlobalBlockingRequestEvents('/far', [{ id: 'r', type: 'permission.replied', properties: { sessionID: 's1', requestID: 'p1', reply: 'once' } }]);

    seedGlobalBlockingRequests([
      { sessionId: 's2', directory: '/other', permissions: [permission('p2', 's2')], questions: [] },
      { sessionId: 's3', directory: '/other', permissions: [], questions: [] },
    ]);
    expect([...bySession().keys()]).toEqual(['s2']);

    // A later seed cannot resurrect a settled request or override a live entry.
    seedGlobalBlockingRequests([{ sessionId: 's2', directory: '/elsewhere', permissions: [permission('p9', 's2')], questions: [] }]);
    expect(bySession().get('s2')?.permissions.map((p) => p.id)).toEqual(['p2']);
    seedGlobalBlockingRequests([]);
    expect(bySession().has('s2')).toBe(true);
  });
});
