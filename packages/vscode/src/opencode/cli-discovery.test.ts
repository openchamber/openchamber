import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findExecutableInPath,
  isMacOpenCodeAppBundlePath,
  isWindowsOpenCodeDesktopAppPath,
  normalizeConfiguredOpencodeBinary,
  stripWrappingQuotes,
} from './cli-discovery';

describe('stripWrappingQuotes', () => {
  test('removes double quotes', () => {
    assert.equal(stripWrappingQuotes('"C:\\Program Files\\opencode\\opencode.exe"'), 'C:\\Program Files\\opencode\\opencode.exe');
  });

  test('removes single quotes', () => {
    assert.equal(stripWrappingQuotes("'/usr/local/bin/opencode'"), '/usr/local/bin/opencode');
  });

  test('leaves unquoted values unchanged', () => {
    assert.equal(stripWrappingQuotes('/usr/local/bin/opencode'), '/usr/local/bin/opencode');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(stripWrappingQuotes('  "/tmp/opencode"  '), '/tmp/opencode');
  });
});

describe('normalizeConfiguredOpencodeBinary', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cli-discovery-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('appends platform binary name when configured path is a directory', () => {
    const expected = path.join(tempDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    assert.equal(normalizeConfiguredOpencodeBinary(tempDir), expected);
  });

  test('returns null for non-string input', () => {
    assert.equal(normalizeConfiguredOpencodeBinary(null), null);
    assert.equal(normalizeConfiguredOpencodeBinary(42), null);
  });

  test('strips wrapping quotes before normalization', () => {
    const expected = path.join(tempDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    assert.equal(normalizeConfiguredOpencodeBinary(`"${tempDir}"`), expected);
  });
});

describe('desktop app path rejection', () => {
  if (process.platform === 'darwin') {
    test('detects macOS OpenCode app bundle paths on darwin', () => {
      assert.equal(
        isMacOpenCodeAppBundlePath('/Applications/OpenCode.app/Contents/MacOS/opencode-cli'),
        true
      );
      assert.equal(
        isMacOpenCodeAppBundlePath('/Applications/OpenCode Dev.app/Contents/MacOS/OpenCode Dev'),
        true
      );
      assert.equal(isMacOpenCodeAppBundlePath('/usr/local/bin/opencode'), false);
    });
  } else {
    test('does not flag mac bundle paths on non-darwin platforms', () => {
      assert.equal(
        isMacOpenCodeAppBundlePath('/Applications/OpenCode.app/Contents/MacOS/opencode-cli'),
        false
      );
    });
  }

  test('detects Windows desktop app install paths when LOCALAPPDATA is set', () => {
    const original = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = path.join(os.tmpdir(), 'LocalAppData');
    try {
      const desktopPath = path.join(process.env.LOCALAPPDATA, 'Programs', 'opencode', 'opencode.exe');
      if (process.platform === 'win32') {
        assert.equal(isWindowsOpenCodeDesktopAppPath(desktopPath), true);
      } else {
        assert.equal(isWindowsOpenCodeDesktopAppPath(desktopPath), false);
      }
      assert.equal(isWindowsOpenCodeDesktopAppPath('/usr/local/bin/opencode'), false);
    } finally {
      if (original === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = original;
      }
    }
  });
});

describe('findExecutableInPath', () => {
  let tempDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-path-'));
    originalPath = process.env.PATH;
    process.env.PATH = tempDir;
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('finds an executable in a PATH segment', () => {
    const binaryName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    const binaryPath = path.join(tempDir, binaryName);
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho opencode\n', 'utf8');
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }

    assert.equal(findExecutableInPath('opencode'), binaryPath);
  });

  test('returns null when binary is missing from PATH', () => {
    assert.equal(findExecutableInPath('missing-opencode-binary'), null);
  });
});
