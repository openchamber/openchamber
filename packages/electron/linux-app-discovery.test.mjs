import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLinuxOpenSpecs,
  filterLinuxInstalledApps,
  parseDesktopEntry,
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
