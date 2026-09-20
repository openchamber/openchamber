import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOpenCodeLifecycleRuntime } from './lifecycle.js';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const createRuntime = (waitForReady, state) => createOpenCodeLifecycleRuntime({
  state,
  env: { ENV_CONFIGURED_OPENCODE_PORT: 45678, ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1' },
  syncToHmrState() {}, syncFromHmrState() {},
  ensureOpencodeCliEnv: () => process.execPath,
  applyOpencodeBinaryFromSettings: async () => {},
  ensureLocalOpenCodeServerPassword: async () => 'fixture-only',
  resolveManagedOpenCodeLaunchSpec: (binary) => ({ binary, args: [] }),
  normalizeApiPrefix: (value) => value,
  setOpenCodePort() {}, setDetectedOpenCodeApiPrefix() {},
  waitForReady,
  managedStartupTimeoutMs: 1500,
});

describe('managed process lifecycle with real children', () => {
  for (const failure of ['invalid-readiness', 'health-error', 'startup-timeout', 'shutdown-during-startup', 'none']) {
    it(`reaps the server and its child after ${failure}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-process-'));
      const previousRegistry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
      process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(root, 'registry');
      const marker = path.join(root, 'pids');
      const childScript = `process.on('SIGTERM', () => {}); require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n'); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
      let readinessMessage = 'opencode server listening on http://127.0.0.1:45678\n';
      if (failure === 'invalid-readiness') readinessMessage = 'opencode server listening without a URL\n';
      if (failure === 'startup-timeout' || failure === 'shutdown-during-startup') readinessMessage = '';
      // Node is an isolated stand-in for the native OpenCode binary. Lifecycle
      // still launches its real `serve --hostname ... --port ...` command.
      await fs.writeFile(path.join(root, 'serve'), `
        const fs = require('node:fs');
        fs.appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n');
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout.once('data', () => {
          process.stdout.write(${JSON.stringify(readinessMessage)});
        });
        setInterval(() => {}, 1000);
      `);
      try {
        const state = { openCodeWorkingDirectory: root, useWslForOpencode: false };
        const runtime = createRuntime(async () => {
          if (failure === 'health-error') throw new Error('fixture health failure');
          return true;
        }, state);
        if (failure === 'none') {
          const server = await runtime.startOpenCode();
          await Promise.all([server.close(), server.close()]);
        } else if (failure === 'shutdown-during-startup') {
          const starting = runtime.startOpenCode();
          const rejected = expect(starting).rejects.toThrow('exited before serving');
          await expect.poll(async () => (await fs.readFile(marker, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length).toBe(2);
          state.isShuttingDown = true;
          await state.openCodeProcess.close();
          await rejected;
        } else if (failure === 'startup-timeout') {
          await expect(runtime.startOpenCode()).rejects.toThrow('Timeout waiting for OpenCode');
        } else {
          await expect(runtime.startOpenCode()).rejects.toThrow(failure === 'health-error' ? 'fixture health failure' : 'Failed to parse server url');
        }
        const pids = (await fs.readFile(marker, 'utf8')).trim().split('\n').map(Number);
        expect(pids).toHaveLength(failure === 'none' || failure === 'shutdown-during-startup' ? 2 : 4);
        await expect.poll(() => pids.filter(alive), { timeout: 3000 }).toEqual([]);
        expect(await fs.readdir(path.join(root, 'registry')).catch(() => [])).toEqual([]);
      } finally {
        const pids = (await fs.readFile(marker, 'utf8').catch(() => '')).trim().split('\n').map(Number).filter((pid) => pid > 0);
        for (const pid of pids.reverse()) {
          if (!alive(pid)) continue;
          try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
        }
        if (previousRegistry === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
        else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previousRegistry;
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 15_000);
  }
});
