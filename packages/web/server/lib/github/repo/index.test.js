import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

const { parseGitHubRemoteUrl, resolveGitHubRepoFromDirectory } = await import('./index.js');

// resolveGitHubRepoFromDirectory reads the remote via the real git binary, so
// these cases build an actual checkout (init + remote add) and assert on the
// host parsed out of it — the same path the PR routes use at runtime.

const tempDirs = [];

const createCheckout = (remoteUrl, remoteName = 'origin') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-test-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', remoteName, remoteUrl], { cwd: dir, stdio: 'ignore' });
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseGitHubRemoteUrl', () => {
  test('parses an scp-style github.com remote', () => {
    expect(parseGitHubRemoteUrl('git@github.com:octocat/hello.git')).toEqual({
      owner: 'octocat',
      repo: 'hello',
      host: 'github.com',
      url: 'https://github.com/octocat/hello',
    });
  });

  test('parses an scp-style remote for a non-github.com host', () => {
    expect(parseGitHubRemoteUrl('git@github.example.com:octocat/hello.git')).toEqual({
      owner: 'octocat',
      repo: 'hello',
      host: 'github.example.com',
      url: 'https://github.example.com/octocat/hello',
    });
  });

  test('parses an ssh:// remote for a non-github.com host', () => {
    expect(parseGitHubRemoteUrl('ssh://git@github.example.com/octocat/hello.git')).toEqual({
      owner: 'octocat',
      repo: 'hello',
      host: 'github.example.com',
      url: 'https://github.example.com/octocat/hello',
    });
  });

  test('parses an https remote for a non-github.com host', () => {
    expect(parseGitHubRemoteUrl('https://github.example.com/octocat/hello.git')).toEqual({
      owner: 'octocat',
      repo: 'hello',
      host: 'github.example.com',
      url: 'https://github.example.com/octocat/hello',
    });
  });

  test('keeps github.com behavior unchanged (https, no .git suffix)', () => {
    expect(parseGitHubRemoteUrl('https://github.com/octocat/hello')).toEqual({
      owner: 'octocat',
      repo: 'hello',
      host: 'github.com',
      url: 'https://github.com/octocat/hello',
    });
  });

  test('returns null for missing owner or repo', () => {
    expect(parseGitHubRemoteUrl('https://github.example.com/octocat')).toBeNull();
    expect(parseGitHubRemoteUrl('git@github.example.com:octocat')).toBeNull();
  });

  test('returns null for non-string, empty, or malformed inputs', () => {
    expect(parseGitHubRemoteUrl(null)).toBeNull();
    expect(parseGitHubRemoteUrl(123)).toBeNull();
    expect(parseGitHubRemoteUrl('')).toBeNull();
    expect(parseGitHubRemoteUrl('   ')).toBeNull();
    expect(parseGitHubRemoteUrl('git@github.example.com')).toBeNull();
  });
});

describe('resolveGitHubRepoFromDirectory', () => {
  test('derives the host from a github.com https remote', async () => {
    const dir = createCheckout('https://github.com/octocat/hello.git');

    const result = await resolveGitHubRepoFromDirectory(dir);
    expect(result).toEqual({
      repo: {
        owner: 'octocat',
        repo: 'hello',
        host: 'github.com',
        url: 'https://github.com/octocat/hello',
      },
      remoteUrl: 'https://github.com/octocat/hello.git',
    });
  });

  test('derives the host from an enterprise https remote', async () => {
    const dir = createCheckout('https://github.example.com/acme/app.git');

    const result = await resolveGitHubRepoFromDirectory(dir);
    expect(result.repo).toEqual({
      owner: 'acme',
      repo: 'app',
      host: 'github.example.com',
      url: 'https://github.example.com/acme/app',
    });
  });

  test('derives the host from a named remote', async () => {
    const dir = createCheckout('git@github.example.com:acme/app.git', 'upstream');

    const result = await resolveGitHubRepoFromDirectory(dir, 'upstream');
    expect(result.repo).toEqual(expect.objectContaining({ owner: 'acme', repo: 'app', host: 'github.example.com' }));
  });

  test('reports an unresolvable remote as null rather than throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-test-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });

    const result = await resolveGitHubRepoFromDirectory(dir);
    expect(result).toEqual({ repo: null, remoteUrl: null });
  });
});
