import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildSystemdUserService,
  enableStartupService,
  findStartupServiceInstance,
  parseLaunchdJobPid,
  parseSystemdMainPid,
  parseWindowsTaskProcesses,
  restartWindowsStartupTask,
  stablePnpmEntrypoint,
  startWindowsTaskAfterExit,
} from './cli-startup.js';
import { INJECTED_ENV_KEY, assignInjectedEnv } from '../../server/lib/injected-env.js';

const join = (...parts) => path.join(...parts);

describe('stablePnpmEntrypoint', () => {
  const globalModules = join('/home/me', '.local', 'share', 'pnpm', 'global', '5', 'node_modules');
  const storeEntry = join(globalModules, '.pnpm', '@openchamber+web@2.1.0', 'node_modules', '@openchamber', 'web', 'bin', 'cli.js');
  const stableEntry = join(globalModules, '@openchamber', 'web', 'bin', 'cli.js');

  it('maps a pnpm store path to the version-independent link', () => {
    expect(stablePnpmEntrypoint(storeEntry, (candidate) => candidate === stableEntry)).toBe(stableEntry);
  });

  it('keeps the resolved path when the link is missing', () => {
    expect(stablePnpmEntrypoint(storeEntry, () => false)).toBeNull();
  });

  it('leaves npm installs alone', () => {
    const npmEntry = join('/usr/local/lib', 'node_modules', '@openchamber', 'web', 'bin', 'cli.js');
    expect(stablePnpmEntrypoint(npmEntry, () => true)).toBeNull();
  });
});

describe('buildSystemdUserService', () => {
  it('treats the graceful SIGTERM exit as a clean stop', () => {
    const unit = buildSystemdUserService({ port: 3002 });
    expect(unit).toContain('Restart=always');
    expect(unit).toMatch(/^SuccessExitStatus=143$/m);
  });

  it('starts a pnpm 11+ global install through the link that survives updates', () => {
    const pnpmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-pnpm-'));
    const globalDir = join(pnpmHome, 'global', 'v11');
    const packageEntry = join('node_modules', '@openchamber', 'web', 'bin', 'cli.js');
    const previousEntry = process.argv[1];
    try {
      fs.mkdirSync(path.dirname(join(globalDir, '3e0-install', packageEntry)), { recursive: true });
      fs.writeFileSync(join(globalDir, '3e0-install', packageEntry), '');
      fs.symlinkSync('3e0-install', join(globalDir, '16cc9c3f'));
      // pnpm's shim runs `node "$basedir/../global/v11/<link>/node_modules/..."`.
      process.argv[1] = join(pnpmHome, 'bin', '..', 'global', 'v11', '16cc9c3f', packageEntry);

      const unit = buildSystemdUserService({ port: 3000 });

      expect(unit).toContain(`"${join(globalDir, '16cc9c3f', packageEntry)}" "serve"`);
      expect(unit).not.toContain('3e0-install');
    } finally {
      process.argv[1] = previousEntry;
      fs.rmSync(pnpmHome, { recursive: true, force: true });
    }
  });
});

describe('parseSystemdMainPid', () => {
  it('reads the pid systemd reports', () => {
    expect(parseSystemdMainPid('4242\n')).toBe(4242);
  });

  it('reports no pid for a stopped unit', () => {
    // A stopped unit answers with 0, which is not a process.
    expect(parseSystemdMainPid('0\n')).toBeNull();
    expect(parseSystemdMainPid('')).toBeNull();
  });
});

describe('parseLaunchdJobPid', () => {
  it('reads the pid of a running job', () => {
    const output = [
      '{',
      '\t"LimitLoadToSessionType" = "Aqua";',
      '\t"Label" = "dev.openchamber.web";',
      '\t"PID" = 4242;',
      '}',
    ].join('\n');
    expect(parseLaunchdJobPid(output)).toBe(4242);
  });

  it('reports no pid while launchd is not running the job', () => {
    const output = [
      '{',
      '\t"Label" = "dev.openchamber.web";',
      '\t"LastExitStatus" = 0;',
      '}',
    ].join('\n');
    expect(parseLaunchdJobPid(output)).toBeNull();
  });
});

describe('parseWindowsTaskProcesses', () => {
  it('reports no processes for a task that is not running', () => {
    expect(parseWindowsTaskProcesses('stopped\r\n')).toBeNull();
  });

  it('reads the processes of a running task', () => {
    expect(parseWindowsTaskProcesses('running 4242 4243\r\n')).toEqual([4242, 4243]);
  });

  it('reads a running task whose process could not be told apart', () => {
    expect(parseWindowsTaskProcesses('running\r\n')).toEqual([]);
  });

  it('rejects output it does not know', () => {
    expect(() => parseWindowsTaskProcesses('')).toThrow(/unexpected task state/);
  });
});

describe('findStartupServiceInstance', () => {
  const daemon = { pid: 11, port: 3000, launchMode: 'daemon' };
  const foreground = { pid: 22, port: 3001, launchMode: 'foreground' };
  const second = { pid: 33, port: 3002, launchMode: 'foreground' };

  it('picks the instance whose pid the service manager reports', () => {
    expect(findStartupServiceInstance([daemon, foreground], {
      getPid: () => 22,
      platform: 'linux',
    })).toBe(foreground);
  });

  it('reports no service instance when the pid lookup finds nothing running', () => {
    // A stopped unit must not hand the foreground instance to the service
    // restart, which would stop it and start nothing.
    expect(findStartupServiceInstance([foreground], {
      getPid: () => null,
      platform: 'linux',
    })).toBeNull();
  });

  describe('on Windows', () => {
    const find = (instances, getTaskProcesses) => findStartupServiceInstance(instances, {
      getTaskProcesses,
      platform: 'win32',
    });

    it('leaves a manual foreground server alone when the task is stopped, disabled or missing', () => {
      expect(find([foreground], () => null)).toBeNull();
    });

    it('finds the running task beside another foreground server', () => {
      expect(find([foreground, second], () => [9000, 33])).toBe(second);
    });

    it('fails when the running task matches no instance', () => {
      expect(() => find([foreground], () => [9000])).toThrow(/Nothing was stopped or installed/);
    });

    it('fails when the task cannot be read', () => {
      expect(() => find([foreground], () => {
        throw new Error('Access is denied');
      })).toThrow(/Access is denied.*openchamber startup disable/);
    });

    it('finds no instance when discovery is empty and the task is stopped', () => {
      expect(find([], () => null)).toBeNull();
    });

    it('fails when discovery is empty and the task is running', () => {
      expect(() => find([], () => [9000])).toThrow(/Nothing was stopped or installed/);
    });
  });
});

describe('restartWindowsStartupTask', () => {
  const instance = { pid: 4242, port: 3000 };

  function setup({ endStatus = 0, requested = false, running = true, exited = true } = {}) {
    const calls = [];
    const options = {
      run: vi.fn((_command, args) => {
        calls.push(args[0]);
        return { status: args[0] === '/End' ? endStatus : 0, stderr: 'ERROR: access denied' };
      }),
      requestShutdown: vi.fn(async () => {
        calls.push('shutdown');
        return requested;
      }),
      isRunning: vi.fn(() => running),
      stopProcess: vi.fn(async () => {
        calls.push('exit');
        return exited;
      }),
      startTaskAfterExit: vi.fn(async () => {
        calls.push('helper');
      }),
    };
    return { calls, options };
  }

  it('hands the start to the helper, then ends the task and stops the server', async () => {
    const { calls, options } = setup();

    await restartWindowsStartupTask(instance, options);

    expect(calls).toEqual(['helper', '/End', 'shutdown', 'exit']);
    expect(options.startTaskAfterExit).toHaveBeenCalledWith(4242);
    expect(options.stopProcess.mock.calls[0][0]).toBe(4242);
  });

  it('leaves the start to the helper when the shutdown takes down the updater', async () => {
    // Run from a terminal of this server, the update dies with the shutdown
    // request. Everything the restart needs has to be in place by then.
    const { calls, options } = setup();
    options.requestShutdown = vi.fn(() => {
      calls.push('shutdown');
      return new Promise(() => {});
    });

    void restartWindowsStartupTask(instance, options);
    await vi.waitFor(() => expect(calls).toContain('shutdown'));

    expect(calls).toEqual(['helper', '/End', 'shutdown']);
  });

  it('touches nothing when the helper cannot start', async () => {
    const { calls, options } = setup();
    options.startTaskAfterExit = vi.fn(async () => {
      throw new Error('spawn ENOENT');
    });

    await expect(restartWindowsStartupTask(instance, options)).rejects.toThrow(/spawn ENOENT.*schtasks \/Run/);

    expect(calls).toEqual([]);
  });

  it('reports a server that does not exit', async () => {
    const { options } = setup({ exited: false });

    await expect(restartWindowsStartupTask(instance, options)).rejects.toThrow(/did not exit.*taskkill \/PID 4242/);
  });

  it('stops when /End fails and the server is still up', async () => {
    const { calls, options } = setup({ endStatus: 1 });

    await expect(restartWindowsStartupTask(instance, options)).rejects.toThrow(/access denied/);

    expect(calls).toEqual(['helper', '/End', 'shutdown']);
  });

  it('goes on when /End fails because the server is already gone', async () => {
    const { calls, options } = setup({ endStatus: 1, running: false });

    await restartWindowsStartupTask(instance, options);

    expect(calls).toEqual(['helper', '/End', 'shutdown', 'exit']);
  });

  it('waits for a server that accepted the shutdown request when /End finds no task to end', async () => {
    const { calls, options } = setup({ endStatus: 1, requested: true });

    await restartWindowsStartupTask(instance, options);

    expect(calls).toEqual(['helper', '/End', 'shutdown', 'exit']);
  });
});

describe('startWindowsTaskAfterExit', () => {
  const start = () => {
    const helper = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawnProcess = vi.fn(() => helper);
    return { helper, spawnProcess, started: startWindowsTaskAfterExit(4242, spawnProcess) };
  };

  it('starts a detached process that waits for the server and the task before /Run', async () => {
    const { helper, spawnProcess, started } = start();
    helper.emit('spawn');
    await started;

    const [, args, options] = spawnProcess.mock.calls[0];
    expect(options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(helper.unref).toHaveBeenCalled();

    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    expect(script).toContain('Get-Process -Id 4242');
    expect(script.indexOf('$serverGone -and $task.State -ne "Running"')).toBeLessThan(script.indexOf('/Run'));
  });

  it('rejects when the helper does not start', async () => {
    const { helper, started } = start();
    helper.emit('error', new Error('spawn ENOENT'));

    await expect(started).rejects.toThrow('spawn ENOENT');
  });
});

describe('macOS startup service', () => {
  it('leaves the enabling shell\'s PATH out of the service environment', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-startup-'));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const previous = { PATH: process.env.PATH, OPENCHAMBER_DATA_DIR: process.env.OPENCHAMBER_DATA_DIR };
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'dev.openchamber.web.plist');
    const writeFileSync = fs.writeFileSync;
    const stopBeforeLaunchctl = new Error('Stop before activating launchd');

    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
      process.env.OPENCHAMBER_DATA_DIR = path.join(home, '.config', 'openchamber');
      process.env.PATH = `/old/toolchain/bin${path.delimiter}${previous.PATH ?? ''}`;
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
        writeFileSync(file, ...args);
        if (file === plistPath) throw stopBeforeLaunchctl;
      });

      expect(() => enableStartupService({})).toThrow(stopBeforeLaunchctl);
      const plist = fs.readFileSync(plistPath, 'utf8');
      expect(plist).toContain('<key>OPENCHAMBER_DATA_DIR</key>');
      expect(plist).not.toContain('<key>PATH</key>');
      expect(plist).not.toContain('/old/toolchain/bin');
    } finally {
      vi.restoreAllMocks();
      Object.defineProperty(process, 'platform', platform);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes a launch agent without background process throttling', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-startup-'));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'dev.openchamber.web.plist');
    const writeFileSync = fs.writeFileSync;
    const stopBeforeLaunchctl = new Error('Stop before activating launchd');

    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
      process.env.OPENCHAMBER_DATA_DIR = path.join(home, '.config', 'openchamber');
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
        writeFileSync(file, ...args);
        if (file === plistPath) throw stopBeforeLaunchctl;
      });

      expect(() => enableStartupService({ envSnapshot: false })).toThrow(stopBeforeLaunchctl);
      const plist = fs.readFileSync(plistPath, 'utf8');
      expect(plist).not.toContain('<key>ProcessType</key>');
      expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
      expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    } finally {
      vi.restoreAllMocks();
      Object.defineProperty(process, 'platform', platform);
      if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('leaves what OpenChamber put into the enabling shell out of the service environment', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-startup-'));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'dev.openchamber.web.plist');
    const writeFileSync = fs.writeFileSync;
    const stopBeforeLaunchctl = new Error('Stop before activating launchd');
    // The shell of a desktop app's terminal, or an agent's: the user's own
    // exports next to what the app and the managed OpenCode set.
    const ours = {
      OPENCHAMBER_RUNTIME: 'desktop',
      OPENCHAMBER_SKIP_API_COMPRESSION: 'true',
      OPENCHAMBER_UI_PASSWORD: 'desktop-password',
      OPENCODE_SERVER_PASSWORD: 'managed-password',
    };
    const theirs = {
      OPENCODE_HOST: 'http://opencode.lan:4096',
      MY_PROVIDER_TOKEN: 'token',
      OPENCHAMBER_DATA_DIR: path.join(home, '.config', 'openchamber'),
    };
    const touched = [...Object.keys(ours), ...Object.keys(theirs), INJECTED_ENV_KEY];
    const previous = Object.fromEntries(touched.map((key) => [key, process.env[key]]));

    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      for (const key of touched) delete process.env[key];
      Object.assign(process.env, theirs);
      assignInjectedEnv(process.env, ours);
      vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
        writeFileSync(file, ...args);
        if (file === plistPath) throw stopBeforeLaunchctl;
      });

      expect(() => enableStartupService({ port: 3000, host: '0.0.0.0', uiPassword: 'service-password' })).toThrow(stopBeforeLaunchctl);
      const plist = fs.readFileSync(plistPath, 'utf8');
      for (const key of ['OPENCHAMBER_RUNTIME', 'OPENCHAMBER_SKIP_API_COMPRESSION', 'OPENCODE_SERVER_PASSWORD', INJECTED_ENV_KEY]) {
        expect(plist).not.toContain(`<key>${key}</key>`);
      }
      for (const key of Object.keys(theirs)) {
        expect(plist).toContain(`<key>${key}</key>`);
      }
      expect(plist).toContain('<string>service-password</string>');
      expect(plist).not.toContain('desktop-password');
    } finally {
      vi.restoreAllMocks();
      Object.defineProperty(process, 'platform', platform);
      for (const key of touched) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
