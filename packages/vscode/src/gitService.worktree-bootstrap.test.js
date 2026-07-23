import { describe, expect, it, mock } from 'bun:test';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getWorktreeBootstrapStatus } = await import('./gitService.ts?worktree-bootstrap-test');

describe('VS Code worktree bootstrap phases', () => {
  it('treats missing bootstrap state as fully ready', async () => {
    await expect(getWorktreeBootstrapStatus('/untracked-worktree')).resolves.toMatchObject({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
    });
  });
});
