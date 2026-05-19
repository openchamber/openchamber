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
  .replace(/%%/g, '\u0000')
  .replace(/%[fFuUdDnNickvm]/g, '')
  .replace(/%./g, '')
  .replace(/\u0000/g, '%')
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

export const buildLinuxInstalledApps = async (apps, options = {}) => {
  const entries = options.entries || await readLinuxDesktopEntries(options);
  const names = uniqueStrings(Array.isArray(apps) ? apps.map(String) : []);
  return names
    .filter((name) => entries.some((entry) => desktopEntryMatchesApp(entry, name)))
    .map((name) => ({ name, iconDataUrl: null }));
};

export const fetchLinuxAppIcons = async () => [];
