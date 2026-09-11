import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  clearAppImageArgv0FromProcessEnv,
  resolvePosixPtyLaunch,
  stripAppImageArgv0Leak,
} from './inherited-env.js';

describe('stripAppImageArgv0Leak', () => {
  it('removes ARGV0 from a child env object', () => {
    const env = {
      PATH: '/usr/bin',
      ARGV0: '/path/to/OpenChamber-1.17.2-linux-x86_64.AppImage',
      SHELL: '/bin/zsh',
    };

    expect(stripAppImageArgv0Leak(env)).toBe(env);
    expect(env).toEqual({
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });
  });

  it('is a no-op when ARGV0 is absent', () => {
    const env = { PATH: '/usr/bin', SHELL: '/bin/bash' };
    stripAppImageArgv0Leak(env);
    expect(env).toEqual({ PATH: '/usr/bin', SHELL: '/bin/bash' });
  });

  it('tolerates nullish env values', () => {
    expect(stripAppImageArgv0Leak(null)).toBeNull();
    expect(stripAppImageArgv0Leak(undefined)).toBeUndefined();
  });
});

describe('clearAppImageArgv0FromProcessEnv', () => {
  it('removes ARGV0 from process.env', () => {
    const previous = process.env.ARGV0;
    process.env.ARGV0 = '/path/to/OpenChamber.AppImage';
    try {
      clearAppImageArgv0FromProcessEnv();
      expect(process.env.ARGV0).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ARGV0;
      else process.env.ARGV0 = previous;
    }
  });
});

describe('resolvePosixPtyLaunch', () => {
  it('wraps the shell with env -u for every host-private variable on POSIX', () => {
    if (process.platform === 'win32') return;
    expect(resolvePosixPtyLaunch('/bin/zsh', ['-l'])).toEqual({
      executable: expect.stringMatching(/\/env$/),
      args: ['-u', 'ARGV0', '-u', 'NODE_CHANNEL_FD', '-u', 'BUN_WATCH_PID', '/bin/zsh', '-l'],
    });
  });

  it('leaves the launch unchanged with nothing to unset', () => {
    expect(resolvePosixPtyLaunch('/bin/zsh', ['-l'], [])).toEqual({
      executable: '/bin/zsh',
      args: ['-l'],
    });
  });

  it('PTY IPC regression: host-private variables do not leak through wrapper', () => {
    // Simulate Bun serve daemon environ with real IPC fd
    const hostEnv = { ...process.env, NODE_CHANNEL_FD: '3', BUN_WATCH_PID: '999' };
    const launch = resolvePosixPtyLaunch('/bin/sh', ['-c', 'echo $NODE_CHANNEL_FD:$BUN_WATCH_PID']);
    // On POSIX the wrapper must strip both vars; the spawned shell must see empties.
    if (process.platform !== 'win32') {
      expect(launch.args).toContain('NODE_CHANNEL_FD');
      expect(launch.args).toContain('BUN_WATCH_PID');
      const result = spawnSync(launch.executable, launch.args, { env: hostEnv, encoding: 'utf8' });
      // Shell echo should be ":" (both vars absent) or empty, not "3:999"
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(':');
    } else {
      expect(launch.executable).toBe('/bin/sh');
    }
  });

  it('PTY IPC regression: fork worker can use process.send under wrapper', () => {
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pty-fork-'));
    const childPath = path.join(dir, 'child.js');
    const parentCode = `
      const { fork } = require('node:child_process');
      const path = require('node:path');
      const child = fork(path.join(__dirname, 'child.js'));
      let ok = false;
      child.on('message', (m) => { if (m === 'ok') ok = true; });
      child.on('exit', (code) => { process.exit(ok && code === 0 ? 0 : 1); });
      setTimeout(() => process.exit(2), 1500);
    `;
    const parentPath = path.join(dir, 'parent.js');
    fs.writeFileSync(childPath, 'if (process.send) process.send("ok"); process.exit(0);');
    fs.writeFileSync(parentPath, parentCode);
    const hostEnv = { ...process.env, NODE_CHANNEL_FD: '3', BUN_WATCH_PID: '999' };
    const launch = resolvePosixPtyLaunch('/bin/sh', ['-c', `node ${parentPath}`]);
    const result = spawnSync(launch.executable, launch.args, { env: hostEnv, encoding: 'utf8', timeout: 5000 });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    expect(result.status).toBe(0);
  });
});
