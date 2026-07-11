import { describe, expect, test } from 'bun:test';

import type { SessionFocusIdentity } from '@/stores/useSessionFocusStore';
import { reconcileSessionFocus } from './sessionFocusReconciliation';

const focus = (
  scope: SessionFocusIdentity['scope'],
  sessionId: string,
  projectId: string | null,
): SessionFocusIdentity => ({ scope, sessionId, projectId });

describe('reconcileSessionFocus', () => {
  test('fills a Recent focus project once sidebar metadata resolves', () => {
    expect(reconcileSessionFocus({
      currentSessionId: 'session-a',
      focus: focus('recent', 'session-a', null),
      recentFocuses: [focus('recent', 'session-a', 'project-a')],
      projectFocuses: [focus('project', 'session-a', 'project-a')],
      fallbackProjectId: 'project-a',
    })).toEqual(focus('recent', 'session-a', 'project-a'));
  });

  test('falls back to the corresponding Project occurrence when Recent disappears', () => {
    expect(reconcileSessionFocus({
      currentSessionId: 'session-a',
      focus: focus('recent', 'session-a', 'project-a'),
      recentFocuses: [],
      projectFocuses: [focus('project', 'session-a', 'project-a')],
      fallbackProjectId: 'project-a',
    })).toEqual(focus('project', 'session-a', 'project-a'));
  });

  test('uses metadata fallback during search when both rendered rings omit the session', () => {
    expect(reconcileSessionFocus({
      currentSessionId: 'session-a',
      focus: focus('recent', 'session-a', 'project-a'),
      recentFocuses: [],
      projectFocuses: [],
      fallbackProjectId: 'project-a',
    })).toEqual(focus('project', 'session-a', 'project-a'));
  });

  test('preserves an exact Project occurrence when a session belongs to nested projects', () => {
    expect(reconcileSessionFocus({
      currentSessionId: 'session-a',
      focus: focus('project', 'session-a', 'project-parent'),
      recentFocuses: [],
      projectFocuses: [
        focus('project', 'session-a', 'project-child'),
        focus('project', 'session-a', 'project-parent'),
      ],
      fallbackProjectId: 'project-child',
    })).toEqual(focus('project', 'session-a', 'project-parent'));
  });

  test('reconciles stale focus to current content without changing the session id', () => {
    expect(reconcileSessionFocus({
      currentSessionId: 'session-b',
      focus: focus('recent', 'session-a', 'project-a'),
      recentFocuses: [focus('recent', 'session-a', 'project-a')],
      projectFocuses: [focus('project', 'session-b', 'project-b')],
      fallbackProjectId: 'project-b',
    })).toEqual(focus('project', 'session-b', 'project-b'));
  });

  test('clears focus when there is no current session', () => {
    expect(reconcileSessionFocus({
      currentSessionId: null,
      focus: focus('recent', 'session-a', 'project-a'),
      recentFocuses: [focus('recent', 'session-a', 'project-a')],
      projectFocuses: [focus('project', 'session-a', 'project-a')],
      fallbackProjectId: 'project-a',
    })).toBeNull();
  });
});
