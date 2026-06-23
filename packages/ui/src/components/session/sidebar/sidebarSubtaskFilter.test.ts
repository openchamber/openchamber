import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { getParentSessionId, isSubtaskSession, isTopLevelSession } from './utils';

const makeSession = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 'session-id',
    slug: 'session-slug',
    projectID: 'project-id',
    directory: '/workspace',
    title: 'Test session',
    version: '1',
    time: { created: 0, updated: 0 },
    ...overrides,
  }) as Session;

describe('isSubtaskSession', () => {
  test('returns false when parentID is absent', () => {
    expect(isSubtaskSession(makeSession())).toBe(false);
  });

  test('returns false when parentID is undefined', () => {
    expect(isSubtaskSession(makeSession({ parentID: undefined } as Partial<Session>))).toBe(false);
  });

  test('returns false when parentID is null', () => {
    expect(isSubtaskSession(makeSession({ parentID: null } as unknown as Partial<Session>))).toBe(false);
  });

  test('returns false when parentID is empty string', () => {
    expect(isSubtaskSession(makeSession({ parentID: '' } as unknown as Partial<Session>))).toBe(false);
  });

  test('returns false when parentID is whitespace only', () => {
    expect(isSubtaskSession(makeSession({ parentID: '   ' } as unknown as Partial<Session>))).toBe(false);
  });

  test('returns true when parentID is a non-empty string', () => {
    expect(isSubtaskSession(makeSession({ parentID: 'parent-id' } as unknown as Partial<Session>))).toBe(true);
  });
});

describe('getParentSessionId', () => {
  test('returns null when parentID is absent', () => {
    expect(getParentSessionId(makeSession())).toBeNull();
  });

  test('returns null when parentID is empty or whitespace', () => {
    expect(getParentSessionId(makeSession({ parentID: '' } as unknown as Partial<Session>))).toBeNull();
    expect(getParentSessionId(makeSession({ parentID: '   ' } as unknown as Partial<Session>))).toBeNull();
  });

  test('returns the trimmed parentID when present', () => {
    expect(getParentSessionId(makeSession({ parentID: '  parent-id  ' } as unknown as Partial<Session>))).toBe('parent-id');
    expect(getParentSessionId(makeSession({ parentID: 'parent-id' } as unknown as Partial<Session>))).toBe('parent-id');
  });
});

describe('isTopLevelSession', () => {
  test('returns true when parentID is absent or empty', () => {
    expect(isTopLevelSession(makeSession())).toBe(true);
    expect(isTopLevelSession(makeSession({ parentID: '' } as unknown as Partial<Session>))).toBe(true);
  });

  test('returns false when parentID is a non-empty string', () => {
    expect(isTopLevelSession(makeSession({ parentID: 'parent-id' } as unknown as Partial<Session>))).toBe(false);
  });
});
