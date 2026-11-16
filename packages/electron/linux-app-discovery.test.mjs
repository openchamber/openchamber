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
  runLinuxSpecChain,
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

// A binary value is its exit code or a shell script body. `runs` lists every
// fixture run, so a test can assert what was and was not executed.
const withTempBin = async (binaries, run) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-linux-bin-'));
  const log = path.join(root, 'runs.log');
  try {
    for (const [binary, body] of Object.entries(binaries)) {
      const script = Number.isInteger(body) ? `exit ${body}` : body;
      await fs.writeFile(
        path.join(root, binary),
        `#!/bin/sh\necho "${binary} $*" >> '${log}'\n${script}\n`,
        { mode: 0o755 },
      );
    }
    const runs = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    await run({ PATH: root }, runs);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

// commandExists splits PATH on ':', so a fake bin directory cannot work there.
const WINDOWS_PATH_SKIP = { skip: process.platform === 'win32' };

const NO_PLACEHOLDER_TERMINAL = `[Desktop Entry]
Type=Application
Name=ddterm
Exec=ddterm
Icon=ddterm
Categories=TerminalEmulator;`;

const PLACEHOLDER_TERMINAL = `[Desktop Entry]
Type=Application
Name=Ptyxis
Exec=ptyxis --working-directory=%f
Icon=org.gnome.Ptyxis
Categories=TerminalEmulator;`;

const GHOSTTY_TERMINAL = `[Desktop Entry]
Type=Application
Name=Ghostty
Exec=ghostty --working-directory=%f --open-uri=%u
Icon=ghostty
Categories=TerminalEmulator;`;

const REFERENCE_DEFAULT_TERMINAL = `# parses --dir=*
case "$1" in
  --print-id) echo org.gnome.Ptyxis.desktop; exit 0 ;;
esac
exec /bin/sleep 3`;

const DEFAULT_TERMINAL_WITHOUT_QUERY = `# parses --dir=*
exec /bin/sleep 3`;

const FAILING_SHELL = { showItemInFolder: () => assert.fail('no default opener'), openPath: async () => assert.fail('no default opener') };

const openTerminal = (entries, env) => runLinuxSpecChain(buildLinuxOpenSpecs({
  targetPath: '/tmp',
  appId: 'terminal',
  appName: 'Terminal',
  targetKind: 'project',
  entries,
  env,
}), 'Terminal', { shell: FAILING_SHELL, env });

const GHOSTTY_NO_PLACEHOLDER = `[Desktop Entry]
Type=Application
Name=Ghostty
Exec=ghostty --gtk-single-instance=true
Icon=ghostty
Categories=TerminalEmulator;`;

test('the generic terminal launches xdg-terminal-exec with the --dir= form it parses', WINDOWS_PATH_SKIP, async () => {
  const entry = parseEntryAt(NO_PLACEHOLDER_TERMINAL, 'ddterm');
  await withTempBin({ 'xdg-terminal-exec': 0 }, async (env) => {
    const specs = buildLinuxOpenSpecs({
      targetPath: '/tmp/project',
      appId: 'terminal',
      appName: 'Terminal',
      targetKind: 'project',
      entries: [entry],
      env,
    });
    assert.equal(specs[0].program, 'xdg-terminal-exec');
    // The reference implementation ignores every other spelling, and the path
    // then falls through as the positional command to execute.
    assert.deepEqual(specs[0].args, ['--dir=/tmp/project']);
  });
});

test('building terminal candidates never runs xdg-terminal-exec', WINDOWS_PATH_SKIP, async () => {
  await withTempBin({ 'xdg-terminal-exec': REFERENCE_DEFAULT_TERMINAL }, async (env, runs) => {
    buildLinuxOpenSpecs({ targetPath: '/tmp/project', appId: 'terminal', appName: 'Terminal', targetKind: 'project', entries: [], env });
    assert.deepEqual(await runs(), []);
  });
});

test('a version with --print-id is asked, then launched with the directory', WINDOWS_PATH_SKIP, async () => {
  await withTempBin({ 'xdg-terminal-exec': REFERENCE_DEFAULT_TERMINAL }, async (env, runs) => {
    await openTerminal([], env);
    assert.deepEqual(await runs(), ['xdg-terminal-exec --print-id', 'xdg-terminal-exec --dir=/tmp']);
  });
});

test('a version without --print-id is launched without being asked', WINDOWS_PATH_SKIP, async () => {
  await withTempBin({ 'xdg-terminal-exec': DEFAULT_TERMINAL_WITHOUT_QUERY }, async (env, runs) => {
    await openTerminal([], env);
    assert.deepEqual(await runs(), ['xdg-terminal-exec --dir=/tmp']);
  });
});

test('a version without --dir= never runs and the chain moves on', WINDOWS_PATH_SKIP, async () => {
  await withTempBin({ 'xdg-terminal-exec': 0, 'gnome-terminal': 0 }, async (env, runs) => {
    await openTerminal([], env);
    assert.deepEqual(await runs(), ['gnome-terminal --working-directory=/tmp']);
  });
});

const writeForwardingLauncher = async (env) => {
  const implementation = path.join(env.PATH, '.xdg-terminal-exec-wrapped');
  await fs.writeFile(path.join(env.PATH, 'xdg-terminal-exec'), `#!/bin/sh\nexec '${implementation}' "$@"\n`, { mode: 0o755 });
};

test('a packaged launcher takes its capabilities from the implementation it forwards to', WINDOWS_PATH_SKIP, async () => {
  await withTempBin({ '.xdg-terminal-exec-wrapped': REFERENCE_DEFAULT_TERMINAL, 'gnome-terminal': 0 }, async (env, runs) => {
    await writeForwardingLauncher(env);
    await openTerminal([], env);
    assert.deepEqual(await runs(), ['.xdg-terminal-exec-wrapped --print-id', '.xdg-terminal-exec-wrapped --dir=/tmp']);
  });
});

test('a launcher forwarding to a version without --dir= never runs and the chain moves on', WINDOWS_PATH_SKIP, async () => {
  await withTempBin({ '.xdg-terminal-exec-wrapped': 0, 'gnome-terminal': 0 }, async (env, runs) => {
    await writeForwardingLauncher(env);
    await openTerminal([], env);
    assert.deepEqual(await runs(), ['gnome-terminal --working-directory=/tmp']);
  });
});

test('a selection failure leaves the fallback candidates available', WINDOWS_PATH_SKIP, async () => {
  await withTempBin({
    'xdg-terminal-exec': `# parses --dir=* and --print-id\nexit 1`,
    'gnome-terminal': 0,
  }, async (env, runs) => {
    await openTerminal([], env);
    assert.deepEqual(await runs(), ['xdg-terminal-exec --print-id', 'gnome-terminal --working-directory=/tmp']);
  });
});

test('a hanging --print-id is bounded and launches nothing', WINDOWS_PATH_SKIP, async () => {
  await withTempBin({
    'xdg-terminal-exec': `# parses --dir=* and --print-id\n/bin/sleep 30`,
    'gnome-terminal': 0,
  }, async (env, runs) => {
    const startedAt = performance.now();
    await openTerminal([], env);
    assert.ok(performance.now() - startedAt < 5000, 'the hanging probe must not hold the chain');
    assert.deepEqual(await runs(), ['xdg-terminal-exec --print-id', 'gnome-terminal --working-directory=/tmp']);
  });
});

test('an explicit app that opens needs no default-terminal probe', WINDOWS_PATH_SKIP, async () => {
  const ghostty = parseEntryAt(GHOSTTY_NO_PLACEHOLDER, 'com.mitchellh.ghostty');
  await withTempBin({ 'xdg-terminal-exec': REFERENCE_DEFAULT_TERMINAL, ghostty: 'exec /bin/sleep 3' }, async (env, runs) => {
    await runLinuxSpecChain(buildLinuxOpenSpecs({
      targetPath: '/tmp',
      appId: 'ghostty',
      appName: 'Ghostty',
      targetKind: 'project',
      entries: [ghostty],
      env,
    }), 'Ghostty', { shell: FAILING_SHELL, env });
    assert.deepEqual(await runs(), ['ghostty --working-directory=/tmp --gtk-single-instance=true']);
  });
});

test('a candidate that exits non-zero right after spawning reaches the next one', WINDOWS_PATH_SKIP, async () => {
  await withTempBin({
    'xdg-terminal-exec': `# parses --dir=*\nexit 1`,
    'gnome-terminal': 0,
  }, async (env, runs) => {
    await openTerminal([], env);
    assert.deepEqual(await runs(), ['xdg-terminal-exec --dir=/tmp', 'gnome-terminal --working-directory=/tmp']);
  });
});

test('a chain whose candidates all fail reports each failure', WINDOWS_PATH_SKIP, async () => {
  await withTempBin({ 'xdg-terminal-exec': 0, 'gnome-terminal': 3 }, async (env) => {
    await assert.rejects(openTerminal([], env), /xdg-terminal-exec: not usable; gnome-terminal: exited with code 3/);
  });
});

test('terminal candidates without a directory option start in the directory', WINDOWS_PATH_SKIP, async () => {
  const noPlaceholder = parseEntryAt(NO_PLACEHOLDER_TERMINAL, 'ddterm');
  await withTempBin({ 'x-terminal-emulator': 0 }, async (env) => {
    const specs = buildLinuxOpenSpecs({
      targetPath: '/tmp/project/file.txt',
      appId: 'terminal',
      appName: 'Terminal',
      targetKind: 'file',
      entries: [noPlaceholder],
      env,
    });
    assert.deepEqual(specs.map((spec) => [spec.program, spec.args, spec.cwd]), [
      ['x-terminal-emulator', [], '/tmp/project'],
      ['ddterm', [], '/tmp/project'],
    ]);
  });
});

test('a known terminal with no field code gets the directory through its option', () => {
  const kitty = parseEntryAt(`[Desktop Entry]
Type=Application
Name=kitty
Exec=kitty
Categories=TerminalEmulator;`, 'kitty');
  const kittyOpen = parseEntryAt(`[Desktop Entry]
Type=Application
Name=kitty URL Launcher
Exec=kitty +open %U
Categories=TerminalEmulator;`, 'kitty-open');
  const specs = buildLinuxOpenSpecs({
    targetPath: '/tmp/project',
    appId: 'terminal',
    appName: 'Terminal',
    targetKind: 'project',
    entries: [kittyOpen, kitty],
    env: TEST_ENV,
  });
  assert.deepEqual(specs.map((spec) => spec.args), [['--directory=/tmp/project']]);
});

test('the generic terminal skips a terminal entry that cannot receive the directory', () => {
  const noPlaceholder = parseEntryAt(NO_PLACEHOLDER_TERMINAL, 'ddterm');
  const withPlaceholder = parseEntryAt(PLACEHOLDER_TERMINAL, 'org.gnome.Ptyxis');
  const specs = buildLinuxOpenSpecs({
    targetPath: '/tmp/project',
    appId: 'terminal',
    appName: 'Terminal',
    targetKind: 'project',
    entries: [noPlaceholder, withPlaceholder],
    env: TEST_ENV,
  });
  assert.deepEqual(specs.map((spec) => spec.program), ['ptyxis']);
  assert.deepEqual(specs[0].args, ['--working-directory=/tmp/project']);
});

test('a %u-only terminal entry is not a generic terminal candidate', () => {
  const uriOnly = parseEntryAt(`[Desktop Entry]
Type=Application
Name=Uri Terminal
Exec=uri-terminal --open-uri=%u
Categories=TerminalEmulator;`, 'uri-terminal');
  const withPlaceholder = parseEntryAt(PLACEHOLDER_TERMINAL, 'org.gnome.Ptyxis');
  const specs = buildLinuxOpenSpecs({
    targetPath: '/tmp/project',
    appId: 'terminal',
    appName: 'Terminal',
    targetKind: 'project',
    entries: [uriOnly, withPlaceholder],
    env: TEST_ENV,
  });
  assert.deepEqual(specs.map((spec) => spec.program), ['ptyxis']);
});

test('the generic terminal still opens the installed terminal when nothing takes the directory', WINDOWS_PATH_SKIP, async () => {
  const noPlaceholder = parseEntryAt(NO_PLACEHOLDER_TERMINAL, 'ddterm');
  await withTempBin({ 'gnome-terminal': 0 }, async (env) => {
    const specs = buildLinuxOpenSpecs({
      targetPath: '/tmp/project',
      appId: 'terminal',
      appName: 'Terminal',
      targetKind: 'project',
      entries: [noPlaceholder],
      env,
    });
    assert.deepEqual(specs.map((spec) => spec.program), ['gnome-terminal', 'ddterm']);
    assert.deepEqual(specs[0].args, ['--working-directory=/tmp/project']);
    assert.deepEqual(specs[1].args, [], 'the last-resort terminal entry must not receive the directory as an argument');
    assert.ok(specs.every((spec) => !spec.args.includes('/tmp/project')));
  });
});

test('an escaped percent in Exec does not count as a directory placeholder', () => {
  const entry = parseEntryAt(`[Desktop Entry]
Type=Application
Name=Escaped Percent Terminal
Exec=escaped-terminal --progress=100%%
Categories=TerminalEmulator;`, 'escaped-percent-terminal');
  const specs = buildLinuxOpenSpecs({
    targetPath: '/tmp/project',
    appId: 'terminal',
    appName: 'Terminal',
    targetKind: 'project',
    entries: [entry],
    env: TEST_ENV,
  });
  assert.deepEqual(specs.map((spec) => spec.program), ['escaped-terminal']);
  assert.deepEqual(specs[0].args, ['--progress=100%']);
});

test('an explicit terminal app id still resolves its own entry first', () => {
  const noPlaceholder = parseEntryAt(NO_PLACEHOLDER_TERMINAL, 'ddterm');
  const ghostty = parseEntryAt(GHOSTTY_TERMINAL, 'com.mitchellh.ghostty');
  const specs = buildLinuxOpenSpecs({
    targetPath: '/tmp/project',
    appId: 'ghostty',
    appName: 'Ghostty',
    targetKind: 'project',
    entries: [noPlaceholder, ghostty],
    env: TEST_ENV,
  });
  assert.equal(specs[0].program, 'ghostty');
  assert.deepEqual(specs[0].args, ['--working-directory=/tmp/project', '--open-uri=/tmp/project']);
});

test('an explicit terminal entry without a path field code never gets the directory as a positional', () => {
  const ghostty = parseEntryAt(GHOSTTY_NO_PLACEHOLDER, 'com.mitchellh.ghostty');
  const specs = buildLinuxOpenSpecs({
    targetPath: '/tmp/project',
    appId: 'ghostty',
    appName: 'Ghostty',
    targetKind: 'project',
    entries: [ghostty],
    env: TEST_ENV,
  });
  assert.deepEqual(specs.map((spec) => spec.program), ['ghostty']);
  assert.deepEqual(specs[0].args, ['--working-directory=/tmp/project', '--gtk-single-instance=true']);
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
