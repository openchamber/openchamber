import { describe, expect, it, mock } from 'bun:test';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getWorktreeBootstrapStatus, resolveWorktreeProjectStartCommand } = await import('./gitService.ts?worktree-bootstrap-test');

describe('VS Code worktree bootstrap phases', () => {
  it('treats missing bootstrap state as fully ready', async () => {
    await expect(getWorktreeBootstrapStatus('/untracked-worktree')).resolves.toMatchObject({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
    });
  });

  it('uses an authoritative project start command without loading legacy JSON', async () => {
    const runtime = {
      loadStartCommand: mock(async () => ({ available: true, command: ' bun dev ' })),
    };
    const legacyLoader = mock(async () => 'legacy command');

    await expect(resolveWorktreeProjectStartCommand('project-a', '/repo', runtime, legacyLoader)).resolves.toBe('bun dev');
    expect(runtime.loadStartCommand).toHaveBeenCalledWith('project-a', '/repo');
    expect(legacyLoader).not.toHaveBeenCalled();
  });

  it('preserves authoritative empty commands without loading legacy JSON', async () => {
    const runtime = {
      loadStartCommand: mock(async () => ({ available: true, command: '' })),
    };
    const legacyLoader = mock(async () => 'legacy command');

    await expect(resolveWorktreeProjectStartCommand('project-a', '/repo', runtime, legacyLoader)).resolves.toBe('');
    expect(legacyLoader).not.toHaveBeenCalled();
  });

  it('uses legacy project JSON when the API runtime is unavailable', async () => {
    const runtime = {
      loadStartCommand: mock(async () => ({ available: false, command: '' })),
    };
    const legacyLoader = mock(async () => 'legacy command');

    await expect(resolveWorktreeProjectStartCommand('project-a', '/repo', runtime, legacyLoader)).resolves.toBe('legacy command');
    expect(legacyLoader).toHaveBeenCalledWith('project-a');
  });
});
