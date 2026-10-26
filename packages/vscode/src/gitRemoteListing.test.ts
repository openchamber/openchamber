import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGitRemoteListing } from './gitRemoteListing';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('parses fetch and push URLs per remote', () => {
  const listing = [
    'origin\tgit@github.com:owner/repo.git (fetch)',
    'origin\tgit@github.com:owner/push.git (push)',
    'mirror\thttps://example.com/repo.git (fetch)',
    'mirror\thttps://example.com/repo.git (push)',
    '',
  ].join('\n');
  assert.deepEqual(parseGitRemoteListing(listing), [
    { name: 'origin', fetchUrl: 'git@github.com:owner/repo.git', pushUrl: 'git@github.com:owner/push.git' },
    { name: 'mirror', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' },
  ]);
});

test('reads CRLF output as Git for Windows may print it, URLs with spaces included', () => {
  const listing = [
    'origin\tgit@github.com:owner/repo.git (fetch)',
    'origin\tgit@github.com:owner/push.git (push)',
    'mirror\thttps://example.com/a b.git (fetch)',
    'mirror\thttps://example.com/a b.git (push)',
    'bare\t',
    '',
  ].join('\r\n');
  // A remote with no URL stays omitted, as before the extraction.
  assert.deepEqual(parseGitRemoteListing(listing), [
    { name: 'origin', fetchUrl: 'git@github.com:owner/repo.git', pushUrl: 'git@github.com:owner/push.git' },
    { name: 'mirror', fetchUrl: 'https://example.com/a b.git', pushUrl: 'https://example.com/a b.git' },
  ]);
});

test('ignores decoration after the listing kind, recognized or not (#4479)', () => {
  // Git only annotates the fetch line in practice; the parser ignores
  // whatever follows the marker so it does not depend on the annotation's
  // exact shape.
  const listing = [
    'origin\tgit@github.com:owner/repo.git (fetch) [blob:none]',
    'origin\tgit@github.com:owner/repo.git (push)',
    'mirror\thttps://example.com/repo.git (fetch) [blob:limit=1m] [tree:1]',
    'mirror\thttps://example.com/repo.git (push) [blob:none]',
    'future\thttps://example.com/f.git (fetch) [blob:none] (extra)',
    'future\thttps://example.com/f.git (push)',
  ].join('\n');
  assert.deepEqual(parseGitRemoteListing(listing), [
    { name: 'origin', fetchUrl: 'git@github.com:owner/repo.git', pushUrl: 'git@github.com:owner/repo.git' },
    { name: 'mirror', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' },
    { name: 'future', fetchUrl: 'https://example.com/f.git', pushUrl: 'https://example.com/f.git' },
  ]);
});

test('reports URLs as `git remote get-url [--push]` does when lines are missing or repeated', () => {
  // Shapes verified against git 2.54: a pushurl-only remote prints a bare
  // name line for fetch and `get-url` answers with the remote's name; with
  // several push URLs `get-url --push` reports the first.
  const listing = [
    'bare\t',
    'pushonly\t/tmp/x/second.git (push)',
    'multi\t/tmp/x/first.git (fetch)',
    'multi\t/tmp/x/second.git (push)',
    'multi\t/tmp/x/third.git (push)',
  ].join('\n');
  // `bare` has no URL and no URL kind, so it stays omitted, as before.
  assert.deepEqual(parseGitRemoteListing(listing), [
    { name: 'pushonly', fetchUrl: 'pushonly', pushUrl: '/tmp/x/second.git' },
    { name: 'multi', fetchUrl: '/tmp/x/first.git', pushUrl: '/tmp/x/second.git' },
  ]);
});

test('reads a partial-clone remote as `git remote get-url` reports it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-remote-listing-'));
  try {
    git(dir, ['init', '-b', 'main']);
    git(dir, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
    // Git 2.54+ annotates the fetch line of `git remote -v` with the filter:
    // `... (fetch) [blob:none]`. Setting just the config key is enough.
    git(dir, ['config', 'remote.origin.partialclonefilter', 'blob:none']);

    const stdout = git(dir, ['remote', '-v']);
    const fetchUrl = git(dir, ['remote', 'get-url', 'origin']).trim();

    assert.deepEqual(parseGitRemoteListing(stdout), [
      { name: 'origin', fetchUrl, pushUrl: fetchUrl },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
