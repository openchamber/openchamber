import { describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// readOpenChamberSettings (opencode.ts) reads ~/.config/openchamber/settings.json
// via os.homedir() at call time. Mock `vscode` and point homedir at a scratch
// home before importing the real module, mirroring bridge-settings-runtime.test.js,
// so the tests never touch the real settings file.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-settings-cap-'));
const scratchHome = path.join(scratchRoot, 'home');
fs.mkdirSync(scratchHome, { recursive: true });
const realOs = { ...os };
const osWithScratchHome = { ...realOs, homedir: () => scratchHome, default: { ...realOs, homedir: () => scratchHome } };
mock.module('os', () => osWithScratchHome);
mock.module('node:os', () => osWithScratchHome);

mock.module('vscode', () => ({
  l10n: { t: (message) => message },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined, inspect: () => undefined, update: async () => undefined }),
  },
  window: {
    createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }),
    showErrorMessage: async () => undefined,
  },
  env: { openExternal: async () => true },
  Uri: { parse: (value) => ({ toString: () => value }) },
  ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3 },
  Disposable: class {
    constructor(fn) { this.fn = fn; }
    dispose() { this.fn(); }
  },
}));

const { createOpenCodeManager, MAX_OPENCHAMBER_SETTINGS_BYTES } = await import('./opencode.ts');

const settingsDir = path.join(scratchHome, '.config', 'openchamber');
const settingsPath = path.join(settingsDir, 'settings.json');
fs.mkdirSync(settingsDir, { recursive: true });

const fakeBinary = path.join(scratchRoot, 'fake-opencode');
fs.writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n');
fs.chmodSync(fakeBinary, 0o755);

const manager = createOpenCodeManager({
  globalStorageUri: { fsPath: scratchRoot },
  subscriptions: [],
});

const cliPathFromSettings = () => manager.getDebugInfo().cliPath;

describe('readOpenChamberSettings bounded read (issue #1644)', () => {
  test('ordinary small settings file still resolves opencodeBinary', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ opencodeBinary: fakeBinary }), 'utf8');
    expect(cliPathFromSettings()).toBe(fakeBinary);
  });

  test('settings cap matches the shared-file cap the web readers use (#1746)', () => {
    // Oracle: SETTINGS_FILE_MAX_BYTES in packages/web/server/lib/github/auth.js
    // and packages/web/server/lib/linear/auth.js — one shared file, one cap.
    expect(MAX_OPENCHAMBER_SETTINGS_BYTES).toBe(8 * 1024 * 1024);
  });

  test('settings file between the old 4 MiB cap and the shared 8 MiB cap still resolves opencodeBinary (#1746)', () => {
    const padding = 'x'.repeat(5 * 1024 * 1024);
    fs.writeFileSync(settingsPath, JSON.stringify({ padding, opencodeBinary: fakeBinary }), 'utf8');
    expect(fs.statSync(settingsPath).size).toBeGreaterThan(4 * 1024 * 1024);
    expect(fs.statSync(settingsPath).size).toBeLessThan(MAX_OPENCHAMBER_SETTINGS_BYTES);
    expect(cliPathFromSettings()).toBe(fakeBinary);
  });

  test('over-cap settings file degrades to {} and the binary after the cap never resolves', () => {
    const padding = 'x'.repeat(MAX_OPENCHAMBER_SETTINGS_BYTES);
    fs.writeFileSync(settingsPath, JSON.stringify({ padding, opencodeBinary: fakeBinary }), 'utf8');
    expect(fs.statSync(settingsPath).size).toBeGreaterThan(MAX_OPENCHAMBER_SETTINGS_BYTES);
    expect(cliPathFromSettings()).not.toBe(fakeBinary);
  });

  test('FIFO at the settings path returns promptly instead of blocking', () => {
    fs.rmSync(settingsPath, { force: true });
    execFileSync('mkfifo', [settingsPath]);
    try {
      const startedAt = Date.now();
      expect(cliPathFromSettings()).not.toBe(fakeBinary);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      fs.rmSync(settingsPath, { force: true });
    }
  });
});
