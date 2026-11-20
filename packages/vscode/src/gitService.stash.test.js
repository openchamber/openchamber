import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { handleStandardGitBridgeMessage } = await import('./bridge-git-runtime');
const tempDirs = [];
const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code stash file counts', () => {
  it.each([
    { name: 'only untracked', tracked: false, untracked: true, staged: false, count: 1 },
    { name: 'tracked and untracked', tracked: true, untracked: true, staged: false, count: 2 },
    { name: 'only tracked', tracked: true, untracked: false, staged: false, count: 1 },
    { name: 'a staged new file', tracked: false, untracked: false, staged: true, count: 1 },
  ])('counts stash files with $name', async ({ tracked, untracked, staged, count }) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-stash-'));
    tempDirs.push(repo);
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\n');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    if (tracked) fs.writeFileSync(path.join(repo, 'tracked.txt'), 'modified\n');
    if (untracked) fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
    if (staged) {
      fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
      runGit(repo, ['add', 'staged.txt']);
    }

    const call = (type, payload = {}) => handleStandardGitBridgeMessage({ id: '1', type, payload: { directory: repo, ...payload } });
    expect((await call('api:git/stash', { message: 'count test' })).success).toBe(true);
    const listing = await call('api:git/stashes');
    const [stash] = listing.data.stashes;
    const response = await call('api:git/stashes/file-counts', { refs: [stash.ref, stash.ref, stash.hash] });
    expect(response.success).toBe(true);
    expect(response.data.counts).toEqual({ [stash.ref]: count, [stash.hash]: count });
    expect((await call('api:git/stash/apply', { ref: stash.ref })).success).toBe(true);
    if (tracked) expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('modified\n');
    if (untracked) expect(fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf8')).toBe('new\n');
    if (staged) expect(runGit(repo, ['diff', '--cached', '--name-only']).trim()).toBe('staged.txt');
  });
});
