import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';

import { resolveBaseRefForLog, stageFiles, unstageFiles, checkoutCommit } from './service.js';

async function createTempRepo() {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-test-'));
  const git = simpleGit(tmpDir);
  await git.init();
  await git.addConfig('user.name', 'Test User', false, 'local');
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  return { tmpDir, git };
}

async function cleanupTempRepo(tmpDir) {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
}

describe('resolveBaseRefForLog', () => {
  it('returns the local ref unchanged when it exists, even if origin also exists', async () => {
    // Both local 'main' and 'refs/remotes/origin/main' are present.
    // The local ref takes precedence — callers that ask for 'main' get 'main'.
    const checkRef = async (ref) => ref === 'main' || ref === 'refs/remotes/origin/main';
    expect(await resolveBaseRefForLog('main', checkRef)).toBe('main');
  });

  it('falls back to origin/<from> when local ref cannot be resolved but origin can', async () => {
    // Local 'main' is absent (e.g. user never checked it out), but origin/main exists.
    const checkRef = async (ref) => ref === 'refs/remotes/origin/main';
    expect(await resolveBaseRefForLog('main', checkRef)).toBe('origin/main');
  });

  it('returns the original ref when neither local nor origin ref can be resolved', async () => {
    // Neither ref exists; return as-is so git surfaces a meaningful error.
    const checkRef = async () => false;
    expect(await resolveBaseRefForLog('nonexistent-branch', checkRef)).toBe('nonexistent-branch');
  });

  it('returns undefined when from is undefined', async () => {
    const checkRef = async () => true;
    expect(await resolveBaseRefForLog(undefined, checkRef)).toBeUndefined();
  });

  it('returns undefined when from is an empty string', async () => {
    const checkRef = async () => true;
    expect(await resolveBaseRefForLog('', checkRef)).toBeUndefined();
  });

  it('returns undefined when from is a whitespace-only string', async () => {
    const checkRef = async () => true;
    expect(await resolveBaseRefForLog('   ', checkRef)).toBeUndefined();
  });
});

describe('git index path validation', () => {
  it('rejects stage paths outside the repository before invoking git', async () => {
    await expect(stageFiles('/repo', ['../secret.txt'])).rejects.toThrow('Path is outside repository: ../secret.txt');
  });

  it('rejects unstage paths outside the repository before invoking git', async () => {
    await expect(unstageFiles('/repo', ['../secret.txt'])).rejects.toThrow('Path is outside repository: ../secret.txt');
  });
});

describe('checkoutCommit', () => {
  it('checks out a valid commit and puts the repo in detached HEAD state', async () => {
    const { tmpDir, git } = await createTempRepo();
    try {
      const filePath = path.join(tmpDir, 'file.txt');
      await fs.promises.writeFile(filePath, 'first', 'utf8');
      await git.add('file.txt');
      const firstCommit = await git.commit('First commit');

      await fs.promises.writeFile(filePath, 'second', 'utf8');
      await git.add('file.txt');
      await git.commit('Second commit');

      const result = await checkoutCommit(tmpDir, firstCommit.commit);
      expect(result).toEqual({ success: true });

      const status = await git.status();
      expect(status.detached).toBe(true);
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });

  it('throws an error for an invalid/nonexistent hash', async () => {
    const { tmpDir } = await createTempRepo();
    try {
      await expect(checkoutCommit(tmpDir, 'invalidhash123')).rejects.toThrow();
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });
});
