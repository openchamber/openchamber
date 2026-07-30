import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_XDG_DATA_DIRS = ['/usr/local/share', '/usr/share'];
const TARGET_FIELD_CODES = new Set(['f', 'F', 'u', 'U']);
const TERMINAL_APP_IDS = new Set(['terminal', 'iterm2', 'ghostty']);

export const LINUX_CLI_BY_APP_ID = {
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

export const stripDesktopExecFieldCodes = (execValue) => String(execValue || '')
  .replace(/%%/g, '\^@')
  .replace(/%[fFuUdDnNickvm]/g, '')
  .replace(/%./g, '')
  .replace(/\^@/g, '%')
  .replace(/\s+/g, ' ')
  .trim();

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

export const parseDesktopEntry = (content, filePath = '') => {
  const values = parseDesktopValues(content);
  if ((values.get('Type') || 'Application') !== 'Application') return null;
  if (desktopBoolean(values.get('NoDisplay')) || desktopBoolean(values.get('Hidden'))) return null;
  const name = String(values.get('Name') || '').trim();
  const rawExec = String(values.get('Exec') || '').trim();
  const exec = stripDesktopExecFieldCodes(rawExec);
  if (!name || !rawExec || !exec) return null;
  return {
    id: path.basename(filePath || '').replace(/\.desktop$/i, '') || name,
    name,
    exec,
    rawExec,
    icon: String(values.get('Icon') || '').trim() || null,
    categories: String(values.get('Categories') || '').split(';').map((entry) => entry.trim()).filter(Boolean),
    filePath,
  };
};

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
      const parsed = parseDesktopEntry(await fsp.readFile(filePath, 'utf8'), filePath);
      if (!parsed || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      entries.push(parsed);
    } catch {
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
};

export const discoverLinuxDesktopApps = readLinuxDesktopEntries;

export const desktopEntryMatchesApp = (entry, appName, appId = '') => {
  const needles = uniqueStrings([appName, appId]).flatMap((value) => [normalizeComparable(value), normalizeCompactComparable(value)]).filter(Boolean);
  const haystacks = [entry.name, entry.id, path.basename(entry.filePath || ''), entry.exec]
    .flatMap((value) => [normalizeComparable(value), normalizeCompactComparable(value)]);
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

export const buildCommandFromDesktopExec = (entry, targetPath) => {
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
  if (!targetInserted) args.push(targetPath);
  return { program: tokens[0], args };
};

const commandExists = (program, env = process.env) => {
  if (!program) return false;
  if (program.includes(path.sep)) {
    try {
      fs.accessSync(program, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const dir of String(env.PATH || '').split(':').filter(Boolean)) {
    try {
      fs.accessSync(path.join(dir, program), fs.constants.X_OK);
      return true;
    } catch {
    }
  }
  return false;
};

const findEntry = (entries, appId, appName) => entries.find((entry) => desktopEntryMatchesApp(entry, appName, appId)) || null;

export const buildLinuxOpenSpecs = ({ targetPath, appId, appName, targetKind = 'path', entries = [], env = process.env }) => {
  if (appId === 'finder') {
    return [{ kind: 'default', targetKind, targetPath }];
  }
  const specs = [];
  if (TERMINAL_APP_IDS.has(appId)) {
    const directory = targetKind === 'file' ? path.dirname(targetPath) : targetPath;
    const terminalEntry = findEntry(entries, appId, appName);
    if (terminalEntry) {
      const spec = buildCommandFromDesktopExec(terminalEntry, directory);
      if (spec) specs.push(spec);
    }
    specs.push({ program: 'xdg-terminal-exec', args: ['--working-directory', directory] });
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
    return specs;
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

export const linuxIconThemeDirs = ({ env = process.env, homeDir = os.homedir() } = {}) => {
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

export const resolveDefaultLinuxFileManagerId = ({ env = process.env, execFileSyncImpl = execFileSync } = {}) => {
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
        const terminalEntry = findEntry(entries, 'terminal', name)
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
