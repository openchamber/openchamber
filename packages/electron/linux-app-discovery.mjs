import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_XDG_DATA_DIRS = ['/usr/local/share', '/usr/share'];
const TARGET_FIELD_CODES = new Set(['f', 'F', 'u', 'U']);
const TERMINAL_APP_IDS = new Set(['terminal', 'iterm2', 'ghostty']);
// Terminals with a documented working-directory option, for desktop entries
// whose Exec has no field code to put the directory in.
const TERMINAL_DIRECTORY_FLAGS = new Map([
  ['alacritty', '--working-directory='],
  ['foot', '--working-directory='],
  ['ghostty', '--working-directory='],
  ['kitty', '--directory='],
  ['ptyxis', '--working-directory='],
  ['tilix', '--working-directory='],
]);
const DEFAULT_TERMINAL_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_TERMINAL_MAX_INSPECTED_BYTES = 1024 * 1024;
// A candidate that exits non-zero within this window failed to open, so the
// chain moves on. A terminal that is still running after it counts as opened.
const LINUX_LAUNCH_SETTLE_MS = 1000;

const LINUX_CLI_BY_APP_ID = {
  vscode: 'code',
  cursor: 'cursor',
  vscodium: 'codium',
  windsurf: 'windsurf',
  zed: 'zed',
  'sublime-text': 'subl',
};

const uniqueStrings = (values) => {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const candidate = typeof value === 'string' ? value.trim() : '';
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
};

const desktopBoolean = (value) => String(value || '').trim().toLowerCase() === 'true';
const unescapeDesktopValue = (value) => String(value || '')
  .replace(/\\s/g, ' ')
  .replace(/\\n/g, '\n')
  .replace(/\\t/g, '\t')
  .replace(/\\r/g, '\r')
  .replace(/\\\\/g, '\\');
const normalizeComparable = (value) => String(value || '')
  .toLowerCase()
  .replace(/\.desktop$/i, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();
const normalizeCompactComparable = (value) => normalizeComparable(value).replace(/\s+/g, '');

const stripDesktopExecFieldCodes = (execValue) => String(execValue || '')
  .replace(/%%/g, '\^@')
  .replace(/%[fFuUdDnNickvm]/g, '')
  .replace(/%./g, '')
  .replace(/\^@/g, '%')
  .replace(/\s+/g, ' ')
  .trim();

// %u/%U carry a URI, and buildCommandFromDesktopExec substitutes a plain path
// there, so only a path field code puts the directory where a terminal takes it.
const hasPathFieldCode = (execValue) => {
  const value = String(execValue || '').replace(/%%/g, '');
  return /%[fF]/.test(value);
};

export const linuxApplicationDirs = ({ env = process.env, homeDir = os.homedir() } = {}) => {
  const dataHome = typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim()
    ? env.XDG_DATA_HOME.trim()
    : path.join(homeDir || os.homedir(), '.local', 'share');
  const dataDirs = typeof env.XDG_DATA_DIRS === 'string' && env.XDG_DATA_DIRS.trim()
    ? env.XDG_DATA_DIRS.split(':').filter(Boolean)
    : DEFAULT_XDG_DATA_DIRS;
  return uniqueStrings([
    path.join(dataHome, 'applications'),
    ...dataDirs.map((dir) => path.join(dir, 'applications')),
    '/usr/local/share/applications',
    '/usr/share/applications',
  ]).map((entry) => path.resolve(entry));
};

const parseDesktopValues = (content) => {
  const values = new Map();
  let group = '';
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      group = line.slice(1, -1).trim();
      continue;
    }
    if (group !== 'Desktop Entry') continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!key || key.includes('[') || values.has(key)) continue;
    values.set(key, unescapeDesktopValue(line.slice(separator + 1)));
  }
  return values;
};

const desktopIdFromPath = (filePath) => path.basename(filePath || '').replace(/\.desktop$/i, '');

const hidesDesktopEntry = (values) => desktopBoolean(values.get('NoDisplay')) || desktopBoolean(values.get('Hidden'));

const desktopEntryFromValues = (values, filePath = '') => {
  if ((values.get('Type') || 'Application') !== 'Application') return null;
  if (hidesDesktopEntry(values)) return null;
  const name = String(values.get('Name') || '').trim();
  const rawExec = String(values.get('Exec') || '').trim();
  const exec = stripDesktopExecFieldCodes(rawExec);
  if (!name || !rawExec || !exec) return null;
  return {
    id: desktopIdFromPath(filePath) || name,
    name,
    exec,
    rawExec,
    icon: String(values.get('Icon') || '').trim() || null,
    categories: String(values.get('Categories') || '').split(';').map((entry) => entry.trim()).filter(Boolean),
    filePath,
  };
};

export const parseDesktopEntry = (content, filePath = '') => desktopEntryFromValues(parseDesktopValues(content), filePath);

const collectDesktopFiles = async (dir) => {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectDesktopFiles(candidate));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.desktop')) {
      files.push(candidate);
    }
  }
  return files;
};

export const readLinuxDesktopEntries = async (options = {}) => {
  const dirs = Array.isArray(options.applicationDirs) ? options.applicationDirs : linuxApplicationDirs(options);
  const files = [];
  for (const dir of dirs) files.push(...await collectDesktopFiles(dir));
  const seen = new Set();
  const entries = [];
  for (const filePath of files) {
    try {
      const values = parseDesktopValues(await fsp.readFile(filePath, 'utf8'));
      const parsed = desktopEntryFromValues(values, filePath);
      if (!parsed) {
        // A user-level file that hides an app also removes the system entry with
        // the same id: Hidden means "strictly equivalent to the .desktop file not
        // existing at all" (Desktop Entry Spec), and NoDisplay shadows it the same
        // way any other same-id file does.
        if (hidesDesktopEntry(values)) seen.add(desktopIdFromPath(filePath));
        continue;
      }
      if (seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      entries.push(parsed);
    } catch {
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
};

const desktopEntryMatchesApp = (entry, appName, appId = '') => {
  const needles = uniqueStrings([appName, appId]).flatMap((value) => [normalizeComparable(value), normalizeCompactComparable(value)]).filter(Boolean);
  const haystacks = [entry.name, entry.id, path.basename(entry.filePath || ''), entry.exec]
    .flatMap((value) => [normalizeComparable(value), normalizeCompactComparable(value)])
    // A value with no ASCII letters or digits (e.g. a CJK-only Name) normalizes to the empty
    // string, and needle.includes('') is true for every app — drop it so such entries can
    // only match through a field that still carries comparable text.
    .filter(Boolean);
  return needles.some((needle) => haystacks.some((haystack) => haystack === needle || haystack.includes(needle) || needle.includes(haystack)));
};

const parseExecCommand = (exec) => {
  const args = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of String(exec || '')) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  if (current) args.push(current);
  return args;
};

export const buildCommandFromDesktopExec = (entry, targetPath, { appendTarget = true } = {}) => {
  const tokens = parseExecCommand(entry?.rawExec || entry?.exec || '');
  if (tokens.length === 0) return null;
  let targetInserted = false;
  const args = [];
  for (const token of tokens.slice(1)) {
    let rendered = token.replace(/%([a-zA-Z%])/g, (_match, code) => {
      if (TARGET_FIELD_CODES.has(code)) {
        targetInserted = true;
        return targetPath;
      }
      if (code === 'c') return entry.name || '';
      if (code === 'k') return entry.filePath || '';
      if (code === '%') return '%';
      return '';
    });
    rendered = rendered.trim();
    if (rendered) args.push(rendered);
  }
  if (appendTarget && !targetInserted) args.push(targetPath);
  return { program: tokens[0], args };
};

const resolveCommandPath = (program, env = process.env) => {
  if (!program) return null;
  const candidates = program.includes(path.sep)
    ? [program]
    : String(env.PATH || '').split(':').filter(Boolean).map((dir) => path.join(dir, program));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
    }
  }
  return null;
};

const commandExists = (program, env = process.env) => resolveCommandPath(program, env) !== null;

const findEntry = (entries, appId, appName) => entries.find((entry) => desktopEntryMatchesApp(entry, appName, appId)) || null;

const isTerminalEmulatorEntry = (entry) => {
  const categories = Array.isArray(entry?.categories) ? entry.categories : [];
  return categories.some((category) => normalizeComparable(category) === 'terminalemulator');
};

const terminalDirectoryFlag = (entry) => {
  const exec = String(entry?.rawExec || entry?.exec || '').replace(/%%/g, '');
  if (/%[fFuU]/.test(exec)) return null;
  return TERMINAL_DIRECTORY_FLAGS.get(path.basename(parseExecCommand(exec)[0] || '')) || null;
};

// A terminal emulator runs a positional argument as the command to execute, so
// a terminal entry only receives the directory through a path field code or an
// option known to take it.
const isLaunchableTerminalEmulatorEntry = (entry) => (
  isTerminalEmulatorEntry(entry)
  && (hasPathFieldCode(entry.rawExec || entry.exec) || terminalDirectoryFlag(entry) !== null)
);

const buildTerminalEntrySpec = (entry, directory) => {
  const spec = buildCommandFromDesktopExec(entry, directory, { appendTarget: false });
  const flag = terminalDirectoryFlag(entry);
  return spec && flag ? { ...spec, args: [`${flag}${directory}`, ...spec.args] } : spec;
};

const readExecutableContents = async (filePath) => {
  let handle = null;
  try {
    handle = await fsp.open(filePath, 'r');
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(DEFAULT_TERMINAL_MAX_INSPECTED_BYTES), 0, DEFAULT_TERMINAL_MAX_INSPECTED_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};

const queryDefaultTerminalSelection = (env) => new Promise((resolve) => {
  const child = spawn('xdg-terminal-exec', ['--print-id'], { env, stdio: 'ignore', detached: true });
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
    }
    resolve(false);
  }, DEFAULT_TERMINAL_PROBE_TIMEOUT_MS);
  const finish = (selected) => {
    clearTimeout(timer);
    resolve(selected);
  };
  child.once('error', () => finish(false));
  child.once('exit', (code) => finish(code === 0));
});

// A packaged launcher can forward to the implementation: Nix installs a compiled
// wrapper that holds the implementation's absolute path as a string. Those paths
// are only read here, so the launcher still runs nothing it would not run itself.
const readDefaultTerminalImplementation = async (env) => {
  const launcher = await readExecutableContents(resolveCommandPath('xdg-terminal-exec', env));
  if (!launcher || launcher.includes('--dir=')) return launcher;
  const forwardedPaths = (launcher.toString('latin1').match(/\/[\w.+@/-]+/g) ?? [])
    .filter((candidate) => path.basename(candidate).includes('xdg-terminal-exec'));
  for (const candidate of new Set(forwardedPaths)) {
    const contents = await readExecutableContents(candidate);
    if (contents?.includes('--dir=')) return contents;
  }
  return null;
};

// Reference versions up to 0.12 have neither --print-id nor --help: they drop
// unknown options and open the terminal, so asking a binary what it supports can
// itself open a window. Its own file answers that without running it. A version
// with --dir= but no --print-id stays a candidate, because it exits at once when
// it finds no terminal and the chain then moves on.
const canUseDefaultTerminal = async (env) => {
  const contents = await readDefaultTerminalImplementation(env);
  if (!contents?.includes('--dir=')) return false;
  if (!contents.includes('--print-id')) return true;
  return queryDefaultTerminalSelection(env);
};

export const buildLinuxOpenSpecs = ({ targetPath, appId, appName, targetKind = 'path', entries = [], env = process.env }) => {
  if (appId === 'finder') {
    return [{ kind: 'default', targetKind, targetPath }];
  }
  const specs = [];
  if (TERMINAL_APP_IDS.has(appId)) {
    const directory = targetKind === 'file' ? path.dirname(targetPath) : targetPath;
    // Its reference implementation parses only --dir=<path>; the spaced form and
    // unknown options are ignored, and the path then falls through as the
    // positional command to execute. `ready` runs when the chain reaches this
    // spec, so an explicit app that opens never touches the binary.
    const defaultTerminalSpec = commandExists('xdg-terminal-exec', env)
      ? { program: 'xdg-terminal-exec', args: [`--dir=${directory}`], ready: () => canUseDefaultTerminal(env) }
      : null;
    // It launches the terminal the user configured as their default, so it is
    // the first choice for the generic "terminal" id; an explicit id keeps its
    // own entry first.
    if (appId === 'terminal' && defaultTerminalSpec) specs.push(defaultTerminalSpec);
    const terminalEntry = appId === 'terminal'
      ? entries.find(isLaunchableTerminalEmulatorEntry) || null
      : findEntry(entries, appId, appName);
    if (terminalEntry) {
      const spec = buildTerminalEntrySpec(terminalEntry, directory);
      if (spec) specs.push(spec);
    }
    if (appId !== 'terminal' && defaultTerminalSpec) specs.push(defaultTerminalSpec);
    if (commandExists('gnome-terminal', env)) {
      specs.push({ program: 'gnome-terminal', args: [`--working-directory=${directory}`] });
    }
    if (commandExists('konsole', env)) {
      specs.push({ program: 'konsole', args: ['--workdir', directory] });
    }
    if (commandExists('xfce4-terminal', env)) {
      specs.push({ program: 'xfce4-terminal', args: [`--working-directory=${directory}`] });
    }
    if (commandExists('x-terminal-emulator', env)) {
      specs.push({ program: 'x-terminal-emulator', args: [] });
    }
    if (appId === 'terminal' && !terminalEntry) {
      // Nothing above took the directory, so this entry gets it only through the
      // working directory it inherits.
      const anyTerminalEntry = entries.find(isTerminalEmulatorEntry);
      const spec = anyTerminalEntry
        ? buildCommandFromDesktopExec(anyTerminalEntry, directory, { appendTarget: false })
        : null;
      if (spec) specs.push(spec);
    }
    // The inherited working directory reaches every terminal that starts its own
    // process, which covers candidates with no option for it.
    return specs.map((spec) => ({ ...spec, cwd: directory }));
  }
  const cli = LINUX_CLI_BY_APP_ID[appId];
  if (cli && commandExists(cli, env)) {
    specs.push({ program: cli, args: appId === 'zed' ? [targetPath] : ['-n', targetPath] });
  }
  const entry = findEntry(entries, appId, appName);
  if (entry) {
    const spec = buildCommandFromDesktopExec(entry, targetPath);
    if (spec) specs.push(spec);
  }
  return specs;
};

const spawnDetachedLinux = (spec, env) => new Promise((resolve, reject) => {
  const child = spawn(spec.program, spec.args, {
    detached: true,
    stdio: 'ignore',
    env,
    cwd: spec.cwd,
  });
  let settled = false;
  let settleTimer = null;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(settleTimer);
    child.unref();
    callback(value);
  };
  child.once('error', (error) => finish(reject, error));
  child.once('spawn', () => {
    settleTimer = setTimeout(() => finish(resolve), LINUX_LAUNCH_SETTLE_MS);
  });
  child.once('exit', (code, signal) => {
    if (code === 0) finish(resolve);
    else finish(reject, new Error(`exited with ${signal || `code ${code}`}`));
  });
});

export const runLinuxSpecChain = async (specs, appName, { shell, env = process.env }) => {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error(`Failed to open in ${appName}: no launch candidates`);
  }

  const failures = [];
  for (const spec of specs) {
    if (spec.kind === 'default') {
      if (spec.targetKind === 'file') {
        shell.showItemInFolder(spec.targetPath);
        return;
      }
      const errorMessage = await shell.openPath(spec.targetPath);
      if (!errorMessage) return;
      failures.push(`default opener: ${errorMessage}`);
      continue;
    }

    if (spec.ready && !await spec.ready()) {
      failures.push(`${spec.program}: not usable`);
      continue;
    }

    try {
      await spawnDetachedLinux(spec, env);
      return;
    } catch (error) {
      failures.push(`${spec.program}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Failed to open in ${appName}: ${failures.join('; ')}`);
};

export const filterLinuxInstalledApps = async (apps, options = {}) => {
  const entries = options.entries || await readLinuxDesktopEntries(options);
  const requested = Array.isArray(apps) ? apps : [];
  return requested
    .map((appName) => String(appName || '').trim())
    .filter((appName) => appName && entries.some((entry) => desktopEntryMatchesApp(entry, appName)));
};

const FILE_MANAGER_FALLBACK_IDS = [
  'org.gnome.Nautilus',
  'org.xfce.thunar',
  'thunar',
  'nemo',
  'org.kde.dolphin',
  'dolphin',
  'pcmanfm',
  'caja',
  'nautilus',
  'xfce4-file-manager',
];

const FILE_MANAGER_ICON_FALLBACKS = [
  'system-file-manager',
  'org.xfce.thunar',
  'org.gnome.Nautilus',
  'folder',
];

const ICON_SIZE_DIRS = [
  '48x48', '48',
  '32x32', '32',
  '64x64', '64',
  '24x24', '24',
  '22x22', '22',
  '16x16', '16',
  '128x128', '128',
  '256x256', '256',
  'scalable',
];

const ICON_CATEGORIES = ['apps', 'places', 'status', 'devices', 'mimetypes', 'legacy'];

const pathExistsSync = (candidate) => {
  try {
    fs.accessSync(candidate, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const linuxIconThemeDirs = ({ env = process.env, homeDir = os.homedir() } = {}) => {
  const dataHome = typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim()
    ? env.XDG_DATA_HOME.trim()
    : path.join(homeDir || os.homedir(), '.local', 'share');
  const dataDirs = typeof env.XDG_DATA_DIRS === 'string' && env.XDG_DATA_DIRS.trim()
    ? env.XDG_DATA_DIRS.split(':').filter(Boolean)
    : DEFAULT_XDG_DATA_DIRS;
  return uniqueStrings([
    path.join(dataHome, 'icons'),
    path.join(homeDir || os.homedir(), '.icons'),
    ...dataDirs.map((dir) => path.join(dir, 'icons')),
    '/usr/local/share/icons',
    '/usr/share/icons',
  ]).map((entry) => path.resolve(entry));
};

const listThemeNames = (iconsRoot) => {
  let entries;
  try {
    entries = fs.readdirSync(iconsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const themes = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  // Prefer the freedesktop fallback theme first, then whatever else is installed.
  themes.sort((left, right) => {
    if (left === 'hicolor') return -1;
    if (right === 'hicolor') return 1;
    return left.localeCompare(right);
  });
  return themes;
};

const lookForIconInTheme = (themeRoot, iconName) => {
  let pngMatch = null;
  let svgMatch = null;
  for (const size of ICON_SIZE_DIRS) {
    for (const category of ICON_CATEGORIES) {
      const pngPath = path.join(themeRoot, size, category, `${iconName}.png`);
      if (pathExistsSync(pngPath)) {
        // Prefer mid-size PNGs that UI list icons can display without SVG tooling.
        if (size !== 'scalable') return pngPath;
        pngMatch = pngMatch || pngPath;
      }
      const svgPath = path.join(themeRoot, size, category, `${iconName}.svg`);
      if (!svgMatch && pathExistsSync(svgPath)) svgMatch = svgPath;
    }
  }
  return pngMatch || svgMatch;
};

export const resolveLinuxIconFile = (iconName, options = {}) => {
  const raw = typeof iconName === 'string' ? iconName.trim() : '';
  if (!raw) return null;
  if (path.isAbsolute(raw) && pathExistsSync(raw)) return raw;
  if (raw.includes(path.sep) && pathExistsSync(raw)) return path.resolve(raw);

  const baseName = raw.replace(/\.(png|svg|xpm|ico)$/i, '');
  const iconRoots = linuxIconThemeDirs(options);
  for (const iconsRoot of iconRoots) {
    for (const theme of listThemeNames(iconsRoot)) {
      const match = lookForIconInTheme(path.join(iconsRoot, theme), baseName);
      if (match) return match;
    }
  }

  const dataHome = typeof options.env?.XDG_DATA_HOME === 'string' && options.env.XDG_DATA_HOME.trim()
    ? options.env.XDG_DATA_HOME.trim()
    : path.join(options.homeDir || os.homedir(), '.local', 'share');
  const dataDirs = typeof options.env?.XDG_DATA_DIRS === 'string' && options.env.XDG_DATA_DIRS.trim()
    ? options.env.XDG_DATA_DIRS.split(':').filter(Boolean)
    : DEFAULT_XDG_DATA_DIRS;
  for (const pixmapsDir of uniqueStrings([
    path.join(dataHome, 'pixmaps'),
    ...dataDirs.map((dir) => path.join(dir, 'pixmaps')),
    '/usr/share/pixmaps',
    '/usr/local/share/pixmaps',
  ])) {
    for (const ext of ['.png', '.svg', '.xpm']) {
      const candidate = path.join(pixmapsDir, `${baseName}${ext}`);
      if (pathExistsSync(candidate)) return candidate;
    }
  }
  return null;
};

const resolveDefaultLinuxFileManagerId = ({ env = process.env, execFileSyncImpl = execFileSync } = {}) => {
  try {
    const output = String(execFileSyncImpl('xdg-mime', ['query', 'default', 'inode/directory'], {
      encoding: 'utf8',
      timeout: 1500,
      env,
    }) || '').trim();
    if (!output) return null;
    return output.replace(/\.desktop$/i, '');
  } catch {
    return null;
  }
};

export const findLinuxFileManagerEntry = (entries, options = {}) => {
  const list = Array.isArray(entries) ? entries : [];
  const defaultId = resolveDefaultLinuxFileManagerId(options);
  if (defaultId) {
    const match = list.find((entry) => (
      entry.id === defaultId
      || path.basename(entry.filePath || '', '.desktop') === defaultId
      || normalizeComparable(entry.id) === normalizeComparable(defaultId)
    ));
    if (match) return match;
  }
  for (const fallbackId of FILE_MANAGER_FALLBACK_IDS) {
    const match = list.find((entry) => (
      entry.id === fallbackId
      || path.basename(entry.filePath || '', '.desktop') === fallbackId
      || normalizeComparable(entry.id) === normalizeComparable(fallbackId)
    ));
    if (match) return match;
  }
  return list.find((entry) => {
    const categories = Array.isArray(entry.categories) ? entry.categories : [];
    return categories.includes('FileManager') || categories.includes('FileTools');
  }) || null;
};

const iconFileToDataUrl = (filePath) => {
  if (!filePath || !/\.png$/i.test(filePath)) return null;
  try {
    return `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch {
    return null;
  }
};

const resolveIconDataUrlForName = (iconNames, options = {}) => {
  for (const iconName of uniqueStrings(iconNames)) {
    const filePath = resolveLinuxIconFile(iconName, options);
    const dataUrl = iconFileToDataUrl(filePath);
    if (dataUrl) return dataUrl;
  }
  return null;
};

const isLinuxFileManagerName = (name) => {
  const normalized = normalizeComparable(name);
  return normalized === 'finder'
    || normalized === 'file manager'
    || normalized === 'file explorer';
};

const knownLinuxAppIdForName = (name) => {
  const normalized = normalizeComparable(name);
  const knownIdByName = new Map([
    ['visual studio code', 'vscode'],
    ['cursor', 'cursor'],
    ['vscodium', 'vscodium'],
    ['windsurf', 'windsurf'],
    ['zed', 'zed'],
    ['sublime text', 'sublime-text'],
  ]);
  if (knownIdByName.has(normalized)) return knownIdByName.get(normalized);
  return Object.entries(LINUX_CLI_BY_APP_ID).find(([, cli]) => {
    return normalized.includes(normalizeComparable(cli)) || normalizeCompactComparable(name).includes(cli);
  })?.[0] || null;
};

export const buildLinuxInstalledApps = async (apps, options = {}) => {
  const entries = options.entries || await readLinuxDesktopEntries(options);
  const env = options.env || process.env;
  const names = uniqueStrings(Array.isArray(apps) ? apps.map(String) : []);
  const fileManagerEntry = findLinuxFileManagerEntry(entries, { ...options, env });
  return names
    .filter((name) => {
      const normalized = normalizeComparable(name);
      if (isLinuxFileManagerName(name)) return true;
      if (normalized === 'terminal') return true;
      if (entries.some((entry) => desktopEntryMatchesApp(entry, name))) return true;
      const mappedId = knownLinuxAppIdForName(name);
      const cli = mappedId ? LINUX_CLI_BY_APP_ID[mappedId] : '';
      return Boolean(cli && commandExists(cli, env));
    })
    .map((name) => {
      let iconDataUrl = null;
      if (isLinuxFileManagerName(name)) {
        iconDataUrl = resolveIconDataUrlForName([
          fileManagerEntry?.icon,
          ...FILE_MANAGER_ICON_FALLBACKS,
        ], { ...options, env });
      } else if (normalizeComparable(name) === 'terminal') {
        const terminalEntry = entries.find(isTerminalEmulatorEntry)
          || findEntry(entries, 'ghostty', 'Ghostty');
        iconDataUrl = resolveIconDataUrlForName([
          terminalEntry?.icon,
          'utilities-terminal',
          'org.gnome.Terminal',
          'terminal',
        ], { ...options, env });
      } else {
        const entry = findEntry(entries, knownLinuxAppIdForName(name) || '', name);
        iconDataUrl = resolveIconDataUrlForName([entry?.icon], { ...options, env });
      }
      return { name, iconDataUrl };
    });
};

export const fetchLinuxAppIcons = async (apps = [], options = {}) => {
  const infos = await buildLinuxInstalledApps(apps, options);
  return infos
    .filter((entry) => typeof entry.iconDataUrl === 'string' && entry.iconDataUrl)
    .map((entry) => ({ app: entry.name, data_url: entry.iconDataUrl }));
};
