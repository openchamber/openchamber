import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { desktopLauncherPath, PROJECT_OPEN_ARG } from './desktop-launch.mjs';

const execFileAsync = promisify(execFile);
const LAUNCHER_MARKER = '# OpenChamber desktop launcher';
const PATH_MARKER = '# OpenChamber desktop command';
const COMMAND_NAME = 'chamber';
const registrationSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  linkPath: z.string().refine((value) => path.isAbsolute(value) && path.basename(value) === COMMAND_NAME),
  pathConfigured: z.boolean(),
});
let commandMutation = Promise.resolve();

/** Quote an app path with POSIX single quotes so path characters cannot become shell commands. */
const quoteShell = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Build a desktop launcher that needs no Node.js and resolves the directory before launch. */
export const buildDesktopLauncher = ({ platform, executablePath }) => {
  const target = platform === 'darwin'
    ? path.resolve(path.dirname(executablePath), '..', '..') : executablePath;
  const launch = platform === 'darwin'
    ? `exec /usr/bin/open -n -a ${quoteShell(target)} --args "$@"`
    : `/usr/bin/nohup ${quoteShell(target)} "$@" </dev/null >/dev/null 2>&1 &`;
  return [
    '#!/bin/sh', LAUNCHER_MARKER,
    'case "$1" in',
    `  -h|--help) printf "Usage: ${COMMAND_NAME} [directory]\\n"; exit 0 ;;`,
    '  --) shift ;;',
    'esac',
    'if [ "$#" -gt 1 ]; then printf "Expected one directory.\\n" >&2; exit 2; fi',
    'if [ "$#" -eq 1 ]; then',
    '  case "$1" in "~") set -- "$HOME" ;; "~/"*) set -- "$HOME/${1#\\~/}" ;; esac',
    '  directory=$(CDPATH= cd -P -- "$1" 2>/dev/null && pwd -P) || { printf "Cannot open directory: %s\\n" "$1" >&2; exit 2; }',
    `  set -- "${PROJECT_OPEN_ARG}$directory"`,
    'fi',
    'unset ELECTRON_RUN_AS_NODE NODE_OPTIONS',
    platform === 'linux' ? `test -x ${quoteShell(target)} || { printf "OpenChamber Desktop was moved or removed. Launch it again to repair the command.\\n" >&2; exit 1; }` : '',
    launch, '',
  ].join('\n');
};

/** Treat only missing files as absent; report permission and disk errors to the caller. */
const statIfPresent = async (filePath) => {
  try { return await fsp.lstat(filePath); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
};

/** Atomically update the app-owned launcher while preserving unrelated files at the same path. */
const writeManagedLauncher = async (launcherPath, contents) => {
  const current = await statIfPresent(launcherPath);
  if (current && (!current.isFile() || !(await fsp.readFile(launcherPath, 'utf8')).startsWith(`#!/bin/sh\n${LAUNCHER_MARKER}\n`))) {
    throw new Error('Desktop launcher path is occupied by another file.');
  }
  await fsp.mkdir(path.dirname(launcherPath), { recursive: true, mode: 0o700 });
  const temporary = `${launcherPath}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, contents, { mode: 0o755, flag: 'wx' });
    await fsp.rename(temporary, launcherPath);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
};

/** Check interactive shell aliases and functions as well as PATH to avoid shadowing user commands. */
const shellHasCommand = async (env) => {
  const shell = env.SHELL || '/bin/sh';
  try {
    await execFileAsync(shell, ['-ic', `command -v ${COMMAND_NAME} >/dev/null 2>&1`], { env, timeout: 5_000 });
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    // Skip registration when the shell state cannot be determined.
    return true;
  }
};

/** Append only a marked PATH entry without replacing existing shell configuration. */
const addUserBinToShellPath = async ({ env, homeDir }) => {
  const shell = path.basename(env.SHELL || '/bin/sh');
  const posixBlock = `\n${PATH_MARKER}\ncase ":$PATH:" in\n  *":$HOME/.local/bin:"*) ;;\n  *) export PATH="$PATH:$HOME/.local/bin" ;;\nesac\n`;
  let profiles;
  if (shell === 'zsh') profiles = [path.join(env.ZDOTDIR || homeDir, '.zshrc')];
  else if (shell === 'bash') {
    const loginProfiles = ['.bash_profile', '.bash_login', '.profile'].map((name) => path.join(homeDir, name));
    let loginProfile = loginProfiles[2];
    for (const candidate of loginProfiles) {
      if (await statIfPresent(candidate)) { loginProfile = candidate; break; }
    }
    profiles = [path.join(homeDir, '.bashrc'), loginProfile];
  } else if (shell === 'sh' || shell === 'dash' || shell === 'ksh') profiles = [path.join(homeDir, '.profile')];
  else if (shell === 'fish') {
    const profile = path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'fish', 'conf.d', 'openchamber-path.fish');
    await fsp.mkdir(path.dirname(profile), { recursive: true });
    try {
      await fsp.writeFile(profile, `${PATH_MARKER}\nfish_add_path --append "$HOME/.local/bin"\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return (await fsp.readFile(profile, 'utf8')).includes(PATH_MARKER);
    }
    return true;
  } else return false;
  for (const profile of profiles) {
    const contents = await statIfPresent(profile) ? await fsp.readFile(profile, 'utf8') : '';
    if (!contents.includes(PATH_MARKER)) await fsp.appendFile(profile, posixBlock, { mode: 0o600 });
  }
  return true;
};

/** Maintain the private launcher without creating a PATH command or changing shell configuration. */
export const prepareDesktopLauncher = async ({ platform, dataDir, executablePath }) => {
  if (platform !== 'darwin' && platform !== 'linux') return;
  await writeManagedLauncher(desktopLauncherPath(dataDir), buildDesktopLauncher({ platform, executablePath }));
};

/** Store the chamber link separately from the legacy openchamber registration record. */
const registrationPath = (dataDir) => path.join(dataDir, 'desktop', 'chamber-command.json');

/** Use the legacy record only to identify chamber links created by early test builds. */
const legacyRegistrationPath = (dataDir) => path.join(dataDir, 'desktop', 'command.json');

/** Validate the current record strictly; include a legacy record only when it belongs to chamber. */
const readRegistration = async (dataDir) => {
  const filePath = registrationPath(dataDir);
  if (await statIfPresent(filePath)) {
    return { ...registrationSchema.parse(JSON.parse(await fsp.readFile(filePath, 'utf8'))), recordPath: filePath };
  }
  const oldPath = legacyRegistrationPath(dataDir);
  if (!await statIfPresent(oldPath)) return null;
  let oldRecord;
  try { oldRecord = JSON.parse(await fsp.readFile(oldPath, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = registrationSchema.safeParse(oldRecord);
  return parsed.success ? { ...parsed.data, recordPath: oldPath } : null;
};

/** Recognize only chamber links, including the private launcher used by early test builds. */
const isManagedCommandLink = async (candidate, dataDir) => {
  const info = await statIfPresent(candidate);
  if (path.basename(candidate) !== COMMAND_NAME || !info?.isSymbolicLink()) return false;
  const target = path.resolve(path.dirname(candidate), await fsp.readlink(candidate));
  return target === desktopLauncherPath(dataDir)
    || target === path.join(dataDir, 'desktop', 'openchamber');
};

/** Inspect command status using only PATH, the user bin, and paths named in registration records. */
const inspectDesktopCommand = async ({ platform, env, homeDir, dataDir }) => {
  if (platform !== 'darwin' && platform !== 'linux') return { state: 'unsupported', links: [] };
  const registration = await readRegistration(dataDir);
  const pathDirectories = [...new Set((env.PATH || '').split(path.delimiter).filter((directory) => path.isAbsolute(directory)))];
  const candidates = [...new Set([
    ...pathDirectories.map((directory) => path.join(directory, COMMAND_NAME)),
    path.join(homeDir, '.local', 'bin', COMMAND_NAME),
    ...(registration ? [registration.linkPath] : []),
  ])];
  const links = [];
  let externalPath = null;
  for (const candidate of candidates) {
    const info = await statIfPresent(candidate);
    if (!info) continue;
    if (await isManagedCommandLink(candidate, dataDir)) links.push(candidate);
    else externalPath ||= candidate;
  }
  if (links.length > 0) {
    const linkPath = links[0];
    // Older builds could mistake the app's internal PATH for the terminal PATH, so ignore their configured marker.
    const configured = pathDirectories.includes(path.dirname(linkPath))
      || (registration?.version === 2 && registration.linkPath === linkPath
        && path.dirname(linkPath) === path.join(homeDir, '.local', 'bin') && registration.pathConfigured);
    return { state: 'installed', path: linkPath, requiresPath: !configured, links, recordPath: registration?.recordPath };
  }
  if (externalPath || await shellHasCommand(env)) return { state: 'external', path: externalPath, links, recordPath: registration?.recordPath };
  return { state: 'missing', links, recordPath: registration?.recordPath };
};

/** Serialize registration and removal across windows; a failure does not block the next user action. */
const mutateDesktopCommand = (operation) => {
  const result = commandMutation.catch(() => {}).then(operation);
  commandMutation = result;
  return result;
};

/** Read status after pending operations and report disk errors instead of treating them as unregistered. */
export const getDesktopCommandStatus = async (options) => {
  await commandMutation.catch(() => {});
  const { links, recordPath, ...status } = await inspectDesktopCommand(options);
  return status;
};

/** Create the public link only after a click, preserving existing commands, aliases, and concurrently created files. */
export const registerDesktopCommand = (options) => mutateDesktopCommand(async () => {
  const { links, recordPath, ...current } = await inspectDesktopCommand(options);
  if (current.state !== 'missing') return current;
  const { env, homeDir, dataDir } = options;
  const launcherPath = desktopLauncherPath(dataDir);
  await prepareDesktopLauncher(options);
  const pathDirectories = [...new Set((env.PATH || '').split(path.delimiter).filter((directory) => path.isAbsolute(directory)))];

  // Register in the user command directory, outside PATH entries the app temporarily adds for itself or child processes.
  const destination = path.join(homeDir, '.local', 'bin', COMMAND_NAME);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try { await fsp.symlink(launcherPath, destination); }
  catch (error) {
    if (error.code === 'EEXIST') return { state: 'external', path: destination };
    throw error;
  }
  const onPath = pathDirectories.includes(path.dirname(destination));
  let configured;
  const record = registrationPath(dataDir);
  const temporary = `${record}.${randomUUID()}.tmp`;
  try {
    configured = !onPath && await addUserBinToShellPath({ env, homeDir });
    await fsp.writeFile(temporary, JSON.stringify({ version: 2, linkPath: destination, pathConfigured: configured }), { mode: 0o600, flag: 'wx' });
    await fsp.rename(temporary, record);
  } catch (error) {
    if (await isManagedCommandLink(destination, dataDir)) await fsp.unlink(destination);
    throw error;
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  return { state: 'installed', path: destination, requiresPath: !onPath && !configured };
});

/** Remove only the app-owned public link after a click, preserving user commands and shared PATH configuration. */
export const unregisterDesktopCommand = (options) => mutateDesktopCommand(async () => {
  const { links, recordPath, ...current } = await inspectDesktopCommand(options);
  if (links.length === 0) return current;
  for (const candidate of links) {
    if (await isManagedCommandLink(candidate, options.dataDir)) await fsp.unlink(candidate);
  }
  if (recordPath) await fsp.rm(recordPath, { force: true });
  const { links: remaining, recordPath: remainingRecordPath, ...status } = await inspectDesktopCommand(options);
  return status;
});
