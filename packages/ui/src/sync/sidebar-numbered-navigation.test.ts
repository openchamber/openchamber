import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionNavigationTarget } from './session-navigation';
import {
  activateSidebarNumberedSession,
  buildSidebarNumberedSessionTargets,
  clearSidebarNumberedNavigation,
  getSidebarNumberedSessionNumber,
  publishSidebarNumberedNavigation,
} from './sidebar-numbered-navigation';

const target = (
  scope: 'recent' | 'project',
  sessionId: string,
  projectId: string | null,
): SessionNavigationTarget => ({
  scope,
  sessionId,
  projectId,
  directory: `/tmp/${projectId ?? 'recent'}`,
});

afterEach(() => {
  clearSidebarNumberedNavigation();
});

describe('sidebar numbered session navigation', () => {
  test('numbers visible Recent and project session rows in rendered order and caps at nine', () => {
    const recent = [target('recent', 'shared', 'p1')];
    const projects = Array.from({ length: 10 }, (_, index) => (
      target('project', index === 0 ? 'shared' : `s${index + 1}`, `p${index + 1}`)
    ));

    const targets = buildSidebarNumberedSessionTargets({
      recentTargets: recent,
      projectTargets: projects,
    });

    expect(targets).toHaveLength(9);
    expect(targets[0]).toEqual(recent[0]);
    expect(targets[1]).toEqual(projects[0]);
    expect(targets[8]).toEqual(projects[7]);
    expect(getSidebarNumberedSessionNumber(targets, recent[0])).toBe(1);
    expect(getSidebarNumberedSessionNumber(targets, projects[0])).toBe(2);
    expect(getSidebarNumberedSessionNumber(targets, projects[8])).toBeNull();
  });

  test('activates the exact numbered session and ignores missing slots', () => {
    const targets = [target('recent', 'a', 'p1'), target('project', 'b', 'p2')];
    const activated: SessionNavigationTarget[] = [];
    publishSidebarNumberedNavigation({
      targets,
      activate: (next) => activated.push(next),
    });

    expect(activateSidebarNumberedSession(2)).toBe(true);
    expect(activated).toEqual([targets[1]]);
    expect(activateSidebarNumberedSession(3)).toBe(false);
    expect(activateSidebarNumberedSession(0)).toBe(false);
  });

  test('an old publisher cleanup cannot clear a newer sidebar snapshot', () => {
    const firstCleanup = publishSidebarNumberedNavigation({
      targets: [target('project', 'old', 'p1')],
      activate: () => undefined,
    });
    const activated: string[] = [];
    publishSidebarNumberedNavigation({
      targets: [target('project', 'new', 'p2')],
      activate: (next) => activated.push(next.sessionId),
    });

    firstCleanup();
    expect(activateSidebarNumberedSession(1)).toBe(true);
    expect(activated).toEqual(['new']);
  });
});
