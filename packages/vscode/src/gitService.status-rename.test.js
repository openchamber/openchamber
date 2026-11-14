import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Starts without the VS Code Git extension (the raw-status fallback); a test
// installs a fake one to read through the Git API instead.
let gitExtension;
mock.module('vscode', () => ({
  extensions: { getExtension: () => gitExtension },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { handleStandardGitBridgeMessage } = await import('./bridge-git-runtime');

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-git-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const readStatus = async (directory) => {
  const response = await handleStandardGitBridgeMessage({ id: '1', type: 'api:git/status', payload: { directory } });
  expect(response?.success).toBe(true);
  return response.data;
};

describe('VS Code git status names a rename\'s source', () => {
  it('in the raw-status fallback, including names Git would quote', async () => {
    if (!canRunGit()) return;
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'old name.txt'), 'alpha\nbeta\n');
    fs.writeFileSync(path.join(repo, 'kept.txt'), 'kept\n');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-m', 'init']);
    runGit(repo, ['mv', 'old name.txt', 'new "name".txt']);
    fs.writeFileSync(path.join(repo, 'kept.txt'), 'kept, edited\n');

    const status = await readStatus(repo);

    expect(status.current).toBe('main');
    expect(status.files).toEqual([
      { path: 'kept.txt', index: ' ', working_dir: 'M' },
      { path: 'new "name".txt', index: 'R', working_dir: ' ', previousPath: 'old name.txt' },
    ]);
  });

  it('through the VS Code Git API', async () => {
    const root = createTempDir();
    const uri = (relativePath) => ({ fsPath: path.join(root, relativePath) });
    const repository = {
      rootUri: uri(''),
      state: {
        HEAD: { name: 'main' },
        indexChanges: [{ uri: uri('docs/guide.md'), originalUri: uri('docs/readme.md'), renameUri: uri('docs/guide.md'), status: 3 }],
        workingTreeChanges: [
          { uri: uri('docs/guide.md'), originalUri: uri('docs/guide.md'), renameUri: undefined, status: 5 },
          { uri: uri('src/app.ts'), originalUri: uri('src/app.ts'), renameUri: undefined, status: 5 },
        ],
      },
    };
    gitExtension = {
      isActive: true,
      exports: {
        enabled: true,
        onDidChangeEnablement: () => ({ dispose() {} }),
        getAPI: () => ({ git: { path: 'git' }, getRepository: () => repository, openRepository: async () => repository }),
      },
    };

    const status = await readStatus(root);

    expect(status.files).toEqual([
      { path: 'docs/guide.md', index: 'R', working_dir: 'M', previousPath: 'docs/readme.md' },
      { path: 'src/app.ts', index: ' ', working_dir: 'M' },
    ]);
  });
});
