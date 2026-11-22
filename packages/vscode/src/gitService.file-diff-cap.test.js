import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let currentRepoDir = null;
let statCalls = 0;
let readFileCalls = 0;
let readFileOverride = null;

const fakeRepository = {
  show: async (ref, filePath) => {
    const spec = ref === 'HEAD' ? `HEAD:${filePath}` : `:${filePath}`;
    return execFileSync('git', ['show', spec], { cwd: currentRepoDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  },
};

mock.module('vscode', () => ({
  extensions: {
    getExtension: () => ({
      isActive: true,
      exports: {
        enabled: true,
        getAPI: () => ({
          git: { path: 'git' },
          getRepository: () => fakeRepository,
          openRepository: async () => fakeRepository,
        }),
        onDidChangeEnablement: () => {},
      },
    }),
  },
  Uri: { file: (fsPath) => ({ fsPath }) },
  workspace: {
    fs: {
      stat: async (uri) => {
        statCalls += 1;
        const stat = await fs.promises.stat(uri.fsPath);
        return { type: 1, ctime: 0, mtime: 0, size: stat.size };
      },
      readFile: async (uri) => {
        readFileCalls += 1;
        if (readFileOverride) return readFileOverride;
        return fs.promises.readFile(uri.fsPath);
      },
    },
  },
}));

const { getGitFileDiff, MAX_FILE_DIFF_WORKING_TREE_BYTES } = await import('./gitService.ts?file-diff-cap-test');

const tempDirs = [];
const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const makeRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-file-diff-cap-'));
  tempDirs.push(dir);
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'original line\n');
  runGit(dir, ['add', 'file.txt']);
  runGit(dir, ['commit', '-m', 'init']);
  currentRepoDir = dir;
  statCalls = 0;
  readFileCalls = 0;
  readFileOverride = null;
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  currentRepoDir = null;
  readFileOverride = null;
});

describe('VS Code getGitFileDiff working-tree size cap (#1057)', () => {
  it('answers file_too_large for an over-cap file without reading its content', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'file.txt'), Buffer.alloc(MAX_FILE_DIFF_WORKING_TREE_BYTES + 1, 0x78));

    const result = await getGitFileDiff(dir, 'file.txt', false);

    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('file_too_large');
    expect(result.message).toContain('20 MiB');
    expect(readFileCalls).toBe(0);
    expect(statCalls).toBe(1);
  });

  it('rejects content that grows past the cap between the stat and the read', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'file.txt'), 'small edit\n');
    readFileOverride = new Uint8Array(MAX_FILE_DIFF_WORKING_TREE_BYTES + 1).fill(0x78);

    const result = await getGitFileDiff(dir, 'file.txt', false);

    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('file_too_large');
    expect(readFileCalls).toBe(1);
  });

  it('still diffs a file at exactly the cap', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x'.repeat(MAX_FILE_DIFF_WORKING_TREE_BYTES));

    const result = await getGitFileDiff(dir, 'file.txt', false);

    expect(result.kind).toBe('file-diff');
    expect(result.original).toBe('original line\n');
    expect(result.modified.length).toBe(MAX_FILE_DIFF_WORKING_TREE_BYTES);
    expect(readFileCalls).toBe(1);
  });

  it('keeps small-file diffs unchanged', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'file.txt'), 'changed line\n');

    const result = await getGitFileDiff(dir, 'file.txt', false);

    expect(result).toEqual({ kind: 'file-diff', original: 'original line\n', modified: 'changed line\n', path: 'file.txt', submodule: null });
  });

  it('answers file_too_large for an oversized untracked file', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'big-untracked.bin'), Buffer.alloc(MAX_FILE_DIFF_WORKING_TREE_BYTES + 1, 0x78));

    const result = await getGitFileDiff(dir, 'big-untracked.bin', false);

    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('file_too_large');
    expect(result.message).toContain('20 MiB');
    expect(readFileCalls).toBe(0);
  });

  it('falls through to the empty-diff fallback for a deleted file', async () => {
    const dir = makeRepo();
    fs.rmSync(path.join(dir, 'file.txt'));

    const result = await getGitFileDiff(dir, 'file.txt', false);

    expect(result.kind).toBe('file-diff');
    expect(result.modified).toBe('');
  });

  it('does not stat or read the working tree for a staged diff', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'file.txt'), 'staged line\n');
    runGit(dir, ['add', 'file.txt']);
    fs.writeFileSync(path.join(dir, 'file.txt'), Buffer.alloc(MAX_FILE_DIFF_WORKING_TREE_BYTES + 1, 0x78));

    const result = await getGitFileDiff(dir, 'file.txt', true);

    expect(result.kind).toBe('file-diff');
    expect(result.modified).toBe('staged line\n');
    expect(statCalls).toBe(0);
    expect(readFileCalls).toBe(0);
  });

  it('answers file_too_large for an over-cap index blob read as the original', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(MAX_FILE_DIFF_WORKING_TREE_BYTES + 1));
    runGit(dir, ['add', 'big.txt']);
    runGit(dir, ['commit', '-m', 'big']);
    fs.writeFileSync(path.join(dir, 'big.txt'), 'small edit\n');

    const result = await getGitFileDiff(dir, 'big.txt', false);

    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('file_too_large');
  });

  it('answers file_too_large for an over-cap HEAD blob on a staged diff', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(MAX_FILE_DIFF_WORKING_TREE_BYTES + 1));
    runGit(dir, ['add', 'big.txt']);
    runGit(dir, ['commit', '-m', 'big']);
    fs.writeFileSync(path.join(dir, 'big.txt'), 'small edit\n');
    runGit(dir, ['add', 'big.txt']);

    const result = await getGitFileDiff(dir, 'big.txt', true);

    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('file_too_large');
  });

  it('still diffs a committed blob at exactly the cap', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(MAX_FILE_DIFF_WORKING_TREE_BYTES));
    runGit(dir, ['add', 'big.txt']);
    runGit(dir, ['commit', '-m', 'big']);
    fs.writeFileSync(path.join(dir, 'big.txt'), 'small edit\n');

    const result = await getGitFileDiff(dir, 'big.txt', false);

    expect(result.kind).toBe('file-diff');
    expect(result.original).toHaveLength(MAX_FILE_DIFF_WORKING_TREE_BYTES);
    expect(result.modified).toBe('small edit\n');
  });
});
