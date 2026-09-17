import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createShellEnvironmentLoader } from './shell-environment.mjs';

test('concurrent callers await one complete environment and later calls reuse it', async () => {
  let complete;
  let calls = 0;
  const load = createShellEnvironmentLoader({
    platform: 'darwin',
    env: { SHELL: '/bin/zsh' },
    execute: (file, args, options) => {
      calls++;
      assert.equal(file, '/bin/zsh');
      assert.deepEqual(args, ['-il', '-c', 'env -0']);
      assert.equal(options.timeout, 5000);
      assert.equal(options.windowsHide, true);
      return new Promise(resolve => { complete = resolve; });
    },
  });
  const first = load();
  const second = load();
  assert.equal(first, second);
  complete({ stdout: Buffer.from('PATH=/shell/bin\0VALUE=a=b\nsecond line\0EMPTY=\0invalid\0=invalid\0') });
  const result = await first;
  assert.deepEqual(result, { PATH: '/shell/bin', VALUE: 'a=b\nsecond line', EMPTY: '' });
  assert.equal(await second, result);
  assert.equal(await load(), result);
  assert.equal(calls, 1);
});

for (const failure of ['error', 'empty']) {
  test(`falls back to login-only after ${failure}, keeping callers pending`, async () => {
    const modes = [];
    const load = createShellEnvironmentLoader({
      platform: 'linux', env: { SHELL: '/bin/bash' },
      execute: async (_file, args) => {
        modes.push(args[0]);
        if (args[0] === '-il') {
          if (failure === 'error') throw new Error('Failed shell');
          return { stdout: Buffer.from('') };
        }
        return { stdout: Buffer.from('OPENCHAMBER_SKIP_LOCAL_SERVER=1\0') };
      },
    });
    const [first, second] = await Promise.all([load(), load()]);
    assert.deepEqual(first, { OPENCHAMBER_SKIP_LOCAL_SERVER: '1' });
    assert.equal(first, second);
    assert.deepEqual(modes, ['-il', '-l']);
  });
}

test('caches total failure rather than probing on each startup call', async () => {
  let calls = 0;
  const load = createShellEnvironmentLoader({
    platform: 'linux', env: {},
    execute: async file => {
      assert.equal(file, '/bin/sh');
      calls++;
      throw new Error('Unavailable');
    },
  });
  assert.equal(await load(), null);
  assert.equal(await load(), null);
  assert.equal(calls, 2);
});

test('skips unsupported Nushell without launching a probe', async () => {
  for (const shell of ['/usr/bin/nu', '/usr/bin/nu.exe']) {
    const load = createShellEnvironmentLoader({
      platform: 'linux', env: { SHELL: shell },
      execute: () => assert.fail('Nushell must not receive POSIX shell flags'),
    });
    assert.equal(await load(), null);
  }
});

test('retains the Windows environment loader and caches its result', async () => {
  let calls = 0;
  const load = createShellEnvironmentLoader({
    platform: 'win32',
    loadWindowsEnv: () => { calls++; return { PATH: 'C:\\tools' }; },
    execute: () => assert.fail('Windows must not launch a login shell'),
  });
  assert.deepEqual(await load(), { PATH: 'C:\\tools' });
  await load();
  assert.equal(calls, 1);
});

const withShell = async (t, script) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-shell-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const shell = path.join(directory, 'shell');
  await writeFile(shell, '#!/bin/sh\n' + script, { mode: 0o700 });
  return shell;
};

test('real slow shell leaves the event loop responsive and stdin closed', { skip: process.platform === 'win32' }, async t => {
  const shell = await withShell(t, 'read ignored && exit 1\n/bin/sleep 0.2\nprintf "READY=yes\\0"\n');
  const load = createShellEnvironmentLoader({ env: { SHELL: shell } });
  let finished = false;
  const pending = load().then(result => { finished = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finished, false, 'a timer must run while the shell is still working');
  assert.deepEqual(await pending, { READY: 'yes' });
});

test('real probe timeout kills the attempt and falls back', { skip: process.platform === 'win32' }, async t => {
  const shell = await withShell(t, 'if [ "$1" = "-il" ]; then exec /bin/sleep 10; fi\nprintf "FALLBACK=yes\\0"\n');
  const load = createShellEnvironmentLoader({ env: { SHELL: shell }, timeoutMs: 100 });
  assert.deepEqual(await load(), { FALLBACK: 'yes' });
});

test('real probe failure falls back without accepting partial output', { skip: process.platform === 'win32' }, async t => {
  const shell = await withShell(t, 'if [ "$1" = "-il" ]; then printf "PARTIAL=no\\0"; exit 1; fi\nprintf "COMPLETE=yes\\0"\n');
  const load = createShellEnvironmentLoader({ env: { SHELL: shell } });
  assert.deepEqual(await load(), { COMPLETE: 'yes' });
});

test('ignores verbose shell stderr without losing the environment', { skip: process.platform === 'win32' }, async t => {
  const shell = await withShell(t, `exec "${process.execPath}" -e 'process.stderr.write("x".repeat(2 * 1024 * 1024)); process.stdout.write("READY=yes\\0")'\n`);
  const load = createShellEnvironmentLoader({ env: { SHELL: shell } });
  assert.deepEqual(await load(), { READY: 'yes' });
});

test('bounds stdout and falls back instead of accepting truncated environment', { skip: process.platform === 'win32' }, async t => {
  const shell = await withShell(t, `if [ "$1" = "-il" ]; then exec "${process.execPath}" -e 'process.stdout.write("KEY=" + "x".repeat(2 * 1024 * 1024))'; fi\nprintf "FALLBACK=yes\\0"\n`);
  const load = createShellEnvironmentLoader({ env: { SHELL: shell } });
  assert.deepEqual(await load(), { FALLBACK: 'yes' });
});

test('cancellation before startup launches no shell', async () => {
  const controller = new AbortController();
  controller.abort();
  const load = createShellEnvironmentLoader({
    platform: 'linux', signal: controller.signal,
    execute: () => assert.fail('Canceled startup must not spawn'),
  });
  await assert.rejects(load(), { name: 'AbortError' });
});

test('quit cancels a real in-flight shell, waits for exit and skips fallback', { skip: process.platform === 'win32' }, async t => {
  const shell = await withShell(t, 'printf "%s" "$$" > "$0.pid"\nexec /bin/sleep 10\n');
  const controller = new AbortController();
  const load = createShellEnvironmentLoader({ env: { SHELL: shell }, signal: controller.signal });
  const pending = load();
  let pid;
  for (let attempt = 0; attempt < 100; attempt++) {
    const text = await readFile(shell + '.pid', 'utf8').catch(() => '');
    if (text) { pid = Number(text); break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid, 'probe process must have started');
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(load(), { name: 'AbortError' });
});
