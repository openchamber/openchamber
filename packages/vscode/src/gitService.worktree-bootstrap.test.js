import { describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureProjectStartCommandSource } from '../../web/server/lib/opencode/project-start-command.js';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { createWorktree, getWorktreeBootstrapStatus } = await import('./gitService.ts?worktree-bootstrap-test');

const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('VS Code worktree bootstrap phases', () => {
  it('treats missing bootstrap state as fully ready', async () => {
    await expect(getWorktreeBootstrapStatus('/untracked-worktree')).resolves.toMatchObject({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
    });
  });

  it('runs the start command OpenCode keeps for the project in the new worktree', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-start-'));
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(scratch, 'data');
    // The project is a subfolder of the repository: the read goes to that
    // folder, which OpenCode already serves.
    const repository = path.join(scratch, 'repo');
    const projectFolder = path.join(repository, 'app');
    fs.mkdirSync(projectFolder, { recursive: true });
    runGit(repository, ['init', '-b', 'main']);
    runGit(repository, ['config', 'user.email', 'test@example.com']);
    runGit(repository, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(projectFolder, 'README.md'), '# Test\n');
    runGit(repository, ['add', 'app/README.md']);
    runGit(repository, ['commit', '-m', 'init']);

    const askedFor = [];
    const markerScript = path.join(scratch, 'project-start.cjs');
    fs.writeFileSync(markerScript, "require('node:fs').writeFileSync('START_RAN', process.cwd());\n");
    configureProjectStartCommandSource({
      read: async (directory) => {
        askedFor.push(directory);
        return `${JSON.stringify(process.execPath)} ${JSON.stringify(markerScript)}`;
      },
    });

    try {
      const created = await createWorktree(projectFolder, {
        mode: 'new',
        branchName: 'feature/project-start',
        worktreeName: 'project-start',
        returnAfterDirectoryCreated: true,
      });

      const deadline = Date.now() + 10_000;
      while ((await getWorktreeBootstrapStatus(created.path)).phase !== 'setup-ready' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(fs.readFileSync(path.join(created.path, 'START_RAN'), 'utf8')).toBe(fs.realpathSync(created.path));
      expect(askedFor.map((directory) => fs.realpathSync(directory))).toEqual([fs.realpathSync(projectFolder)]);
    } finally {
      configureProjectStartCommandSource(null);
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
