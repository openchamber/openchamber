import { describe, expect, test } from 'bun:test';

import { sessionEventResultSchema } from './service-provider-schemas.ts';
import {
  GUEST_SESSION_EVENT_TYPES,
  SESSION_EVENT_ERROR_MAX,
  isGuestSessionEventType,
  readSessionEventRequest,
  type GuestSessionEventRequest,
} from './session-events.ts';

describe('session events contract', () => {
  const request: GuestSessionEventRequest = {
    v: 1,
    requestId: 'req-1',
    event: {
      id: 'evt_1',
      type: 'turn-finished',
      at: 1_700_000_000_000,
      session: { id: 'ses_1', parentId: null },
      project: { directory: '/repo' },
      linked: [{ id: 'linear:OPE-367', kind: 'linear', provider: 'linear', identifier: 'OPE-367', url: 'https://linear.app/x/issue/OPE-367' }],
    },
  };
  const body = <T,>(patch?: T) => JSON.stringify({ ...request, ...patch });
  const event = <T,>(patch: T) => body({ event: { ...request.event, ...patch } });

  test('the four event types of v1', () => {
    expect(GUEST_SESSION_EVENT_TYPES).toEqual(['turn-finished', 'turn-failed', 'permission-asked', 'question-asked']);
    expect(isGuestSessionEventType('question-asked')).toBe(true);
    expect(isGuestSessionEventType('turn-aborted')).toBe(false);
  });

  test('reads the body OpenChamber posts, with or without content', () => {
    expect(readSessionEventRequest(body())).toEqual(request);
    const child = readSessionEventRequest(event({ session: { id: 'ses_2', parentId: 'ses_1' }, project: { directory: null } }));
    expect(child?.event.session).toEqual({ id: 'ses_2', parentId: 'ses_1' });
    expect(child?.event.project).toEqual({ directory: null });
    const permission = readSessionEventRequest(event({ type: 'permission-asked', permission: { requestId: 'perm_1' } }));
    expect(permission?.event.permission).toEqual({ requestId: 'perm_1' });
    const withContent = readSessionEventRequest(body({
      content: { type: 'turn-finished', sessionTitle: 'Fix the parser', reply: 'Done.', replyTruncated: false },
    }));
    expect(withContent?.content).toEqual({ type: 'turn-finished', sessionTitle: 'Fix the parser', reply: 'Done.', replyTruncated: false });
  });

  test('refuses anything that is not a session event of this wire version', () => {
    expect(readSessionEventRequest('not json')).toBeNull();
    expect(readSessionEventRequest('[]')).toBeNull();
    expect(readSessionEventRequest(body({ v: 2 }))).toBeNull();
    expect(readSessionEventRequest(body({ requestId: '' }))).toBeNull();
    expect(readSessionEventRequest(body({ event: null }))).toBeNull();
    expect(readSessionEventRequest(event({ type: 'turn-aborted' }))).toBeNull();
    expect(readSessionEventRequest(event({ id: '' }))).toBeNull();
    expect(readSessionEventRequest(event({ at: 'now' }))).toBeNull();
    expect(readSessionEventRequest(event({ session: { id: '' , parentId: null } }))).toBeNull();
    expect(readSessionEventRequest(event({ session: { id: 'ses_1', parentId: 7 } }))).toBeNull();
    expect(readSessionEventRequest(event({ project: { directory: 7 } }))).toBeNull();
    expect(readSessionEventRequest(event({ linked: 'none' }))).toBeNull();
    expect(readSessionEventRequest(event({ permission: { requestId: '' } }))).toBeNull();
    // Content of another type than the event is a malformed body, not a surprise for the handler.
    expect(readSessionEventRequest(body({ content: { type: 'turn-failed', sessionTitle: null, error: { type: 'x', message: 'y' } } }))).toBeNull();
    expect(readSessionEventRequest(body({ content: 'Done.' }))).toBeNull();
  });

  test('the host accepts { ok: true } and { ok: false, error } answers only', () => {
    expect(sessionEventResultSchema.safeParse({ ok: true }).success).toBe(true);
    expect(sessionEventResultSchema.safeParse({ ok: false, error: 'Slack refused the message' }).success).toBe(true);
    expect(sessionEventResultSchema.safeParse({ ok: true, data: {} }).success).toBe(false);
    expect(sessionEventResultSchema.safeParse({ ok: false }).success).toBe(false);
    expect(sessionEventResultSchema.safeParse({ ok: false, error: '' }).success).toBe(false);
    expect(sessionEventResultSchema.safeParse({ ok: false, error: 'x'.repeat(SESSION_EVENT_ERROR_MAX + 1) }).success).toBe(false);
    expect(sessionEventResultSchema.safeParse(null).success).toBe(false);
  });
});
