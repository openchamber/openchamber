import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  buildAuthoritativeSessionIdentityMap,
  findRemovedAuthoritativeSessions,
} from '../authoritativeSessionCleanup';

const session = (id: string, directory = '/repo'): Session => ({ id, directory }) as Session;

describe('authoritative session cleanup', () => {
  test('does not infer deletion from the first authoritative startup snapshot', () => {
    const current = buildAuthoritativeSessionIdentityMap([]);

    expect(findRemovedAuthoritativeSessions(null, current)).toEqual([]);
  });

  test('finds sessions omitted after an established authoritative baseline', () => {
    const previous = buildAuthoritativeSessionIdentityMap([
      session('deleted'),
      session('retained'),
    ]);
    const current = buildAuthoritativeSessionIdentityMap([session('retained')]);

    expect(findRemovedAuthoritativeSessions(previous, current)).toEqual([
      { directory: '/repo', sessionId: 'deleted' },
    ]);
  });

  test('treats archive membership as retained authority', () => {
    const previous = buildAuthoritativeSessionIdentityMap([session('archived')]);
    const current = buildAuthoritativeSessionIdentityMap([
      { ...session('archived'), time: { archived: 10 } } as Session,
    ]);

    expect(findRemovedAuthoritativeSessions(previous, current)).toEqual([]);
  });

  test('does not treat a directory move as session deletion', () => {
    const previous = buildAuthoritativeSessionIdentityMap([session('moved', '/repo-a')]);
    const current = buildAuthoritativeSessionIdentityMap([session('moved', '/repo-b')]);

    expect(findRemovedAuthoritativeSessions(previous, current)).toEqual([]);
  });
});
