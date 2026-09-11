import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import { installHookTestDom } from '../test-utils/testDom';
import {
  buildAuthoritativeSessionIdentityMap,
  findRemovedAuthoritativeSessions,
} from './authoritativeSessionCleanup';

// SAFETY: cleanup identity tests only consume the SDK session ID and directory fields.
const session = (id: string, directory = '/repo'): Session => ({ id, directory }) as Session;

const cleanups: Array<{ runtimeKey: string; directory: string; sessionId: string }> = [];
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => 'runtime' }));
mock.module('@/sync/session-deletion-cleanup', () => ({
  cleanupPersistedSessionState: (identity: { runtimeKey: string; directory: string; sessionId: string }) => cleanups.push(identity),
}));
const { useAuthoritativeSessionCleanup } = await import('./useAuthoritativeSessionCleanup');

const CleanupProbe: React.FC<{ sessions: Session[]; revision: number }> = ({ sessions, revision }) => {
  useAuthoritativeSessionCleanup({ enabled: true, hasAuthoritativeGlobalSessions: true, sessions });
  return React.createElement('span', null, revision);
};

describe('authoritative session cleanup', () => {
  let root: Root;
  let dom: ReturnType<typeof installHookTestDom>;

  beforeEach(() => {
    cleanups.length = 0;
    dom = installHookTestDom();
    root = createRoot(dom.container);
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.restore();
  });

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
      // SAFETY: cleanup identity tests only consume the SDK session ID and directory fields.
      { ...session('archived'), time: { archived: 10 } } as Session,
    ]);

    expect(findRemovedAuthoritativeSessions(previous, current)).toEqual([]);
  });

  test('does not treat a directory move as session deletion', () => {
    const previous = buildAuthoritativeSessionIdentityMap([session('moved', '/repo-a')]);
    const current = buildAuthoritativeSessionIdentityMap([session('moved', '/repo-b')]);

    expect(findRemovedAuthoritativeSessions(previous, current)).toEqual([]);
  });

  test('uses the first mounted complete snapshot as a baseline, then cleans an omission once', () => {
    const baseline = [session('deleted'), session('retained')];
    act(() => root.render(React.createElement(CleanupProbe, { sessions: baseline, revision: 0 })));
    expect(cleanups).toEqual([]);

    act(() => root.render(React.createElement(CleanupProbe, { sessions: [session('retained')], revision: 1 })));
    expect(cleanups).toEqual([{ runtimeKey: 'runtime', directory: '/repo', sessionId: 'deleted' }]);

    act(() => root.render(React.createElement(CleanupProbe, { sessions: [session('retained')], revision: 2 })));
    expect(cleanups).toHaveLength(1);
  });

  test('retains archive and move identities, preserves the same-array baseline on unrelated rerender, and resets on remount', () => {
    const baseline = [session('session', '/repo-a')];
    act(() => root.render(React.createElement(CleanupProbe, { sessions: baseline, revision: 0 })));
    act(() => root.render(React.createElement(CleanupProbe, { sessions: baseline, revision: 1 })));
    act(() => root.render(React.createElement(CleanupProbe, { sessions: [{ ...session('session', '/repo-a'), time: { created: 0, updated: 0, archived: 1 } }], revision: 2 })));
    act(() => root.render(React.createElement(CleanupProbe, { sessions: [session('session', '/repo-b')], revision: 3 })));
    expect(cleanups).toEqual([]);

    act(() => root.unmount());
    root = createRoot(dom.container);
    act(() => root.render(React.createElement(CleanupProbe, { sessions: [], revision: 4 })));
    expect(cleanups).toEqual([]);
  });
});
