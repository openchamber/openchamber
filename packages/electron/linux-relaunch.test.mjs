import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { relaunchAfterExit } from './linux-relaunch.mjs';

const waitFor = async (check, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

const exists = (file) => fs.access(file).then(() => true, () => false);

test('starts the command only after the old process exits, with its arguments intact', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-relaunch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'started');
  const old = spawn('/bin/sh', ['-c', 'read _'], { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => old.kill());

  relaunchAfterExit({
    pid: old.pid,
    command: ['/bin/sh', '-c', 'printf "%s" "$1" > "$0"', marker, 'arg with "quotes" and $HOME'],
  });

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await exists(marker), false);

  old.stdin.end();
  assert.equal(await waitFor(() => exists(marker)), true);
  assert.equal(await fs.readFile(marker, 'utf8'), 'arg with "quotes" and $HOME');
});
