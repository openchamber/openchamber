import { describe, expect, test } from 'bun:test';

import { isRunInScope } from './project-scope';
import { resolveWorkflowProjectScope } from './project';

const project = { id: 'p1', path: '/repo' };
const worktree = { path: '/worktrees/repo-feature', projectDirectory: '/repo', branch: 'feature', label: 'feature' };

describe('workflow project scope', () => {
  test("a worktree session's runs belong to its project, with the project's saved workflows", () => {
    const scope = resolveWorkflowProjectScope([project], new Map([['/repo', [worktree]]]), '/worktrees/repo-feature');
    expect(scope).toEqual({ directories: ['/repo', '/worktrees/repo-feature'], savedDirectory: '/repo' });
    if (!scope) throw new Error('no scope');
    expect(isRunInScope('/repo', scope)).toBe(true);
    expect(isRunInScope('/elsewhere', scope)).toBe(false);
  });

  test('a folder that is no project keeps to itself', () => {
    expect(resolveWorkflowProjectScope([project], new Map(), '/scratch')).toEqual({ directories: ['/scratch'], savedDirectory: '/scratch' });
  });
});
