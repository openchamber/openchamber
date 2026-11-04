import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { buildSystemdUserService, enableStartupService, stablePnpmEntrypoint } from './cli-startup.js';
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

  it('escapes a data directory with a space in every path directive', () => {
    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    try {
      // OPENCHAMBER_DATA_DIR is a supported override, so a space is reachable
      // through normal use. systemd splits EnvironmentFile= on whitespace and
      // has no shell-style quoting, so a raw space there loses the file.
      process.env.OPENCHAMBER_DATA_DIR = join('/home/me', 'My Data', 'openchamber');

      const unit = buildSystemdUserService({ port: 3000 });
      const directive = (name) => unit.split('\n').find((line) => line.startsWith(`${name}=`));

      expect(directive('EnvironmentFile')).not.toMatch(/ /);
      expect(directive('WorkingDirectory')).not.toMatch(/ /);
    } finally {
      if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    }
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

describe('macOS startup service', () => {
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
