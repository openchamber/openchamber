import { beforeEach, describe, expect, test } from 'bun:test';
import { getSpaceMark, hasIsolatedSpaces, spaceMarkSchema, useSpacesStore, type SpaceMark } from './spaces-store';

const ID = 'a1b2c3d4e5f6';
const mark = (state: SpaceMark['state'] = 'complete'): SpaceMark => ({ id: ID, name: 'One', state, projectDirectory: '/home/me/app', directory: `/spaces/${ID}/app` });

describe('useSpacesStore', () => {
  beforeEach(() => useSpacesStore.getState().resetForRuntimeSwitch());

  test('holds the marks of the last complete list, and answers whether any space exists', () => {
    expect(hasIsolatedSpaces()).toBe(false);
    useSpacesStore.getState().applyMarks([mark()]);
    expect(hasIsolatedSpaces()).toBe(true);
    expect(getSpaceMark(ID)?.name).toBe('One');
    useSpacesStore.getState().applyMarks([]);
    expect(hasIsolatedSpaces()).toBe(false);
  });

  test('a lost stream marks the space stale; a stream back changes nothing until a read answers', () => {
    useSpacesStore.getState().applyMarks([mark()]);
    useSpacesStore.getState().noteStream(ID, 'disconnected');
    expect(getSpaceMark(ID)?.state).toBe('stale');
    useSpacesStore.getState().noteStream(ID, 'connected');
    expect(getSpaceMark(ID)?.state).toBe('stale');
    useSpacesStore.getState().noteReachable(ID);
    expect(getSpaceMark(ID)?.state).toBe('complete');
    // An unknown space is not invented by a stream announcement.
    useSpacesStore.getState().noteStream('0f0f0f0f0f0f', 'disconnected');
    expect(useSpacesStore.getState().spaces.size).toBe(1);
  });

  test('a runtime switch forgets every space', () => {
    useSpacesStore.getState().applyMarks([mark('partial')]);
    useSpacesStore.getState().resetForRuntimeSwitch();
    expect(hasIsolatedSpaces()).toBe(false);
  });

  test('parses the mark the host sends, with its optional fields defaulted', () => {
    expect(spaceMarkSchema.parse({ id: ID, state: 'unknown' })).toEqual({ id: ID, name: '', state: 'unknown', projectDirectory: null, directory: null });
    expect(spaceMarkSchema.safeParse({ id: 'short', state: 'complete' }).success).toBe(false);
    expect(spaceMarkSchema.safeParse({ id: ID, state: 'weird' }).success).toBe(false);
  });
});
