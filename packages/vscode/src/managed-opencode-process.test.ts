import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnManagedOpenCodeProcess } from './managed-opencode-process';

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const readPids = async (marker: string) => (await fs.readFile(marker, 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(Number);

for (const mode of ['timeout', 'malformed', 'abort', 'ready', 'ready-stdio']) {
  test(`managed ${mode} reaps parent and SIGTERM-resistant descendant`, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-managed-'));
    const marker = path.join(cwd, 'pids');
    const registry = path.join(cwd, 'registry');
    const previous = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = registry;
    const descendant = `process.on('SIGTERM', () => {}); require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n'); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    let message = '';
    // OpenCode 2.x prints the line without the `opencode ` prefix.
    if (mode === 'malformed') message = 'server listening without URL\n';
    if (mode === 'ready') message = 'server listening on http://127.0.0.1:45678\n';
    // `serve --stdio`, used on Windows, prints only the URL as JSON.
    if (mode === 'ready-stdio') message = '{"url":"http://127.0.0.1:45678"}\n';
    const script = `
      require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n');
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', () => process.stdout.write(${JSON.stringify(message)}));
      setInterval(() => {}, 1000);
    `;
    const controller = new AbortController();
    const server = spawnManagedOpenCodeProcess(process.execPath, ['-e', script], {
      cwd, env: process.env, port: 45678, timeoutMs: 1500,
      signal: controller.signal, sourceBinary: process.execPath, appBundleHint: '',
    });
    const result = server.ready.then(() => null, (error: Error) => error);
    try {
      let pids: number[] = [];
      for (let attempt = 0; attempt < 150; attempt++) {
        pids = await readPids(marker);
        if (pids.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(pids.length, 2, 'both fixture processes must run');
      if (mode === 'abort' || mode === 'timeout') {
        assert.equal(server.url, null);
        assert.ok(await fs.stat(path.join(registry, `${pids[0]}.json`)), 'ownership must exist before readiness');
      }
      if (mode === 'abort') controller.abort();
      const error = await result;
      if (mode === 'ready' || mode === 'ready-stdio') {
        assert.equal(error, null);
        assert.equal(server.url, 'http://127.0.0.1:45678');
        await Promise.all([server.close(), server.close()]);
      } else {
        assert.ok(error);
      }
      for (let attempt = 0; attempt < 100 && pids.some(alive); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(pids.filter(alive), []);
      assert.deepEqual(await fs.readdir(registry), []);
    } finally {
      await server.close().catch(() => {});
      for (const pid of await readPids(marker)) if (alive(pid)) process.kill(pid, 'SIGKILL');
      if (previous === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
      else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previous;
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
}

for (const split of [1, 2]) {
  test(`managed split multi-byte character (byte ${split} of 3) survives in captured startup output`, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-managed-split-'));
    const registry = path.join(cwd, 'registry');
    const previous = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = registry;
    // 'diag boot \u20ac ready\n' as bytes, split inside the 3-byte euro sign:
    // the two writes land as separate pipe chunks, so a per-chunk
    // chunk.toString() decode corrupts the character to U+FFFD. Oracle: the
    // unsplit control string in the timeout error's quoted Output.
    const payload = Buffer.from('diag boot \u20ac ready\n', 'utf8');
    const cut = Buffer.from('diag boot ', 'utf8').length + split;
    const script = `
      process.stdout.write(Buffer.from([${[...payload.subarray(0, cut)].join(',')}]));
      setTimeout(() => {
        process.stdout.write(Buffer.from([${[...payload.subarray(cut)].join(',')}]));
        setInterval(() => {}, 1000);
      }, 100);
    `;
    const controller = new AbortController();
    const server = spawnManagedOpenCodeProcess(process.execPath, ['-e', script], {
      cwd, env: process.env, port: 45678, timeoutMs: 1500,
      signal: controller.signal, sourceBinary: process.execPath, appBundleHint: '',
    });
    try {
      const error = await server.ready.then(() => null, (caught: Error) => caught);
      assert.ok(error);
      assert.ok(error.message.includes('diag boot \u20ac ready'), `captured output must contain the intact character, got: ${error.message}`);
      assert.ok(!error.message.includes('\ufffd'), `captured output must not contain U+FFFD, got: ${error.message}`);
    } finally {
      await server.close().catch(() => {});
      if (previous === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
      else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previous;
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
}
