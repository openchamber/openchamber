import { describe, expect, test } from 'bun:test';

import { createHiddenSessionRegistry } from './hidden-sessions.js';

describe('hidden sessions', () => {
  test('holds back the events of a registered session, from its creation on', () => {
    const hidden = createHiddenSessionRegistry();
    hidden.add('ses_dream');
    expect(hidden.isHiddenPayload({ type: 'session.created', data: { sessionID: 'ses_dream' } })).toBe(true);
    expect(hidden.isHiddenPayload({ type: 'message.part.delta', data: { sessionID: 'ses_dream', delta: 'x' } })).toBe(true);
    expect(hidden.isHiddenPayload({ type: 'session.updated', data: { info: { id: 'ses_dream' } } })).toBe(true);
    expect(hidden.isHiddenPayload({ type: 'session.created', data: { sessionID: 'ses_user' } })).toBe(false);
    expect(hidden.isHiddenPayload({ type: 'server.connected' })).toBe(false);
  });

  test('leaves registered sessions out of a list, in either list shape', () => {
    const hidden = createHiddenSessionRegistry();
    hidden.add('ses_dream');
    const sessions = [{ id: 'ses_dream' }, { id: 'ses_user' }];
    expect(hidden.filterSessionList({ data: sessions, cursor: null })).toEqual({ data: [{ id: 'ses_user' }], cursor: null });
    expect(hidden.filterSessionList(sessions)).toEqual([{ id: 'ses_user' }]);
  });

  test('hides a session marked hidden in a list, and its later events', () => {
    const hidden = createHiddenSessionRegistry();
    const sessions = [{ id: 'ses_plugin', metadata: { hidden: true } }, { id: 'ses_user', metadata: { openchamber: { kind: 'x' } } }];
    expect(hidden.filterSessionList({ data: sessions })).toEqual({ data: [sessions[1]] });
    expect(hidden.isHiddenPayload({ type: 'message.part.delta', data: { sessionID: 'ses_plugin' } })).toBe(true);
  });

  test('learns a hidden session from its creation event, so what follows is held back too', () => {
    const hidden = createHiddenSessionRegistry();
    expect(hidden.isHiddenPayload({ type: 'session.created', data: { sessionID: 'ses_new', metadata: { hidden: true } } })).toBe(true);
    expect(hidden.isHiddenPayload({ type: 'session.status', data: { sessionID: 'ses_new' } })).toBe(true);
    expect(hidden.isHiddenPayload({ type: 'session.created', data: { sessionID: 'ses_other', metadata: { hidden: false } } })).toBe(false);
  });

  test('learns hidden sessions that already exist from the session list', async () => {
    const hidden = createHiddenSessionRegistry();
    const pages = [
      { data: [{ id: 'ses_a', metadata: { hidden: true } }, { id: 'ses_b' }], cursor: { next: 'c2' } },
      { data: [{ id: 'ses_c', metadata: { hidden: true } }], cursor: { next: null } },
    ];
    await hidden.seed(async (cursor) => (cursor ? pages[1] : pages[0]));
    expect(hidden.has('ses_a')).toBe(true);
    expect(hidden.has('ses_c')).toBe(true);
    expect(hidden.has('ses_b')).toBe(false);
  });

  test('leaves registered sessions out of the running map', () => {
    const hidden = createHiddenSessionRegistry();
    hidden.add('ses_dream');
    expect(hidden.filterActive({ data: { ses_dream: { type: 'running' }, ses_user: { type: 'running' } } }))
      .toEqual({ data: { ses_user: { type: 'running' } } });
  });
});
