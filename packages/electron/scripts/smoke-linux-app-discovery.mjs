import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildCommandFromDesktopExec,
  buildLinuxInstalledApps,
  buildLinuxOpenSpecs,
  filterLinuxInstalledApps,
  linuxApplicationDirs,
  parseDesktopEntry,
  readLinuxDesktopEntries,
} from '../linux-app-discovery.mjs';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-linux-apps-'));
try {
  const dataHome = path.join(tempRoot, 'data-home');
  const dataDir = path.join(tempRoot, 'system-data');
  const userApps = path.join(dataHome, 'applications');
  const systemApps = path.join(dataDir, 'applications');
  await fs.mkdir(userApps, { recursive: true });
  await fs.mkdir(systemApps, { recursive: true });

  const codeDesktopPath = path.join(userApps, 'code.desktop');
  await fs.writeFile(codeDesktopPath, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Visual Studio Code',
    'Exec="/opt/Visual Studio Code/code" --new-window %F --reuse-window %i %c %k',
    'Icon=code',
    'Categories=Development;IDE;',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(userApps, 'hidden.desktop'), '[Desktop Entry]\nType=Application\nName=Hidden App\nExec=hidden %f\nHidden=true\n', 'utf8');
  await fs.writeFile(path.join(userApps, 'nodisplay.desktop'), '[Desktop Entry]\nType=Application\nName=No Display App\nExec=nodisplay %f\nNoDisplay=true\n', 'utf8');
  await fs.writeFile(path.join(userApps, 'missing-name.desktop'), '[Desktop Entry]\nType=Application\nExec=missing %f\n', 'utf8');
  await fs.writeFile(path.join(userApps, 'missing-exec.desktop'), '[Desktop Entry]\nType=Application\nName=Missing Exec\nIcon=missing\n', 'utf8');
  await fs.writeFile(path.join(systemApps, 'ghostty.desktop'), '[Desktop Entry]\nType=Application\nName=Ghostty\nExec=ghostty --working-directory=%f --open-uri=%u\nIcon=ghostty\n', 'utf8');
  await fs.writeFile(path.join(systemApps, 'plain.desktop'), '[Desktop Entry]\nType=Application\nName=Plain Editor\nExec=plain-editor --flag\nIcon=plain\n', 'utf8');

  const env = { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: dataDir, PATH: '/no/such/bin' };
  const dirs = linuxApplicationDirs({ env, homeDir: tempRoot });
  assert(dirs.includes(userApps), 'XDG_DATA_HOME applications dir should be included');
  assert(dirs.includes(systemApps), 'XDG_DATA_DIRS applications dir should be included');

  const entries = await readLinuxDesktopEntries({ applicationDirs: [userApps, systemApps], env, homeDir: tempRoot });
  assert(entries.length === 3, `expected 3 visible valid entries, got ${entries.length}`);
  assert(entries.some((entry) => entry.name === 'Visual Studio Code'), 'valid desktop entry should be parsed');
  assert(entries.some((entry) => entry.name === 'Ghostty'), 'system desktop entry should be parsed');
  assert(entries.some((entry) => entry.name === 'Plain Editor'), 'no-placeholder entry should be parsed');
  assert(!entries.some((entry) => entry.name === 'Hidden App'), 'Hidden=true entry should be skipped');
  assert(!entries.some((entry) => entry.name === 'No Display App'), 'NoDisplay=true entry should be skipped');
  assert(!entries.some((entry) => entry.name === 'Missing Exec'), 'missing Exec entry should be skipped');

  const codeEntry = parseDesktopEntry(await fs.readFile(codeDesktopPath, 'utf8'), codeDesktopPath);
  assert(codeEntry?.name === 'Visual Studio Code', 'parser should read Name');
  assert(codeEntry?.icon === 'code', 'parser should read Icon');
  assert(codeEntry?.categories.includes('Development'), 'parser should split Categories');
  assert(codeEntry?.rawExec?.includes('%F'), 'parser should preserve original Exec placeholders for launch construction');
  assert(codeEntry?.exec === '"/opt/Visual Studio Code/code" --new-window --reuse-window', `parser should expose stripped Exec metadata, got ${codeEntry?.exec}`);

  const command = buildCommandFromDesktopExec(codeEntry, '/tmp/My Project');
  assert(command?.program === '/opt/Visual Studio Code/code', 'quoted Exec program should stay intact');
  assert(command.args.slice(0, 3).join('|') === '--new-window|/tmp/My Project|--reuse-window', `Exec %F should stay at original position, got ${command.args.join('|')}`);
  assert(!command.args.some((arg) => arg.includes('%')), 'Exec field codes should not leak into command args');

  const ghosttyEntry = entries.find((entry) => entry.name === 'Ghostty');
  const ghosttyCommand = buildCommandFromDesktopExec(ghosttyEntry, '/tmp/My Project');
  assert(ghosttyCommand?.args.join('|') === '--working-directory=/tmp/My Project|--open-uri=/tmp/My Project', `embedded %f/%u should be substituted in place, got ${ghosttyCommand?.args.join('|')}`);

  const urlEntry = parseDesktopEntry('[Desktop Entry]\nType=Application\nName=URL Handler\nExec=url-handler --url %U\n', '/tmp/url.desktop');
  const urlCommand = buildCommandFromDesktopExec(urlEntry, 'file:///tmp/My%20Project');
  assert(urlCommand?.args.join('|') === '--url|file:///tmp/My%20Project', `Exec %U should substitute URL targets, got ${urlCommand?.args.join('|')}`);

  const plainEntry = entries.find((entry) => entry.name === 'Plain Editor');
  const plainCommand = buildCommandFromDesktopExec(plainEntry, '/tmp/My Project');
  assert(plainCommand?.args.join('|') === '--flag|/tmp/My Project', `target should append when Exec has no placeholder, got ${plainCommand?.args.join('|')}`);

  const installed = await filterLinuxInstalledApps(['Visual Studio Code', 'Hidden App', 'Missing App'], { entries });
  assert(installed.length === 1 && installed[0] === 'Visual Studio Code', 'filter should return only visible installed apps');

  const appInfos = await buildLinuxInstalledApps(['Visual Studio Code', 'Ghostty'], { entries });
  assert(appInfos.length === 2, 'installed app info should include matching entries');
  assert(appInfos.every((entry) => Object.hasOwn(entry, 'iconDataUrl')), 'installed app info should include iconDataUrl key');

  const specs = buildLinuxOpenSpecs({ targetPath: '/tmp/My Project', appId: 'vscode', appName: 'Visual Studio Code', targetKind: 'project', entries, env });
  assert(specs.length === 1, 'desktop entry should provide an opener when CLI is absent');
  assert(specs[0].program === '/opt/Visual Studio Code/code', 'desktop entry opener should use parsed program');
  assert(specs[0].args.includes('/tmp/My Project'), 'desktop entry opener should include target');

  const terminalFileSpecs = buildLinuxOpenSpecs({ targetPath: '/tmp/My Project/file.txt', appId: 'ghostty', appName: 'Ghostty', targetKind: 'file', entries, env });
  assert(terminalFileSpecs[0]?.program === 'ghostty', 'terminal desktop entry should be preferred when present');
  assert(terminalFileSpecs[0]?.args.join('|') === '--working-directory=/tmp/My Project|--open-uri=/tmp/My Project', `terminal file target should use dirname, got ${terminalFileSpecs[0]?.args.join('|')}`);
  assert(terminalFileSpecs[1]?.program === 'xdg-terminal-exec', 'terminal specs should include xdg-terminal-exec fallback after desktop entry');
  assert(terminalFileSpecs[1]?.args.join('|') === '--working-directory|/tmp/My Project', `terminal fallback should use file dirname, got ${terminalFileSpecs[1]?.args.join('|')}`);

  const fallbackTerminalSpecs = buildLinuxOpenSpecs({ targetPath: '/tmp/My Project', appId: 'terminal', appName: 'Terminal', targetKind: 'project', entries, env });
  assert(fallbackTerminalSpecs.length === 1, 'missing terminal desktop entry should use only xdg-terminal-exec fallback');
  assert(fallbackTerminalSpecs[0]?.program === 'xdg-terminal-exec', 'missing terminal entry should use xdg-terminal-exec');
  assert(fallbackTerminalSpecs[0]?.args.join('|') === '--working-directory|/tmp/My Project', `xdg-terminal-exec fallback should keep working directory args, got ${fallbackTerminalSpecs[0]?.args.join('|')}`);

  const defaultSpecs = buildLinuxOpenSpecs({ targetPath: '/tmp/My Project', appId: 'finder', appName: 'Finder', targetKind: 'project', entries, env });
  assert(defaultSpecs[0].kind === 'default', 'finder maps to safe default Linux opener spec');

  console.log(JSON.stringify({ ok: true, dirs, entries: entries.map((entry) => entry.name), command, ghosttyCommand, plainCommand, installed, specs, terminalFileSpecs, fallbackTerminalSpecs, defaultSpecs }, null, 2));
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
