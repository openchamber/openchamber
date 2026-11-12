import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@/lib/opencode/model';
import { replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { applyGlobalBlockingRequestEvents, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useCollapsedSessionActivityState } from './collapsedActivityState';
import type { SessionNode } from '../types';
import { installHookTestDom } from '../test-utils/testDom';

// SAFETY: the fixture supplies the minimal SDK identity used by the selector.
const node = (id: string): SessionNode => ({ session: { id } as Session, children: [], worktree: null });

const record = (id: string, idle?: number): Session => {
  const session: Session = {
    id, title: id, directory: '/workspace', projectID: 'project', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: idle ?? 1 },
  };
  if (idle !== undefined) session.time.idle = idle;
  return session;
};

describe('collapsed activity scalar selector', () => {
  test('does not rerender for unrelated updates and rerenders for relevant scalar changes', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    replaceGlobalSessionStatusById(new Map());
    const originalSessions = useGlobalSessionsStore.getState();
    useGlobalSessionsStore.getState().applySnapshot([record('relevant'), record('unrelated')], []);
    type ActivityCapture = { renders: number; state: string | null };
    const capture: ActivityCapture = { renders: 0, state: null };
    const Harness = () => {
      capture.renders += 1;
      capture.state = useCollapsedSessionActivityState({ nodes: [node('relevant')] });
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(Harness)));
      const initialRenders = capture.renders;
      await act(async () => replaceGlobalSessionStatusById(new Map([['unrelated', { status: { type: 'busy' }, directory: '/other' }]])));
      await act(async () => useGlobalSessionsStore.getState().upsertSession(record('unrelated', 2)));
      expect(capture.renders).toBe(initialRenders);

      await act(async () => useGlobalSessionsStore.getState().upsertSession(record('relevant', 3)));
      expect(capture.state).toBe('unread');
      const unreadRenders = capture.renders;
      await act(async () => replaceGlobalSessionStatusById(new Map([['relevant', { status: { type: 'busy' }, directory: '/workspace' }]])));
      expect(capture.state).toBe('active');
      expect(capture.renders).toBe(unreadRenders + 1);

      // A pending request outranks a running turn, and a request elsewhere is ignored.
      const activeRenders = capture.renders;
      await act(async () => applyGlobalBlockingRequestEvents('/other', [{
        type: 'form.created', properties: { form: { id: 'q-other', sessionID: 'unrelated', title: 'Pick', fields: [{ key: 'answer', type: 'boolean' }] } },
      }]));
      expect(capture.state).toBe('active');
      expect(capture.renders).toBe(activeRenders);
      await act(async () => applyGlobalBlockingRequestEvents('/workspace', [{
        type: 'form.created', properties: { form: { id: 'q1', sessionID: 'relevant', title: 'Pick', fields: [{ key: 'answer', type: 'boolean' }] } },
      }]));
      expect(capture.state).toBe('form');
      await act(async () => applyGlobalBlockingRequestEvents('/workspace', [{
        type: 'permission.asked',
        properties: { id: 'p1', sessionID: 'relevant', action: 'bash', resources: [] },
      }]));
      expect(capture.state).toBe('permission');
      await act(async () => applyGlobalBlockingRequestEvents('/workspace', [
        { type: 'permission.replied', properties: { sessionID: 'relevant', requestID: 'p1' } },
        { type: 'form.settled', properties: { sessionID: 'relevant', formID: 'q1' } },
      ]));
      expect(capture.state).toBe('active');
    } finally {
      await act(async () => root.unmount());
      replaceGlobalSessionStatusById(new Map());
      resetGlobalBlockingRequests();
      useGlobalSessionsStore.setState(originalSessions);
      dom.restore();
    }
  });

  test('counts a request from a session that is listed only as blocking, such as a hidden subagent', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    replaceGlobalSessionStatusById(new Map());
    const capture: { state: string | null } = { state: null };
    const Harness = () => {
      capture.state = useCollapsedSessionActivityState({
        nodes: [node('lane')],
        blockingSessionIds: ['lane', 'lane-subagent'],
      });
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(Harness)));
      expect(capture.state).toBeNull();
      await act(async () => applyGlobalBlockingRequestEvents('/workspace', [{
        type: 'permission.asked',
        properties: { id: 'p-sub', sessionID: 'lane-subagent', action: 'bash', resources: [] },
      }]));
      expect(capture.state).toBe('permission');
    } finally {
      await act(async () => root.unmount());
      resetGlobalBlockingRequests();
      dom.restore();
    }
  });
});
