import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildLinuxAutostartDesktopEntry,
  readLinuxAutostartEnabled,
  resolveLinuxAutostartFilePath,
  resolveLinuxLaunchExecutable,
  setLinuxAutostartEnabled,
} from './linux-autostart.mjs';

const makeLab = async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-autostart-'));
  const env = { XDG_CONFIG_HOME: path.join(homeDir, 'config') };
  return { env, homeDir, filePath: resolveLinuxAutostartFilePath({ env, homeDir }) };
};

const writeEntry = async (filePath, contents) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
};

const enable = (lab, overrides = {}) => setLinuxAutostartEnabled({
  enabled: true,
  backgroundArg: '--background',
  env: { ...lab.env, APPIMAGE: '/opt/OpenChamber.AppImage' },
  homeDir: lab.homeDir,
  ...overrides,
});

test('prefers APPIMAGE path for Linux autostart Exec', () => {
  assert.equal(
    resolveLinuxLaunchExecutable({
      env: { APPIMAGE: '/home/user/OpenChamber.AppImage' },
      execPath: '/tmp/.mount_OpenChXXXX/openchamber',
    }),
    '/home/user/OpenChamber.AppImage',
  );
});

test('builds a background autostart desktop entry', () => {
  const entry = buildLinuxAutostartDesktopEntry({
    executable: '/home/user/Open Chamber.AppImage',
    backgroundArg: '--background',
  });
  assert.match(entry, /Type=Application/);
  assert.match(entry, /Exec="\/home\/user\/Open Chamber\.AppImage" --background/);
  assert.match(entry, /X-GNOME-Autostart-enabled=true/);
  assert.match(entry, /X-OpenChamber-Managed=true/);
});

test('writes and removes the XDG autostart file', async () => {
  const { env, homeDir, filePath } = await makeLab();

  try {
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), false);

    const enabled = await setLinuxAutostartEnabled({
      enabled: true,
      backgroundArg: '--background',
      env: { ...env, APPIMAGE: '/opt/OpenChamber.AppImage' },
      homeDir,
    });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.filePath, filePath);
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), true);

    const contents = await fs.readFile(filePath, 'utf8');
    assert.match(contents, /Exec=\/opt\/OpenChamber\.AppImage --background/);

    const disabled = await setLinuxAutostartEnabled({
      enabled: false,
      env,
      homeDir,
    });
    assert.equal(disabled.enabled, false);
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), false);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('a foreign entry under the autostart name is never written or deleted', async () => {
  const { env, homeDir, filePath } = await makeLab();
  const foreign = '[Desktop Entry]\nType=Application\nName=OpenChamber (Gear Lever)\nExec=env DESKTOPINTEGRATION=1 /home/u/openchamber.appimage\nStartupWMClass=openchamber\n';

  try {
    await writeEntry(filePath, foreign);

    const enableAttempt = await setLinuxAutostartEnabled({ enabled: true, env, homeDir });
    assert.equal(enableAttempt.supported, false);
    assert.equal(enableAttempt.foreignEntry, true);
    assert.equal(await fs.readFile(filePath, 'utf8'), foreign);

    const disableAttempt = await setLinuxAutostartEnabled({ enabled: false, env, homeDir });
    assert.equal(disableAttempt.supported, false);
    assert.equal(disableAttempt.foreignEntry, true);
    assert.equal(await fs.readFile(filePath, 'utf8'), foreign);

    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), true);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('enabling again preserves user keys and rewrites managed keys in place', async () => {
  const { env, homeDir, filePath } = await makeLab();

  try {
    await setLinuxAutostartEnabled({
      enabled: true,
      backgroundArg: '--background',
      env: { ...env, APPIMAGE: '/opt/OpenChamber.AppImage' },
      homeDir,
    });
    const userEdited = `${await fs.readFile(filePath, 'utf8')}X-GNOME-Autostart-Delay=30\nComment=My custom note\n`;
    await fs.writeFile(filePath, userEdited);

    await setLinuxAutostartEnabled({
      enabled: true,
      appName: 'OpenChamber',
      backgroundArg: '--background',
      env: { ...env, APPIMAGE: '/moved/OpenChamber.AppImage' },
      homeDir,
    });

    const contents = await fs.readFile(filePath, 'utf8');
    assert.match(contents, /X-GNOME-Autostart-Delay=30/);
    assert.match(contents, /Comment=My custom note/);
    assert.match(contents, /X-OpenChamber-Managed=true/);
    // Managed keys update in place rather than appending duplicates.
    assert.equal(contents.match(/^Exec=/gm)?.length, 1);
    assert.equal(contents.match(/^X-GNOME-Autostart-enabled=/gm)?.length, 1);
    assert.match(contents, /Exec=\/moved\/OpenChamber\.AppImage --background/);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('a relaunch that would generate identical content writes nothing', async () => {
  const { homeDir, filePath } = await makeLab();

  try {
    await enable({ homeDir, env: { XDG_CONFIG_HOME: path.join(homeDir, 'config'), APPIMAGE: '/opt/OpenChamber.AppImage' } });
    const before = await fs.stat(filePath);
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(filePath, past, past);

    await enable({ homeDir, env: { XDG_CONFIG_HOME: path.join(homeDir, 'config'), APPIMAGE: '/opt/OpenChamber.AppImage' } });

    const after = await fs.stat(filePath);
    assert.equal(after.mtimeMs, past.getTime());
    assert.equal((await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith('.tmp')).length, 0);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('a user-disabled managed entry reads as disabled', async () => {
  const { env, homeDir, filePath } = await makeLab();

  try {
    await enable({ env, homeDir });
    const entry = await fs.readFile(filePath, 'utf8');

    await fs.writeFile(filePath, `${entry}Hidden=true\n`);
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), false);

    await fs.writeFile(filePath, `${entry}NoDisplay=true\n`);
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), false);

    await fs.writeFile(filePath, entry.replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'));
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), false);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('re-enabling a user-disabled managed entry clears the disabled markers', async () => {
  const { env, homeDir, filePath } = await makeLab();

  try {
    await enable({ env, homeDir });
    const entry = await fs.readFile(filePath, 'utf8');
    await fs.writeFile(filePath, `${entry}Hidden=true\n`);
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), false);

    const result = await setLinuxAutostartEnabled({
      enabled: true,
      backgroundArg: '--background',
      env: { ...env, APPIMAGE: '/opt/OpenChamber.AppImage' },
      homeDir,
    });
    assert.deepEqual(
      { supported: result.supported, enabled: result.enabled },
      { supported: true, enabled: true },
    );
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), true);
    const contents = await fs.readFile(filePath, 'utf8');
    assert.doesNotMatch(contents, /Hidden=true/);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('a failed write leaves the previous entry intact and no temp file behind', async (t) => {
  if (process.geteuid?.() === 0) {
    t.skip('permission-based failure does not fail for root');
    return;
  }
  const { env, homeDir, filePath } = await makeLab();

  try {
    await enable({ env, homeDir });
    const before = await fs.readFile(filePath, 'utf8');
    await fs.chmod(path.dirname(filePath), 0o500);

    await assert.rejects(enable({ env, homeDir }, { env: { ...env, APPIMAGE: '/moved/OpenChamber.AppImage' } }));

    assert.equal(await fs.readFile(filePath, 'utf8'), before);
    assert.equal((await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith('.tmp')).length, 0);
  } finally {
    await fs.chmod(path.dirname(filePath), 0o700).catch(() => {});
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('a foreign entry with no managed key reads as enabled', async () => {
  const { env, homeDir, filePath } = await makeLab();
  const foreign = '[Desktop Entry]\nType=Application\nName=OpenChamber\nExec=/home/u/openchamber.appimage\n';

  try {
    await writeEntry(filePath, foreign);
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), true);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('managed keys are added to a file with no group header', () => {
  const entry = buildLinuxAutostartDesktopEntry({
    executable: '/opt/OpenChamber.AppImage',
    backgroundArg: '--background',
    previousContents: 'Comment=note before any header\n',
  });
  assert.match(entry, /^\[Desktop Entry\]$/m);
  assert.match(entry, /Comment=note before any header/);
  assert.match(entry, /Exec=\/opt\/OpenChamber\.AppImage --background/);
});

// Property, oracle = the preservation invariant: the managed-key rewrite keeps
// every non-managed main-group line byte-for-byte, writes each managed key
// exactly once, and is idempotent. Inputs come from a seeded generator so a
// failure reproduces from the seed printed with the assertion.
{
  const MANAGED_KEYS = ['Type', 'Name', 'Exec', 'Terminal', 'X-GNOME-Autostart-enabled', 'StartupWMClass', 'X-OpenChamber-Managed'];
  let state = 0x2f6e2b1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  const randomLine = () => {
    const pick = (values) => values[Math.floor(random() * values.length)];
    if (random() < 0.1) return '';
    if (random() < 0.1) return '# a comment';
    const key = pick(['Comment', 'Icon', 'X-GNOME-Autostart-Delay', 'Hidden', 'NoDisplay', 'Exec', 'Type', 'Name']);
    const value = pick(['true', 'false', '30', '/opt/x.AppImage', 'note with spaces', '']);
    return `${key}=${value}`;
  };

  test('the managed-key rewrite preserves user lines, is duplicate-free and idempotent', () => {
    for (let i = 0; i < 500; i += 1) {
      const lineCount = Math.floor(random() * 8);
      const lines = Array.from({ length: lineCount }, randomLine);
      const previousContents = ['[Desktop Entry]', ...lines].join('\n');
      const entry = buildLinuxAutostartDesktopEntry({
        executable: '/opt/OpenChamber.AppImage',
        backgroundArg: '--background',
        previousContents,
      });
      const entryAgain = buildLinuxAutostartDesktopEntry({
        executable: '/opt/OpenChamber.AppImage',
        backgroundArg: '--background',
        previousContents: entry,
      });
      const outputLines = entry.split('\n');
      const userLines = lines.filter((line) => {
        const separator = line.indexOf('=');
        return separator > 0 && !MANAGED_KEYS.includes(line.slice(0, separator).trim());
      });
      const userPreserved = userLines.every((line) => outputLines.includes(line));
      const managedSingle = MANAGED_KEYS.every((key) => outputLines.filter((line) => line.startsWith(`${key}=`)).length === 1);
      assert.ok(userPreserved && managedSingle && entry === entryAgain,
        `seed case ${i} violated the preservation invariant: ${JSON.stringify({ lines, entry })}`);
    }
  });
}
