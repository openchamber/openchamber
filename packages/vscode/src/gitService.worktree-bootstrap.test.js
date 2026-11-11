import { describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureProjectStartCommandSource } from '../../web/server/lib/opencode/project-start-command.js';
import { worktreeBootstrapFailureMessage } from '../../web/server/lib/git/worktree-bootstrap-storage.js';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { createWorktree, previewWorktreeCreate, listGitWorktrees, getWorktreeBootstrapStatus, removeWorktree } = await import('./gitService.ts?worktree-bootstrap-test');

const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('VS Code worktree bootstrap phases', () => {
  it('treats missing bootstrap state as fully ready', async () => {
    await expect(getWorktreeBootstrapStatus('/untracked-worktree')).resolves.toMatchObject({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
    });
  });

  it('runs the project start command in a canonical new worktree', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-start-'));
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG;
    const realData = path.join(scratch, 'real-data');
    const aliasData = path.join(scratch, 'alias-data');
    fs.mkdirSync(realData);
    fs.symlinkSync(realData, aliasData, process.platform === 'win32' ? 'junction' : 'dir');
    process.env.XDG_DATA_HOME = path.join(aliasData, 'new-data');
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
    fs.writeFileSync(path.join(repository, 'opencode.json'), JSON.stringify({ worktree: null }));

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
      process.env.OPENCODE_CONFIG = path.join(repository, 'opencode.json');
      const input = {
        mode: 'new',
        branchName: 'feature/project-start',
        worktreeName: 'project-start',
        returnAfterDirectoryCreated: true,
      };
      const preview = await previewWorktreeCreate(projectFolder, input);
      const created = await createWorktree(projectFolder, input);

      const deadline = Date.now() + 10_000;
      while ((await getWorktreeBootstrapStatus(created.path)).phase !== 'setup-ready' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      try {
        const listed = (await listGitWorktrees(repository)).find((entry) => entry.branch === created.branch);
        expect(listed).toBeDefined();
        expect(created.path.replaceAll('\\', '/')).toBe(listed.path.replaceAll('\\', '/'));
        expect(preview.path.replaceAll('\\', '/')).toBe(listed.path.replaceAll('\\', '/'));
        expect(fs.readFileSync(path.join(created.path, 'START_RAN'), 'utf8')).toBe(fs.realpathSync(created.path));
        expect(askedFor.map((directory) => fs.realpathSync(directory))).toEqual([fs.realpathSync(projectFolder)]);
      } finally {
        await removeWorktree(repository, { directory: created.path });
      }
    } finally {
      configureProjectStartCommandSource(null);
      if (previousOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it('records a branch name nested under an existing branch as BRANCH_NAME_CONFLICT with the server sentence', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-conflict-'));
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(scratch, 'data');
    try {
      const repository = path.join(scratch, 'repo');
      fs.mkdirSync(repository);
      runGit(repository, ['init', '-b', 'main']);
      runGit(repository, ['config', 'user.email', 'test@example.com']);
      runGit(repository, ['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
      runGit(repository, ['add', 'README.md']);
      runGit(repository, ['commit', '-m', 'init']);
      runGit(repository, ['branch', 'team/stable']);

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'team/stable/feat/export',
        worktreeName: 'export',
        returnAfterDirectoryCreated: true,
      });

      const deadline = Date.now() + 10_000;
      while ((await getWorktreeBootstrapStatus(created.path)).status === 'pending' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await expect(getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'failed',
        phase: 'directory-created',
        errorCode: 'BRANCH_NAME_CONFLICT',
        error: worktreeBootstrapFailureMessage('BRANCH_NAME_CONFLICT'),
      });
    } finally {
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
