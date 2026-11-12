import { describe, expect, test } from 'bun:test';
import { prepareSessionProjectAction } from './sessionProjectActionContext';

const run = (projectId: string | null, mobileVariant: boolean, closeMobileSwitcher: boolean): string[] => {
  const calls: string[] = [];
  prepareSessionProjectAction({
    projectId,
    mobileVariant,
    closeMobileSwitcher,
    setActiveProjectIdOnly: (id) => calls.push(`project:${id}`),
    setSessionSwitcherOpen: (open) => calls.push(`switcher:${open}`),
  });
  return calls;
};

describe('prepareSessionProjectAction', () => {
  test('selects the project and closes the mobile switcher before creating a session', () => {
    expect(run('project-a', true, true)).toEqual(['project:project-a', 'switcher:false']);
  });

  test('closes the mobile switcher for projectless chat folders', () => {
    expect(run(null, true, true)).toEqual(['switcher:false']);
  });

  test('selects the project without closing the switcher before opening a worktree dialog', () => {
    expect(run('project-a', true, false)).toEqual(['project:project-a']);
  });
});
