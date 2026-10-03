// The rules of the merged session list: what a space may claim in its list and in its events.

import { describe, expect, it } from 'vitest';

import {
  SPACE_DROP_CODES,
  createSpaceSessionIndex,
  filterSpaceSessionRecords,
  mergeSessionLists,
  spaceEventDropCode,
} from './space-sessions.js';

const ID = 'a1b2c3d4e5f6';
const OTHER = '0f0f0f0f0f0f';
const record = (id, directory, extra = {}) => ({ id, location: { directory }, title: id, ...extra });
const never = () => false;
const nobody = () => null;

describe('filterSpaceSessionRecords', () => {
  it.each([
    ['its own root', record('s1', `/spaces/${ID}/repo`), true],
    ['its own root, deeper', record('s2', `/spaces/${ID}/repo/src`), true],
    ['the root itself', record('s3', `/spaces/${ID}`), true],
    ['a path outside every space', record('s4', '/home/me/project'), false],
    ['another space', record('s5', `/spaces/${OTHER}/repo`), false],
    ['a climb out of its root', record('s6', `/spaces/${ID}/../${OTHER}/repo`), false],
    ['a sibling with the same prefix', record('s7', `/spaces/${ID}x/repo`), false],
    ['no directory at all', { id: 's8', title: 'no location' }, false],
    ['a directory that is not text', record('s9', 42), false],
    ['no id', { location: { directory: `/spaces/${ID}/repo` } }, false],
    ['not an object', 'text', false],
  ])('keeps a record only when its directory lies under the space\'s root: %s', (_name, entry, kept) => {
    const result = filterSpaceSessionRecords({ spaceId: ID, records: [entry], isHostSessionId: never, claimedBy: nobody });
    expect(result.records.map((item) => item.id)).toEqual(kept ? [entry.id] : []);
    if (!kept) expect(Object.values(result.dropped).reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it('never lets a space record overwrite a host session id, and logs it as a code', () => {
    const result = filterSpaceSessionRecords({
      spaceId: ID,
      records: [record('host-1', `/spaces/${ID}/repo`, { title: 'I am the host session now' }), record('mine', `/spaces/${ID}/repo`)],
      isHostSessionId: (id) => id === 'host-1',
      claimedBy: nobody,
    });
    expect(result.records.map((item) => item.id)).toEqual(['mine']);
    expect(result.dropped).toEqual({ [SPACE_DROP_CODES.hostId]: 1 });
  });

  it('drops a record whose id another space already listed, and a duplicate within the list', () => {
    const result = filterSpaceSessionRecords({
      spaceId: ID,
      records: [record('theirs', `/spaces/${ID}/repo`), record('mine', `/spaces/${ID}/repo`), record('mine', `/spaces/${ID}/repo`)],
      isHostSessionId: never,
      claimedBy: (id) => (id === 'theirs' ? OTHER : id === 'mine' ? ID : null),
    });
    expect(result.records.map((item) => item.id)).toEqual(['mine']);
    expect(result.dropped).toEqual({ [SPACE_DROP_CODES.claimed]: 1 });
  });

  it('keeps only the fields a session list may carry', () => {
    const result = filterSpaceSessionRecords({
      spaceId: ID,
      records: [record('s1', `/spaces/${ID}/repo`, { permissions: { edit: 'allow' }, revert: { messageID: 'm', files: ['x'] } })],
      isHostSessionId: never,
      claimedBy: nobody,
    });
    expect(result.records[0]).toEqual({ id: 's1', location: { directory: `/spaces/${ID}/repo` }, title: 's1', revert: { messageID: 'm' } });
  });
});

describe('spaceEventDropCode', () => {
  const event = (type, data, location) => {
    const payload = { type, data };
    if (location) payload.location = { directory: location };
    return payload;
  };
  it.each([
    ['an event of its own directory', event('session.created', { sessionID: 's1', location: { directory: `/spaces/${ID}/repo` } }, `/spaces/${ID}/repo`), null],
    ['an execution event with no location', event('session.execution.started', { sessionID: 's1' }), null],
    ['an event of another space', event('session.created', { sessionID: 's1' }, `/spaces/${OTHER}/repo`), SPACE_DROP_CODES.eventOutsideRoot],
    ['an event of a host directory', event('session.renamed', { sessionID: 's1' }, '/home/me/project'), SPACE_DROP_CODES.eventOutsideRoot],
    ['a created session that lands outside', event('session.created', { sessionID: 's1', location: { directory: '/home/me' } }, `/spaces/${ID}/repo`), SPACE_DROP_CODES.eventOutsideRoot],
    ['a moved session that lands outside', event('session.moved', { sessionID: 's1', location: { directory: `/spaces/${OTHER}` } }, `/spaces/${ID}/repo`), SPACE_DROP_CODES.eventOutsideRoot],
    ['an event that names a host session', event('session.execution.started', { sessionID: 'host-1' }), SPACE_DROP_CODES.eventHostSession],
    ['not an object', 'text', SPACE_DROP_CODES.malformed],
  ])('%s', (_name, payload, code) => {
    expect(spaceEventDropCode({ spaceId: ID, payload, isHostSessionId: (id) => id === 'host-1' })).toBe(code);
  });
});

describe('mergeSessionLists', () => {
  const host = { data: [record('h1', '/home/me')], cursor: { next: 'abc' } };
  it('returns the host payload untouched, the same object, when there is no space', () => {
    expect(mergeSessionLists(host, [])).toBe(host);
  });

  it('lists the host first, then each space, with a mark per space', () => {
    const merged = mergeSessionLists(host, [
      { spaceId: ID, state: 'complete', records: [record('s1', `/spaces/${ID}/repo`)], name: 'First', projectDirectory: '/home/me/repo', directory: `/spaces/${ID}/repo` },
      { spaceId: OTHER, state: 'stale', records: [record('s2', `/spaces/${OTHER}/repo`), record('s3', `/spaces/${OTHER}/repo`)] },
    ]);
    expect(merged.data.map((item) => item.id)).toEqual(['h1', 's1', 's2', 's3']);
    expect(merged.cursor).toEqual({ next: 'abc' });
    // A space whose project is not registered on this host is marked with no project and no directory.
    expect(merged.spaces).toEqual([
      { id: ID, name: 'First', state: 'complete', sessions: 1, projectDirectory: '/home/me/repo', directory: `/spaces/${ID}/repo` },
      { id: OTHER, name: '', state: 'stale', sessions: 2, projectDirectory: null, directory: null },
    ]);
  });
});

describe('createSpaceSessionIndex', () => {
  const quiet = { warn: () => {} };

  it('answers empty for a space that answered empty, and keeps the last list for one that did not answer', () => {
    const index = createSpaceSessionIndex({ logger: quiet });
    index.acceptSpaceList(ID, [record('s1', `/spaces/${ID}/repo`)], { complete: true });
    expect(index.snapshot()).toEqual([{ spaceId: ID, state: 'complete', records: [expect.objectContaining({ id: 's1' })] }]);
    index.markUnreachable(ID);
    expect(index.snapshot()).toEqual([{ spaceId: ID, state: 'stale', records: [expect.objectContaining({ id: 's1' })] }]);
    index.acceptSpaceList(ID, [], { complete: true });
    expect(index.snapshot()).toEqual([{ spaceId: ID, state: 'complete', records: [] }]);
    // A space that never answered is unknown, with nothing to show, and is not an empty answer.
    index.markUnreachable(OTHER);
    expect(index.snapshot()[1]).toEqual({ spaceId: OTHER, state: 'unknown', records: [] });
  });

  it('marks a list that had more pages than were read as partial', () => {
    const index = createSpaceSessionIndex({ logger: quiet });
    index.acceptSpaceList(ID, [record('s1', `/spaces/${ID}/repo`)], { complete: false });
    expect(index.snapshot()[0].state).toBe('partial');
  });

  it('learns the host\'s ids from its list and its events, and lets no space take them', () => {
    const logs = [];
    const index = createSpaceSessionIndex({ logger: { warn: (line) => logs.push(line) } });
    index.observeHostRecords([record('h1', '/home/me')]);
    index.observeHostEvent({ type: 'session.created', data: { sessionID: 'h2' } });
    const entry = index.acceptSpaceList(ID, [record('h1', `/spaces/${ID}/repo`, { title: 'stolen' }), record('h2', `/spaces/${ID}/repo`), record('s1', `/spaces/${ID}/repo`)], { complete: true });
    expect(entry.records.map((item) => item.id)).toEqual(['s1']);
    expect(index.acceptSpaceEvent(ID, { type: 'session.execution.started', data: { sessionID: 'h1' } })).toBe(false);
    expect(index.acceptSpaceEvent(ID, { type: 'session.execution.started', data: { sessionID: 's1' } })).toBe(true);
    expect(logs.join('\n')).toContain(SPACE_DROP_CODES.hostId);
    expect(logs.join('\n')).toContain(SPACE_DROP_CODES.eventHostSession);
    expect(logs.join('\n')).not.toContain('stolen');
  });

  it('claims a created session for the space that made it, and releases claims when the space is forgotten', () => {
    const index = createSpaceSessionIndex({ logger: quiet });
    expect(index.acceptSpaceEvent(ID, { type: 'session.created', data: { sessionID: 's1', location: { directory: `/spaces/${ID}/repo` } } })).toBe(true);
    expect(index.claimedBy('s1')).toBe(ID);
    expect(index.acceptSpaceEvent(OTHER, { type: 'session.created', data: { sessionID: 's1', location: { directory: `/spaces/${OTHER}/repo` } } })).toBe(false);
    // Nor may another space speak for it in any other event.
    expect(index.acceptSpaceEvent(OTHER, { type: 'session.execution.started', data: { sessionID: 's1' } })).toBe(false);
    expect(index.acceptSpaceEvent(ID, { type: 'session.execution.started', data: { sessionID: 's1' } })).toBe(true);
    expect(index.acceptSpaceList(OTHER, [record('s1', `/spaces/${OTHER}/repo`)], { complete: true }).records).toEqual([]);
    index.forget(ID);
    expect(index.claimedBy('s1')).toBeNull();
    expect(index.snapshot().map((entry) => entry.spaceId)).toEqual([OTHER]);
  });
});
