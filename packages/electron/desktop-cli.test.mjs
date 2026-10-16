import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDesktopLauncher, getDesktopCommandStatus, prepareDesktopLauncher, registerDesktopCommand, unregisterDesktopCommand } from './desktop-cli.mjs';

/** Prepare registration with temporary HOME and PATH values without touching real user commands or shell configuration. */
const fixture = async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-desktop-cli-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, '.local', 'bin');
  await fsp.mkdir(bin, { recursive: true });
  return {
    platform: 'linux',
    env: { PATH: bin, HOME: root, SHELL: '/bin/sh' },
    homeDir: root,
    dataDir: path.join(root, 'data'),
    executablePath: '/opt/OpenChamber/openchamber',
    bin,
  };
};

test('registers an exclusive link in the user bin already on PATH without changing shell configuration', async (t) => {
  const options = await fixture(t);
  const result = await registerDesktopCommand(options);
  assert.equal(result.state, 'installed');
  assert.equal(result.path, path.join(options.bin, 'chamber'));
  assert.equal(await fsp.readlink(result.path), path.join(options.dataDir, 'desktop', 'chamber'));
  await assert.rejects(fsp.stat(path.join(options.homeDir, '.profile')), { code: 'ENOENT' });
});

test('ignores writable application directories when choosing the public command location', async (t) => {
  const options = await fixture(t);
  const privateBin = path.join(options.homeDir, 'OpenChamber.app', 'Contents', 'Resources', 'opencode-cli');
  await fsp.mkdir(privateBin, { recursive: true });
  options.env.PATH = `${privateBin}${path.delimiter}${options.bin}`;
  const installed = await registerDesktopCommand(options);
  assert.equal(installed.path, path.join(options.bin, 'chamber'));
  await assert.rejects(fsp.lstat(path.join(privateBin, 'chamber')), { code: 'ENOENT' });
});

test('leaves a legacy desktop openchamber command and its record unchanged', async (t) => {
  const options = await fixture(t);
  const privateBin = path.join(options.homeDir, 'OpenChamber.app', 'Contents', 'Resources', 'opencode-cli');
  await fsp.mkdir(privateBin, { recursive: true });
  const oldLink = path.join(privateBin, 'openchamber');
  await fsp.mkdir(path.join(options.dataDir, 'desktop'), { recursive: true });
  const oldLauncherPath = path.join(options.dataDir, 'desktop', 'openchamber');
  await fsp.writeFile(oldLauncherPath, 'old desktop launcher');
  await fsp.symlink(oldLauncherPath, oldLink);
  const oldRecord = JSON.stringify({
    version: 1, linkPath: oldLink, pathConfigured: true,
  });
  const oldRecordPath = path.join(options.dataDir, 'desktop', 'command.json');
  await fsp.writeFile(oldRecordPath, oldRecord);
  assert.deepEqual(await getDesktopCommandStatus(options), { state: 'missing' });
  assert.equal((await registerDesktopCommand(options)).path, path.join(options.bin, 'chamber'));
  await unregisterDesktopCommand(options);
  assert.equal(await fsp.readlink(oldLink), oldLauncherPath);
  assert.equal(await fsp.readFile(oldRecordPath, 'utf8'), oldRecord);
  assert.equal(await fsp.readFile(oldLauncherPath, 'utf8'), 'old desktop launcher');
  await assert.rejects(fsp.lstat(path.join(options.dataDir, 'desktop', 'chamber-command.json')), { code: 'ENOENT' });
});

test('does not mistake a previous PATH entry for shell configuration after PATH changes', async (t) => {
  const options = await fixture(t);
  await registerDesktopCommand(options);
  const changed = { ...options, env: { ...options.env, PATH: '' } };
  assert.equal((await getDesktopCommandStatus(changed)).requiresPath, true);
});

test('preserves an existing CLI when registration is requested', async (t) => {
  const options = await fixture(t);
  const command = path.join(options.bin, 'chamber');
  await fsp.writeFile(command, 'user command', { mode: 0o755 });
  assert.equal((await registerDesktopCommand(options)).state, 'external');
  assert.equal(await fsp.readFile(command, 'utf8'), 'user command');
  await assert.rejects(fsp.stat(path.join(options.dataDir, 'desktop', 'chamber-command.json')), { code: 'ENOENT' });
});

test('registers chamber alongside an existing openchamber CLI without changing it', async (t) => {
  const options = await fixture(t);
  const existing = path.join(options.bin, 'openchamber');
  await fsp.writeFile(existing, 'user CLI', { mode: 0o755 });
  const installed = await registerDesktopCommand(options);
  assert.equal(installed.path, path.join(options.bin, 'chamber'));
  assert.equal(await fsp.readFile(existing, 'utf8'), 'user CLI');
  await unregisterDesktopCommand(options);
  assert.equal(await fsp.readFile(existing, 'utf8'), 'user CLI');
});

test('preserves a user replacement of the legacy command while registering chamber', async (t) => {
  const options = await fixture(t);
  await prepareDesktopLauncher(options);
  const existing = path.join(options.bin, 'openchamber');
  await fsp.writeFile(existing, 'replacement', { mode: 0o755 });
  await fsp.writeFile(path.join(options.dataDir, 'desktop', 'command.json'), JSON.stringify({
    version: 2, linkPath: existing, pathConfigured: false,
  }));
  assert.equal((await registerDesktopCommand(options)).path, path.join(options.bin, 'chamber'));
  assert.equal(await fsp.readFile(existing, 'utf8'), 'replacement');
  await unregisterDesktopCommand(options);
  assert.equal(await fsp.readFile(existing, 'utf8'), 'replacement');
  assert.equal(JSON.parse(await fsp.readFile(path.join(options.dataDir, 'desktop', 'command.json'), 'utf8')).linkPath, existing);
});

test('ignores an owned legacy openchamber link without a registration record', async (t) => {
  const options = await fixture(t);
  const oldLink = path.join(options.bin, 'openchamber');
  await fsp.symlink(path.join(options.dataDir, 'desktop', 'openchamber'), oldLink);
  assert.equal((await getDesktopCommandStatus(options)).state, 'missing');
  assert.equal((await registerDesktopCommand(options)).path, path.join(options.bin, 'chamber'));
  await unregisterDesktopCommand(options);
  assert.equal(await fsp.readlink(oldLink), path.join(options.dataDir, 'desktop', 'openchamber'));
});

test('uninstalls an early chamber link recorded at the old path without touching openchamber', async (t) => {
  const options = await fixture(t);
  const oldLauncher = path.join(options.dataDir, 'desktop', 'openchamber');
  await fsp.mkdir(path.dirname(oldLauncher), { recursive: true });
  const chamberLink = path.join(options.bin, 'chamber');
  const openchamberLink = path.join(options.bin, 'openchamber');
  await fsp.symlink(oldLauncher, chamberLink);
  await fsp.symlink(oldLauncher, openchamberLink);
  const oldRecordPath = path.join(options.dataDir, 'desktop', 'command.json');
  await fsp.writeFile(oldRecordPath, JSON.stringify({ version: 2, linkPath: chamberLink, pathConfigured: false }));
  assert.equal((await getDesktopCommandStatus(options)).path, chamberLink);
  assert.equal((await unregisterDesktopCommand(options)).state, 'missing');
  await assert.rejects(fsp.lstat(chamberLink), { code: 'ENOENT' });
  await assert.rejects(fsp.lstat(oldRecordPath), { code: 'ENOENT' });
  assert.equal(await fsp.readlink(openchamberLink), oldLauncher);
});

test('never replaces a dangling command link', async (t) => {
  const options = await fixture(t);
  const command = path.join(options.bin, 'chamber');
  await fsp.symlink('/missing/user-command', command);
  assert.equal((await registerDesktopCommand(options)).state, 'external');
  assert.equal(await fsp.readlink(command), '/missing/user-command');
});

test('refreshes its own launcher after an AppImage moves, keeping the public link', async (t) => {
  const options = await fixture(t);
  const first = await registerDesktopCommand(options);
  const target = await fsp.readlink(first.path);
  const moved = { ...options, executablePath: '/home/user/Apps/New OpenChamber.AppImage' };
  await prepareDesktopLauncher(moved);
  assert.equal((await getDesktopCommandStatus(moved)).state, 'installed');
  assert.equal(await fsp.readlink(first.path), target);
  assert.match(await fsp.readFile(target, 'utf8'), /New OpenChamber\.AppImage/);
});

test('adds the user bin to shell PATH only once when it is absent', async (t) => {
  const options = await fixture(t);
  options.env.PATH = '';
  const profile = path.join(options.homeDir, '.profile');
  await fsp.writeFile(profile, 'export USER_SETTING=kept\n');
  const first = await registerDesktopCommand(options);
  assert.equal(first.path, path.join(options.homeDir, '.local', 'bin', 'chamber'));
  assert.equal(first.state, 'installed');
  await registerDesktopCommand(options);
  const contents = await fsp.readFile(profile, 'utf8');
  assert.ok(contents.startsWith('export USER_SETTING=kept\n'));
  assert.equal(contents.split('# OpenChamber desktop command').length, 2);
  assert.ok(contents.includes('export PATH="$PATH:$HOME/.local/bin"'));
});

test('quotes application paths and sends normalized directories as a single native argument', () => {
  const script = buildDesktopLauncher({ platform: 'darwin', executablePath: "/Applications/Ariza's Apps/OpenChamber.app/Contents/MacOS/OpenChamber" });
  assert.ok(script.includes('Usage: chamber [directory]'));
  assert.ok(script.includes("'/Applications/Ariza'\"'\"'s Apps/OpenChamber.app'"));
  assert.ok(script.includes('set -- "--openchamber-project=$directory"'));
  assert.ok(script.includes('unset ELECTRON_RUN_AS_NODE NODE_OPTIONS'));
});

test('preparing a launcher or reading settings never registers a public command', async (t) => {
  const options = await fixture(t);
  await prepareDesktopLauncher(options);
  assert.equal((await getDesktopCommandStatus(options)).state, 'missing');
  await assert.rejects(fsp.lstat(path.join(options.bin, 'chamber')), { code: 'ENOENT' });
  await assert.rejects(fsp.lstat(path.join(options.dataDir, 'desktop', 'openchamber')), { code: 'ENOENT' });
  await assert.rejects(fsp.stat(path.join(options.homeDir, '.profile')), { code: 'ENOENT' });
});

test('uninstalls its recorded command after PATH changes and does not recreate it at startup', async (t) => {
  const options = await fixture(t);
  const installed = await registerDesktopCommand(options);
  const changed = { ...options, env: { ...options.env, PATH: '' } };
  assert.equal((await getDesktopCommandStatus(changed)).state, 'installed');
  assert.equal((await unregisterDesktopCommand(changed)).state, 'missing');
  await prepareDesktopLauncher(changed);
  await assert.rejects(fsp.lstat(installed.path), { code: 'ENOENT' });
});

test('does not uninstall an existing command or a user replacement of its own link', async (t) => {
  const options = await fixture(t);
  const installed = await registerDesktopCommand(options);
  await fsp.unlink(installed.path);
  await fsp.writeFile(installed.path, 'replacement', { mode: 0o755 });
  assert.equal((await unregisterDesktopCommand(options)).state, 'external');
  assert.equal(await fsp.readFile(installed.path, 'utf8'), 'replacement');
});

test('serializes register and uninstall requests from different windows', async (t) => {
  const options = await fixture(t);
  const registration = registerDesktopCommand(options);
  const removal = unregisterDesktopCommand(options);
  assert.equal((await registration).state, 'installed');
  assert.equal((await removal).state, 'missing');
  assert.equal((await getDesktopCommandStatus(options)).state, 'missing');
});

test('reports a corrupt registration record without claiming the command is missing', async (t) => {
  const options = await fixture(t);
  await prepareDesktopLauncher(options);
  await fsp.writeFile(path.join(options.dataDir, 'desktop', 'chamber-command.json'), '{broken');
  await assert.rejects(getDesktopCommandStatus(options));
  await assert.rejects(registerDesktopCommand(options));
  await assert.rejects(fsp.lstat(path.join(options.bin, 'chamber')), { code: 'ENOENT' });
});
