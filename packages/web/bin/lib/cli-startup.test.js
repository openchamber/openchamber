import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { buildSystemdUserService, enableStartupService, stablePnpmEntrypoint } from './cli-startup.js';

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
});
