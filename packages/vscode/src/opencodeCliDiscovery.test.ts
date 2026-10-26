import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveDetectedOpencodeCliPath } from './opencodeCliDiscovery';

const originalPlatform = process.platform;
const originalEnvironment = {
  PATH: process.env.PATH,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
};
const directories: string[] = [];

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('Windows prefers the npm CLI on PATH over a standard installation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-cli-'));
  directories.push(home);
  const officialCli = path.join(home, '.opencode', 'bin', 'opencode.exe');
  const npmDirectory = path.join(home, 'npm-global');
  const npmCli = path.join(npmDirectory, 'opencode.cmd');
  fs.mkdirSync(path.dirname(officialCli), { recursive: true });
  fs.mkdirSync(npmDirectory);
  fs.writeFileSync(officialCli, '');
  fs.writeFileSync(npmCli, '');

  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  process.env.PATH = npmDirectory;

  assert.equal(resolveDetectedOpencodeCliPath(), npmCli);

  const localAppData = path.join(home, 'AppData', 'Local');
  const desktopDirectory = path.join(localAppData, 'Programs', 'OpenCode');
  fs.mkdirSync(desktopDirectory, { recursive: true });
  fs.writeFileSync(path.join(desktopDirectory, 'opencode.exe'), '');
  process.env.LOCALAPPDATA = localAppData;
  process.env.PATH = [desktopDirectory, npmDirectory].join(path.delimiter);
  assert.equal(resolveDetectedOpencodeCliPath(), npmCli);

  fs.rmSync(npmCli);
  assert.equal(resolveDetectedOpencodeCliPath(), officialCli);
  fs.writeFileSync(npmCli, '');
  assert.equal(resolveDetectedOpencodeCliPath(), npmCli);
});

test('Unix finds an executable CLI on PATH', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-cli-'));
  directories.push(directory);
  const cli = path.join(directory, 'opencode');
  fs.writeFileSync(cli, '', { mode: 0o755 });
  Object.defineProperty(process, 'platform', { value: 'linux' });
  process.env.PATH = directory;

  assert.equal(resolveDetectedOpencodeCliPath(), cli);
});
