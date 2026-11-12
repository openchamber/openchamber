import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { createWorktree, previewWorktreeCreate, removeWorktree } = await import('./gitService.ts');
const tempDirs = [];
const previousConfig = process.env.OPENCODE_CONFIG;
const previousDataHome = process.env.XDG_DATA_HOME;

const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const createWorkspace = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-worktree-config-'));
  tempDirs.push(root);
  const repo = path.join(root, 'repository');
  fs.mkdirSync(repo);
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.email', 'test@example.com']);
  runGit(repo, ['config', 'user.name', 'Test']);
  runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
  fs.mkdirSync(path.join(root, '.opencode'));
  const configPath = path.join(root, '.opencode', 'opencode.jsonc');
  fs.writeFileSync(configPath, '{ "worktree": { "directory": "../trees" } }');
  const custom = path.join(root, 'custom.json');
  fs.writeFileSync(custom, '{ "worktree": { "directory": ".custom-trees" } }');
  process.env.OPENCODE_CONFIG = custom;
  process.env.XDG_DATA_HOME = path.join(root, 'data');
  return { root, repo, configPath };
};

afterEach(() => {
  if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = previousConfig;
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('VS Code worktree ancestor configuration', () => {
  it('previews and creates in the inherited folder, including from a linked checkout', async () => {
    const { root, repo } = createWorkspace();
    const input = { mode: 'new', worktreeName: 'inherited', branchName: 'inherited' };
    const preview = await previewWorktreeCreate(repo, input);
    const created = await createWorktree(repo, input);
    const expected = path.join(fs.realpathSync(root), 'trees', 'inherited');
    expect(preview.path).toBe(expected);
    expect(created.path).toBe(expected);

    const next = await createWorktree(created.path, { mode: 'new', worktreeName: 'next', branchName: 'next' });
    expect(next.path).toBe(path.join(fs.realpathSync(root), 'trees', 'next'));
    await removeWorktree(repo, { directory: next.path });
    await removeWorktree(repo, { directory: created.path });
  }, 30_000);

  it('refuses creation when the inherited config is invalid', async () => {
    const { root, repo, configPath } = createWorkspace();
    fs.writeFileSync(configPath, '{ "worktree": ');
    await expect(createWorktree(repo, { mode: 'new', worktreeName: 'invalid', branchName: 'invalid' }))
      .rejects.toThrow(/invalid JSONC/);
    expect(fs.existsSync(path.join(root, 'trees'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.custom-trees'))).toBe(false);
  }, 30_000);
});
