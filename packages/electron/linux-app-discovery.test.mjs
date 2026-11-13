import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildLinuxOpenSpecs,
  filterLinuxInstalledApps,
  parseDesktopEntry,
  readLinuxDesktopEntries,
} from './linux-app-discovery.mjs';

const NON_ASCII_ONLY_ENTRY = `[Desktop Entry]
Type=Application
Name=抖音
Exec=/usr/bin/example --app-url=https://www.douyin.com/
Icon=example`;

const TEST_ENV = { PATH: '/nonexistent-openchamber-test-bin' };

const parseEntryAt = (content, id) => parseDesktopEntry(content, `/usr/share/applications/${id}.desktop`);

test('still parses desktop entries whose Name has no ASCII letters or digits', () => {
  const entry = parseEntryAt(NON_ASCII_ONLY_ENTRY, 'example');
  assert.ok(entry);
  assert.equal(entry.name, '抖音');
  assert.equal(entry.exec, '/usr/bin/example --app-url=https://www.douyin.com/');
});

test('a non-ASCII-only desktop entry does not mark every app as installed', async () => {
  const entry = parseEntryAt(NON_ASCII_ONLY_ENTRY, 'example');
  const installed = await filterLinuxInstalledApps(
    ['Visual Studio Code', 'Cursor', 'Sublime Text'],
    { entries: [entry] },
  );
  assert.deepEqual(installed, []);
});

test('Open In specs never launch a non-ASCII-only entry for another app', () => {
  const entry = parseEntryAt(NON_ASCII_ONLY_ENTRY, 'example');
  const specs = buildLinuxOpenSpecs({
    targetPath: '/tmp/project',
    appId: 'vscode',
    appName: 'Visual Studio Code',
    entries: [entry],
    env: TEST_ENV,
  });
  assert.deepEqual(specs, []);
});

test('ASCII desktop entries still match their own app and build their own launch spec', async () => {
  const entry = parseEntryAt(`[Desktop Entry]
Type=Application
Name=Visual Studio Code
Exec=/usr/bin/code %F
Icon=code`, 'code');
  const installed = await filterLinuxInstalledApps(
    ['Visual Studio Code', 'Cursor'],
    { entries: [entry] },
  );
  assert.deepEqual(installed, ['Visual Studio Code']);

  const specs = buildLinuxOpenSpecs({
    targetPath: '/tmp/project',
    appId: 'vscode',
    appName: 'Visual Studio Code',
    entries: [entry],
    env: TEST_ENV,
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].program, '/usr/bin/code');
  assert.deepEqual(specs[0].args, ['/tmp/project']);
});

const withUserAndSystemDirs = async (files, run) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-desktop-shadow-'));
  try {
    const dirs = [];
    for (const [dir, name, content] of files) {
      const directory = path.join(root, dir);
      if (!dirs.includes(directory)) dirs.push(directory);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, name), content);
    }
    await run(dirs);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

test('a system entry is returned when no user-level override shadows it', async () => {
  await withUserAndSystemDirs([
    ['system', 'nsight.desktop', '[Desktop Entry]\nType=Application\nName=Nsight Eclipse Edition\nExec=/usr/local/cuda/bin/nsight\n'],
  ], async (applicationDirs) => {
    const entries = await readLinuxDesktopEntries({ applicationDirs });
    assert.deepEqual(entries.map((entry) => entry.id), ['nsight']);
    assert.equal(entries[0].filePath, path.join(applicationDirs[0], 'nsight.desktop'));
  });
});

test('a user-level Hidden entry shadows the same desktop id from a system dir', async () => {
  await withUserAndSystemDirs([
    ['user', 'nsight.desktop', '[Desktop Entry]\nType=Application\nName=Nsight Eclipse Edition\nHidden=true\n'],
    ['system', 'nsight.desktop', '[Desktop Entry]\nType=Application\nName=Nsight Eclipse Edition\nExec=/usr/local/cuda/bin/nsight\n'],
  ], async (applicationDirs) => {
    const entries = await readLinuxDesktopEntries({ applicationDirs });
    assert.deepEqual(entries.filter((entry) => entry.id === 'nsight'), []);
  });
});

test('a user-level NoDisplay entry shadows the same desktop id from a system dir', async () => {
  await withUserAndSystemDirs([
    ['user', 'code.desktop', '[Desktop Entry]\nType=Application\nName=Visual Studio Code\nNoDisplay=true\n'],
    ['system', 'code.desktop', '[Desktop Entry]\nType=Application\nName=Visual Studio Code\nExec=/usr/bin/code %F\n'],
  ], async (applicationDirs) => {
    const entries = await readLinuxDesktopEntries({ applicationDirs });
    assert.deepEqual(entries.filter((entry) => entry.id === 'code'), []);
  });
});

test('a visible user-level entry wins over a hidden system entry with the same id', async () => {
  await withUserAndSystemDirs([
    ['user', 'code.desktop', '[Desktop Entry]\nType=Application\nName=Visual Studio Code\nExec=/usr/bin/code %F\n'],
    ['system', 'code.desktop', '[Desktop Entry]\nType=Application\nName=Visual Studio Code\nHidden=true\n'],
  ], async (applicationDirs) => {
    const entries = await readLinuxDesktopEntries({ applicationDirs });
    assert.deepEqual(entries.map((entry) => entry.id), ['code']);
    assert.equal(entries[0].filePath, path.join(applicationDirs[0], 'code.desktop'));
  });
});

test('a malformed user-level entry does not shadow a valid system entry', async () => {
  await withUserAndSystemDirs([
    ['user', 'code.desktop', '[Desktop Entry]\nType=Application\nName=Visual Studio Code\n'],
    ['system', 'code.desktop', '[Desktop Entry]\nType=Application\nName=Visual Studio Code\nExec=/usr/bin/code %F\n'],
  ], async (applicationDirs) => {
    const entries = await readLinuxDesktopEntries({ applicationDirs });
    assert.deepEqual(entries.map((entry) => entry.id), ['code']);
    assert.equal(entries[0].filePath, path.join(applicationDirs[1], 'code.desktop'));
  });
});

test('entries mixing ASCII and non-ASCII still match through their ASCII part', () => {
  const entry = parseEntryAt(`[Desktop Entry]
Type=Application
Name=VSCode 抖音版
Exec=/usr/local/bin/vscode-douyin %F
Icon=vscode-douyin`, 'vscode-douyin');
  const specs = buildLinuxOpenSpecs({
    targetPath: '/tmp/project',
    appId: 'vscode',
    appName: 'Visual Studio Code',
    entries: [entry],
    env: TEST_ENV,
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].program, '/usr/local/bin/vscode-douyin');
});
