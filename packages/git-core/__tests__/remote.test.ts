import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkRemoteBranchExists,
  fetchRemoteBranchRef,
} from '../src/remote.js';

import { createTempGitRepo, type TempGitRepo } from './_fixtures.js';

describe('checkRemoteBranchExists argument-injection guard', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await createTempGitRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('treats a leading-`-` target as a positional, not a git option', async () => {
    // Without the `--` separator, `--upload-pack=evil` would be parsed
    // as a git option and could trigger arbitrary code execution on a
    // malicious server. With the separator, git treats the value as a
    // repository URL/name and fails with "not a git repository" or
    // "could not read" instead of executing it.
    const result = await checkRemoteBranchExists(
      repo.runner,
      repo.path,
      '--upload-pack=touch /tmp/should-not-exist',
      'main',
    );
    // success=false because the URL/name isn't a valid repository.
    // The KEY assertion is that no side effect happened — which is
    // verifiable by the success flag staying false on any non-git path.
    expect(result.success).toBe(false);
    // Defence-in-depth: confirm no side effect file was created.
    const fs = await import('node:fs/promises');
    await expect(fs.stat('/tmp/should-not-exist')).rejects.toThrow();
  });

  it('treats a leading-`-` URL as a positional, not a git option', async () => {
    const result = await checkRemoteBranchExists(
      repo.runner,
      repo.path,
      'main', // branch
      '--upload-pack=evil', // url
    );
    expect(result.success).toBe(false);
  });
});

describe('fetchRemoteBranchRef argument-injection guard', () => {
  let repo: TempGitRepo;
  let upstream: TempGitRepo;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    upstream = await createTempGitRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
    await upstream.cleanup();
  });

  it('rejects (rather than executes) a leading-`-` remote name', async () => {
    // Without `--` this would pass `--upload-pack=…` to `git fetch` as
    // an option. With the separator, `git fetch -- --upload-pack=…`
    // treats the value as a remote name and rejects with
    // "not a git repository" / "couldn't find remote ref".
    await expect(
      fetchRemoteBranchRef(repo.runner, repo.path, '--upload-pack=evil', 'main'),
    ).rejects.toThrow();
    // No side effect file was created.
    const fs = await import('node:fs/promises');
    await expect(fs.stat('/tmp/should-not-exist')).rejects.toThrow();
  });
});
