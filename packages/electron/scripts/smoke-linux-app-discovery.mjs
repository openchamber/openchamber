import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildCommandFromDesktopExec,
  buildLinuxInstalledApps,
  buildLinuxOpenSpecs,
  fetchLinuxAppIcons,
  filterLinuxInstalledApps,
  findLinuxFileManagerEntry,
  linuxApplicationDirs,
  parseDesktopEntry,
  readLinuxDesktopEntries,
  resolveLinuxIconFile,
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
  const iconsRoot = path.join(dataDir, 'icons');
  const thunarIcon = path.join(iconsRoot, 'hicolor', '48x48', 'apps', 'org.xfce.thunar.png');
  const codeIcon = path.join(iconsRoot, 'hicolor', '32x32', 'apps', 'code.png');
  const terminalIcon = path.join(iconsRoot, 'hicolor', '48x48', 'apps', 'utilities-terminal.png');
  const helperIcon = path.join(iconsRoot, 'hicolor', '48x48', 'apps', 'helper-app.png');
  await fs.mkdir(userApps, { recursive: true });
  await fs.mkdir(systemApps, { recursive: true });
  await fs.mkdir(path.dirname(thunarIcon), { recursive: true });
  await fs.mkdir(path.dirname(codeIcon), { recursive: true });
  await fs.mkdir(path.dirname(terminalIcon), { recursive: true });
  await fs.mkdir(path.dirname(helperIcon), { recursive: true });
  // Minimal valid 1x1 PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  // Distinct PNG so the helper-app icon is distinguishable from the terminal theme icon.
  const helperPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBASZNV9oAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(thunarIcon, png);
  await fs.writeFile(codeIcon, png);
  await fs.writeFile(terminalIcon, png);
  await fs.writeFile(helperIcon, helperPng);

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
  // A non-terminal app that launches itself via xdg-terminal-exec (e.g. a TUI
  // helper). Its Exec line contains "xdg-terminal-exec", which the loose
  // substring match in desktopEntryMatchesApp would mis-attribute to the
  // generic "terminal" appId. Categories=Utility; (not TerminalEmulator) is
  // the signal that this is NOT a terminal emulator.
  await fs.writeFile(path.join(systemApps, 'helper-app.desktop'), [
    '[Desktop Entry]',
    'Type=Application',
    'NoDisplay=false',
    'Terminal=false',
    'StartupNotify=true',
    'Exec=/usr/bin/xdg-terminal-exec --app-id=helper-app --title="Helper App" -- /usr/bin/helper-script',
    `Icon=${helperIcon}`,
    'Name=Helper App',
    'Categories=Utility;',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(systemApps, 'plain.desktop'), '[Desktop Entry]\nType=Application\nName=Plain Editor\nExec=plain-editor --flag\nIcon=plain\n', 'utf8');
  await fs.writeFile(path.join(systemApps, 'thunar.desktop'), [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Thunar File Manager',
    'Exec=thunar %F',
    'Icon=org.xfce.thunar',
    'Categories=System;FileTools;FileManager;',
    '',
  ].join('\n'), 'utf8');

  const env = { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: dataDir, PATH: '/no/such/bin' };
  const dirs = linuxApplicationDirs({ env, homeDir: tempRoot });
  assert(dirs.includes(userApps), 'XDG_DATA_HOME applications dir should be included');
  assert(dirs.includes(systemApps), 'XDG_DATA_DIRS applications dir should be included');

  const entries = await readLinuxDesktopEntries({ applicationDirs: [userApps, systemApps], env, homeDir: tempRoot });
  assert(entries.length === 5, `expected 5 visible valid entries, got ${entries.length}`);
  assert(entries.some((entry) => entry.name === 'Visual Studio Code'), 'valid desktop entry should be parsed');
  assert(entries.some((entry) => entry.name === 'Ghostty'), 'system desktop entry should be parsed');
  assert(entries.some((entry) => entry.name === 'Plain Editor'), 'no-placeholder entry should be parsed');
  assert(entries.some((entry) => entry.name === 'Thunar File Manager'), 'file manager entry should be parsed');
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

  const resolvedCodeIcon = resolveLinuxIconFile('code', { env, homeDir: tempRoot });
  assert(resolvedCodeIcon === codeIcon, `resolveLinuxIconFile should find themed PNG, got ${resolvedCodeIcon}`);

  const fileManager = findLinuxFileManagerEntry(entries, {
    env,
    execFileSyncImpl: () => 'thunar.desktop',
  });
  assert(fileManager?.id === 'thunar', `default file manager should resolve via xdg-mime, got ${fileManager?.id}`);

  const appInfos = await buildLinuxInstalledApps(['Finder', 'Visual Studio Code', 'Ghostty'], {
    entries,
    env,
    homeDir: tempRoot,
    execFileSyncImpl: () => 'thunar.desktop',
  });
  assert(appInfos.length === 3, 'installed app info should include matching entries');
  assert(appInfos.every((entry) => Object.hasOwn(entry, 'iconDataUrl')), 'installed app info should include iconDataUrl key');
  const finderInfo = appInfos.find((entry) => entry.name === 'Finder');
  assert(typeof finderInfo?.iconDataUrl === 'string' && finderInfo.iconDataUrl.startsWith('data:image/png;base64,'), 'Finder/file manager should use system PNG icon data URL');
  const codeInfo = appInfos.find((entry) => entry.name === 'Visual Studio Code');
  assert(typeof codeInfo?.iconDataUrl === 'string' && codeInfo.iconDataUrl.startsWith('data:image/png;base64,'), 'desktop app should resolve Icon= theme PNG to data URL');

  const terminalEmulatorEntry = parseDesktopEntry([
    '[Desktop Entry]',
    'Type=Application',
    'Name=MyConsole',
    'Exec=myconsole --working-directory=%f',
    'Icon=utilities-terminal',
    'Categories=TerminalEmulator;',
    '',
  ].join('\n'), path.join(systemApps, 'myconsole.desktop'));
  const helperEntry = entries.find((entry) => entry.name === 'Helper App');
  const terminalIconInfos = await buildLinuxInstalledApps(['Terminal'], {
    entries: [helperEntry, terminalEmulatorEntry],
    env,
    homeDir: tempRoot,
    execFileSyncImpl: () => 'thunar.desktop',
  });
  const terminalInfo = terminalIconInfos.find((entry) => entry.name === 'Terminal');
  const expectedTerminalIconDataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const expectedHelperIconDataUrl = `data:image/png;base64,${helperPng.toString('base64')}`;
  assert(terminalInfo?.iconDataUrl === expectedTerminalIconDataUrl, `Terminal should resolve the TerminalEmulator entry icon, got ${terminalInfo?.iconDataUrl}`);
  assert(terminalInfo?.iconDataUrl !== expectedHelperIconDataUrl, 'Terminal icon must not resolve to a non-terminal entry whose Exec uses a terminal launcher (loose name/exec match regression)');

  const fetchedIcons = await fetchLinuxAppIcons(['Finder', 'Visual Studio Code'], {
    entries,
    env,
    homeDir: tempRoot,
    execFileSyncImpl: () => 'thunar.desktop',
  });
  assert(fetchedIcons.length === 2, 'fetchLinuxAppIcons should return resolved icons');
  assert(fetchedIcons.every((entry) => entry.data_url?.startsWith('data:image/png;base64,')), 'fetched icons should be PNG data URLs');

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
  assert(fallbackTerminalSpecs.length >= 1, 'missing terminal desktop entry should include xdg-terminal-exec fallback');
  assert(fallbackTerminalSpecs[0]?.program === 'xdg-terminal-exec', 'missing terminal entry should use xdg-terminal-exec first');
  assert(fallbackTerminalSpecs[0]?.args.join('|') === '--working-directory|/tmp/My Project', `xdg-terminal-exec fallback should keep working directory args, got ${fallbackTerminalSpecs[0]?.args.join('|')}`);
  assert(!fallbackTerminalSpecs.some((spec) => (spec.args || []).some((arg) => arg.includes('helper-script'))), 'non-terminal entry using a terminal launcher must not be launched for the generic terminal appId');

  const ptyxisEntry = parseDesktopEntry([
    '[Desktop Entry]',
    'Type=Application',
    'Name=Ptyxis',
    'Exec=ptyxis --working-directory=%f',
    'Categories=TerminalEmulator;',
    '',
  ].join('\n'), '/tmp/org.gnome.Ptyxis.desktop');
  const terminalEmulatorSpecs = buildLinuxOpenSpecs({
    targetPath: '/tmp/My Project',
    appId: 'terminal',
    appName: 'Terminal',
    targetKind: 'project',
    entries: [ptyxisEntry, ...entries],
    env,
  });
  assert(terminalEmulatorSpecs[0]?.program === 'ptyxis', `terminal emulator entry should be preferred, got ${terminalEmulatorSpecs[0]?.program}`);
  assert(terminalEmulatorSpecs[0]?.args.join('|') === '--working-directory=/tmp/My Project', `ptyxis should receive working directory, got ${terminalEmulatorSpecs[0]?.args.join('|')}`);
  assert(!terminalEmulatorSpecs.some((spec) => (spec.args || []).some((arg) => arg.includes('helper-script'))), 'non-terminal entry using a terminal launcher must not be launched when a real terminal emulator entry exists');

  const defaultSpecs = buildLinuxOpenSpecs({ targetPath: '/tmp/My Project', appId: 'finder', appName: 'Finder', targetKind: 'project', entries, env });
  assert(defaultSpecs[0].kind === 'default', 'finder maps to safe default Linux opener spec');

  console.log(JSON.stringify({
    ok: true,
    dirs,
    entries: entries.map((entry) => entry.name),
    command,
    ghosttyCommand,
    plainCommand,
    installed,
    finderIcon: Boolean(finderInfo?.iconDataUrl),
    codeIcon: Boolean(codeInfo?.iconDataUrl),
    fetchedIcons: fetchedIcons.map((entry) => entry.app),
    specs,
    terminalFileSpecs,
    fallbackTerminalSpecs,
    terminalEmulatorSpecs,
    defaultSpecs,
  }, null, 2));
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
