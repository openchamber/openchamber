import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PermissionRequest, Session } from '@/lib/opencode/model';
import { ChildStoreManager } from '@/sync/child-store';
import { applyGlobalBlockingRequestEvents, applyWaitingPageEvent, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { isWaitingPageRevealPending, subscribeRequestReveal, takeWaitingPageReveal } from '@/sync/request-reveal';
import { findBlockingRequestTarget, openBlockingRequestTarget } from '@/sync/session-request-hooks';
import { setSyncRefs } from '@/sync/sync-refs';
import type { SessionNode } from '../types';
import { selectBlockingBadgeSessions } from './sessionNodeItemUtils';

// SAFETY: the badge lookup reads only id, parent and directory, which the fixture sets.
const session = (id: string, directory: string, parentID?: string, metadata?: Session['metadata']): Session => (
  { id, title: id, directory, parentID, metadata, time: { created: 1, updated: 1 } } as Session
);
const node = (value: Session, children: SessionNode[] = []): SessionNode => ({ session: value, children, worktree: null });
const review = (id: string, parentID: string): SessionNode => node(session(id, '/repo', undefined, { openchamber: { kind: 'review', originalSessionID: parentID } }));

const askPermission = (directory: string, sessionID: string): void => applyGlobalBlockingRequestEvents(directory, [{
  type: 'permission.asked',
  properties: { id: `perm-${sessionID}`, sessionID, action: 'bash', resources: [] } satisfies PermissionRequest,
}]);
const askQuestion = (directory: string, sessionID: string): void => applyGlobalBlockingRequestEvents(directory, [{
  type: 'form.created',
  properties: { form: { id: `form-${sessionID}`, sessionID, title: 'Pick one', fields: [{ key: 'answer', type: 'boolean' }] } },
}]);
const waitOnPage = (directory: string, sessionID: string): void => applyWaitingPageEvent(
  { type: 'openchamber.page-waiting', properties: { sessionID, directory, page: { id: `call-${sessionID}`, title: 'Pick a layout' } } },
  () => directory,
);

/** A parent in the repo, a subagent that started its own subagent, a second subagent, and a worker in another worktree. */
const family = (): SessionNode => node(session('parent', '/repo'), [
  node(session('sub-a', '/repo', 'parent'), [node(session('sub-a-1', '/repo', 'sub-a'))]),
  node(session('worker', '/worktrees/feature', 'parent')),
  node(session('sub-b', '/repo', 'parent')),
]);

const targetFor = (root: SessionNode, kind: 'permission' | 'form', expanded = false, showSubagentSessions = false) => (
  findBlockingRequestTarget(selectBlockingBadgeSessions(root, expanded, '/repo', showSubagentSessions), kind)
);

beforeEach(() => {
  resetGlobalBlockingRequests();
  // SAFETY: the lookup reads directory stores only; no SDK call is reached.
  setSyncRefs({} as never, new ChildStoreManager(), '');
});

afterEach(() => {
  resetGlobalBlockingRequests();
  takeWaitingPageReveal(null);
});

describe('the session a row badge opens', () => {
  test('is the row itself when its own session asks, even while a hidden subagent asks too', () => {
    askPermission('/worktrees/feature', 'worker');
    askPermission('/repo', 'parent');
    expect(targetFor(family(), 'permission')).toEqual({ sessionID: 'parent', directory: '/repo', reveal: { kind: 'request', requestID: 'perm-parent' } });
  });

  test('is the first waiting subagent in tree order, a grandchild before a later sibling', () => {
    askPermission('/repo', 'sub-b');
    askPermission('/repo', 'sub-a-1');
    expect(targetFor(family(), 'permission', true)?.sessionID).toBe('sub-a-1');
  });

  test('is a worker in another worktree, opened in its own directory', () => {
    askPermission('/repo', 'sub-b');
    askPermission('/worktrees/feature', 'worker');
    expect(targetFor(family(), 'permission', true)).toEqual({
      sessionID: 'worker',
      directory: '/worktrees/feature',
      reveal: { kind: 'request', requestID: 'perm-worker' },
    });
  });

  test('is a listed child only while its row is collapsed; expanded, the child row reports itself', () => {
    const root = node(session('parent', '/repo'), [review('review', 'parent')]);
    askPermission('/repo', 'review');
    expect(targetFor(root, 'permission', false, true)?.sessionID).toBe('review');
    expect(targetFor(root, 'permission', true, true)).toBeNull();
  });

  test('a question badge leads to the question, then to a waiting page, and a permission badge to neither', () => {
    waitOnPage('/repo', 'sub-a');
    expect(targetFor(family(), 'form', true)).toEqual({ sessionID: 'sub-a', directory: '/repo', reveal: { kind: 'page' } });
    expect(targetFor(family(), 'permission', true)).toBeNull();

    askQuestion('/repo', 'sub-a');
    expect(targetFor(family(), 'form', true)?.reveal).toEqual({ kind: 'request', requestID: 'form-sub-a' });
  });

  test('a directory store that has listed the session answers alone, as the badge does', () => {
    const childStores = new ChildStoreManager();
    // SAFETY: as above, only directory stores are read.
    setSyncRefs({} as never, childStores, '');
    askPermission('/repo', 'sub-a');
    const store = childStores.ensureChild('/repo', { bootstrap: false });
    store.setState({ status: 'complete', requestCoverage: new Set(['parent', 'sub-a', 'sub-a-1', 'sub-b']) });
    expect(targetFor(family(), 'permission', true)).toBeNull();

    store.setState({ permission: { 'sub-b': [{ id: 'perm-own', sessionID: 'sub-b', action: 'bash', resources: [] }] } });
    expect(targetFor(family(), 'permission', true)).toEqual({ sessionID: 'sub-b', directory: '/repo', reveal: { kind: 'request', requestID: 'perm-own' } });
  });
});

describe('opening the target', () => {
  test('a request opens its session, then asks the docks to reveal it', () => {
    const steps: string[] = [];
    const unsubscribe = subscribeRequestReveal(() => steps.push('reveal'));
    openBlockingRequestTarget(
      { sessionID: 'worker', directory: '/worktrees/feature', reveal: { kind: 'request', requestID: 'perm-worker' } },
      (sessionID, directory) => steps.push(`open ${sessionID} ${directory}`),
    );
    unsubscribe();
    expect(steps).toEqual(['open worker /worktrees/feature', 'reveal']);
  });

  test('a waiting page is marked for reveal before its session opens, so the chat scrolls to it on entry', () => {
    let pendingWhenOpened = false;
    openBlockingRequestTarget(
      { sessionID: 'sub-a', directory: '/repo', reveal: { kind: 'page' } },
      (sessionID) => { pendingWhenOpened = isWaitingPageRevealPending(sessionID); },
    );
    expect(pendingWhenOpened).toBe(true);
  });
});

test('a directory given with a trailing slash reads the same store the badge reads', () => {
  const childStores = new ChildStoreManager();
  // SAFETY: as above, only directory stores are read.
  setSyncRefs({} as never, childStores, '');
  childStores.ensureChild('/repo', { bootstrap: false }).setState({
    permission: { parent: [{ id: 'perm-store', sessionID: 'parent', action: 'bash', resources: [] }] },
  });
  expect(findBlockingRequestTarget([{ sessionID: 'parent', directory: '/repo/' }], 'permission')).toEqual({
    sessionID: 'parent',
    directory: '/repo',
    reveal: { kind: 'request', requestID: 'perm-store' },
  });
});
