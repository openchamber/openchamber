import { describe, expect, test } from 'bun:test';
import {
  resolveCreatedWorktreeStartDirectory,
  resolveStartDirectory,
  type CreatedWorktreeStartDeps,
  type WorktreeStartDirectoryDeps,
} from './worktreeStartDirectory';

const project = { id: 'p', path: '/repo/ai' };

const deps = (overrides: Partial<WorktreeStartDirectoryDeps> = {}): WorktreeStartDirectoryDeps & { waited: string[]; checked: string[] } => {
  const waited: string[] = [];
  const checked: string[] = [];
  return {
    waited,
    checked,
    readProjectFolder: async () => 'ai',
    waitForCheckout: async (root) => { waited.push(root); },
    directoryInsideCheckout: async (directory) => { checked.push(directory); return true; },
    ...overrides,
  };
};

describe('resolveStartDirectory', () => {
  test('starts in the worktree root without waiting when the project is the repository root', async () => {
    const d = deps({ readProjectFolder: async () => '' });
    expect(await resolveStartDirectory(project, '/wt/feat', d)).toEqual({ directory: '/wt/feat', fallback: null });
    expect(d.waited).toEqual([]);
    expect(d.checked).toEqual([]);
  });

  test('waits for the checkout, then starts in the project folder when it exists inside it', async () => {
    const d = deps();
    expect(await resolveStartDirectory(project, '/wt/feat/', d)).toEqual({ directory: '/wt/feat/ai', fallback: null });
    expect(d.waited).toEqual(['/wt/feat']);
    expect(d.checked).toEqual(['/wt/feat/ai']);
  });

  test('keeps a nested project folder as is', async () => {
    const d = deps({ readProjectFolder: async () => 'packages/app' });
    expect((await resolveStartDirectory(project, '/wt/feat', d)).directory).toBe('/wt/feat/packages/app');
  });

  test('falls back to the root and says the folder is missing', async () => {
    const d = deps({ directoryInsideCheckout: async () => false });
    expect(await resolveStartDirectory(project, '/wt/feat', d)).toEqual({ directory: '/wt/feat', fallback: 'missing', folder: 'ai' });
  });

  test('falls back to the root and says it could not verify when the check fails', async () => {
    const d = deps({ directoryInsideCheckout: async () => { throw new Error('no runtime support'); } });
    expect(await resolveStartDirectory(project, '/wt/feat', d)).toEqual({ directory: '/wt/feat', fallback: 'unverified', folder: 'ai' });
  });

  test('a folder git cannot report is a named fallback, not "at the root"', async () => {
    const d = deps({ readProjectFolder: async () => { throw new Error('HTTP 500'); } });
    expect(await resolveStartDirectory(project, '/wt/feat', d)).toEqual({ directory: '/wt/feat', fallback: 'unknown', folder: null });
    expect(d.waited).toEqual([]);
  });

  test('a checkout that failed to populate rejects instead of starting anywhere', async () => {
    const d = deps({ waitForCheckout: async () => { throw new Error('Worktree bootstrap failed'); } });
    await expect(resolveStartDirectory(project, '/wt/feat', d)).rejects.toThrow('Worktree bootstrap failed');
  });
});

describe('resolveCreatedWorktreeStartDirectory', () => {
  const created = { path: '/wt/feat', projectDirectory: '/repo', branch: 'feat', label: 'feat' };
  const cleanup = (overrides: Partial<CreatedWorktreeStartDeps> = {}) => {
    const removed: string[] = [];
    const d: CreatedWorktreeStartDeps = {
      resolve: async (_project, root) => `${root}/ai`,
      remove: async (_project, worktree) => { removed.push(worktree.path); },
      ...overrides,
    };
    return { d, removed };
  };

  test('answers the start folder and keeps the worktree', async () => {
    const { d, removed } = cleanup();
    expect(await resolveCreatedWorktreeStartDirectory(project, created, d)).toBe('/wt/feat/ai');
    expect(removed).toEqual([]);
  });

  test('removes the worktree whose checkout never populated and rethrows', async () => {
    const { d, removed } = cleanup({ resolve: async () => { throw new Error('checkout failed'); } });
    await expect(resolveCreatedWorktreeStartDirectory(project, created, d)).rejects.toThrow('checkout failed');
    expect(removed).toEqual(['/wt/feat']);
  });

  test('a failed removal does not hide the original error', async () => {
    const { d } = cleanup({
      resolve: async () => { throw new Error('checkout failed'); },
      remove: async () => { throw new Error('worktree is locked'); },
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await expect(resolveCreatedWorktreeStartDirectory(project, created, d)).rejects.toThrow('checkout failed');
    } finally {
      console.warn = originalWarn;
    }
  });
});
