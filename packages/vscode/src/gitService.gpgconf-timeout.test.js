import { describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { checkIsGitRepository } = await import('./gitService.ts?gpgconf-timeout-test');

describe('gpgconf probe timeout (#862)', () => {
  it('settles a git operation in bounded time when gpgconf hangs', async () => {
    if (process.platform === 'win32') return;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-gpgconf-'));
    const repo = path.join(scratch, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    const binDir = path.join(scratch, 'bin');
    fs.mkdirSync(binDir);
    const fake = path.join(binDir, 'gpgconf');
    fs.writeFileSync(fake, '#!/bin/sh\nexec sleep 120\n');
    fs.chmodSync(fake, 0o755);
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home);
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    const previousSock = process.env.SSH_AUTH_SOCK;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;
    process.env.HOME = home;
    delete process.env.SSH_AUTH_SOCK;
    try {
      const startedAt = Date.now();
      await expect(checkIsGitRepository(repo)).resolves.toBe(true);
      // The probe bound is 5s per resolve; without it this call would
      // wait out the fake's 120s sleep.
      expect(Date.now() - startedAt).toBeLessThan(30_000);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousSock === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = previousSock;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
