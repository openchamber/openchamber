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

  it('bounds a hanging start command so the bootstrap still completes (#861)', async () => {
    if (process.platform === 'win32') return;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-start-timeout-'));
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const previousTimeout = process.env.OPENCHAMBER_WORKTREE_START_COMMAND_TIMEOUT_MS;
    process.env.XDG_DATA_HOME = path.join(scratch, 'data');
    process.env.OPENCHAMBER_WORKTREE_START_COMMAND_TIMEOUT_MS = '1000';
    const repository = path.join(scratch, 'repo');
    fs.mkdirSync(repository, { recursive: true });
    runGit(repository, ['init', '-b', 'main']);
    runGit(repository, ['config', 'user.email', 'test@example.com']);
    runGit(repository, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
    runGit(repository, ['add', 'README.md']);
    runGit(repository, ['commit', '-m', 'init']);
    const hangScript = path.join(scratch, 'hang.cjs');
    fs.writeFileSync(hangScript, 'setTimeout(() => {}, 120_000);\n');

    try {
      const startedAt = Date.now();
      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'feature/start-command-timeout',
        worktreeName: 'start-command-timeout',
        returnAfterDirectoryCreated: true,
        startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(hangScript)}`,
      });

      const deadline = Date.now() + 15_000;
      while ((await getWorktreeBootstrapStatus(created.path)).phase !== 'setup-ready' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect((await getWorktreeBootstrapStatus(created.path)).phase).toBe('setup-ready');
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    } finally {
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      if (previousTimeout === undefined) delete process.env.OPENCHAMBER_WORKTREE_START_COMMAND_TIMEOUT_MS;
      else process.env.OPENCHAMBER_WORKTREE_START_COMMAND_TIMEOUT_MS = previousTimeout;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it('kills the whole start-command tree on timeout, descendants included (#868)', async () => {
    if (process.platform === 'win32') return;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-start-tree-timeout-'));
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const previousTimeout = process.env.OPENCHAMBER_WORKTREE_START_COMMAND_TIMEOUT_MS;
    process.env.XDG_DATA_HOME = path.join(scratch, 'data');
    process.env.OPENCHAMBER_WORKTREE_START_COMMAND_TIMEOUT_MS = '1000';
    const repository = path.join(scratch, 'repo');
    fs.mkdirSync(repository, { recursive: true });
    runGit(repository, ['init', '-b', 'main']);
    runGit(repository, ['config', 'user.email', 'test@example.com']);
    runGit(repository, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
    runGit(repository, ['add', 'README.md']);
    runGit(repository, ['commit', '-m', 'init']);
    const descendantScript = path.join(scratch, 'descendant.cjs');
    // SIGTERM-ignoring descendant, mirroring the web twin's test: only the
    // completed SIGKILL escalation stops it.
    fs.writeFileSync(descendantScript, "process.on('SIGTERM', () => {});\nsetTimeout(() => {}, 120_000);\n");
    const pidFile = path.join(scratch, 'descendant.pid');
    const spawnerScript = path.join(scratch, 'spawner.cjs');
    fs.writeFileSync(
      spawnerScript,
      `const { spawn } = require('node:child_process');\n`
      + `const child = spawn(process.execPath, [${JSON.stringify(descendantScript)}], { stdio: 'ignore' });\n`
      + `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n`
      + `setTimeout(() => {}, 120_000);\n`,
    );

    try {
      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'feature/start-command-tree-timeout',
        worktreeName: 'start-command-tree-timeout',
        returnAfterDirectoryCreated: true,
        startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(spawnerScript)}`,
      });

      const deadline = Date.now() + 15_000;
      while ((await getWorktreeBootstrapStatus(created.path)).phase !== 'setup-ready' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect((await getWorktreeBootstrapStatus(created.path)).phase).toBe('setup-ready');

      const descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(Number.isInteger(descendantPid)).toBe(true);
      const isAlive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const killDeadline = Date.now() + 5_000;
      while (isAlive(descendantPid) && Date.now() < killDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(isAlive(descendantPid)).toBe(false);
    } finally {
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      if (previousTimeout === undefined) delete process.env.OPENCHAMBER_WORKTREE_START_COMMAND_TIMEOUT_MS;
      else process.env.OPENCHAMBER_WORKTREE_START_COMMAND_TIMEOUT_MS = previousTimeout;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('VS Code worktree start-command timeout reader bound (#1064)', () => {
  it('pins the clamp on the source text, mirroring the web reader', () => {
    const source = fs.readFileSync(new URL('./gitService.ts', import.meta.url), 'utf8');
    expect(source).toContain('Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647');
  });

  it('falls back to the default for oversize values instead of overflowing the timer to ~1 ms', async () => {
    if (process.platform === 'win32') return;
    for (const oversize of ['3000000000', '9007199254740993']) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-start-oversize-'));
      const previousXdgDataHome = process.env.XDG_DATA_HOME;
      const previousTimeout = process.env.OPENCHAMBER_WORKTREE_START_COMMAND_TIMEOUT_MS;
      process.env.XDG_DATA_HOME = path.join(scratch, 'data');
      process.env.OPENCHAMBER_WORKTREE_START_COMMAND_TIMEOUT_MS = oversize;
      const repository = path.join(scratch, 'repo');
      fs.mkdirSync(repository, { recursive: true });
      runGit(repository, ['init', '-b', 'main']);
      runGit(repository, ['config', 'user.email', 'test@example.com']);
      runGit(repository, ['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
      runGit(repository, ['add', 'README.md']);
      runGit(repository, ['commit', '-m', 'init']);
      const slowScript = path.join(scratch, 'slow.cjs');
      fs.writeFileSync(slowScript, "setTimeout(() => { require('node:fs').writeFileSync('DONE_RAN', process.cwd()); }, 1500);\n");

      try {
        const created = await createWorktree(repository, {
          mode: 'new',
          branchName: `feature/start-command-oversize-${oversize}`,
          worktreeName: `start-command-oversize-${oversize}`,
          returnAfterDirectoryCreated: true,
          startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(slowScript)}`,
        });

        const deadline = Date.now() + 15_000;
        while ((await getWorktreeBootstrapStatus(created.path)).phase !== 'setup-ready' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect((await getWorktreeBootstrapStatus(created.path)).phase).toBe('setup-ready');
        // With the pre-fix reader the oversize value overflowed the timer
        // to ~1 ms and the command was killed before it could finish.
        expect(fs.existsSync(path.join(created.path, 'DONE_RAN'))).toBe(true);
      } finally {
        if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousXdgDataHome;
        if (previousTimeout === undefined) delete process.env.OPENCHAMBER_WORKTREE_START_COMMAND_TIMEOUT_MS;
        else process.env.OPENCHAMBER_WORKTREE_START_COMMAND_TIMEOUT_MS = previousTimeout;
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
