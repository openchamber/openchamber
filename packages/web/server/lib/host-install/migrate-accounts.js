import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pickAgentSettings } from '../agent-server/settings-mirror.js';
import { isString } from '../shared/guards.js';
import { fail, FRONT_HOME } from './accounts.js';

const AGENT = new Set(('agent-tool chats dispatch-results.json extensions extensions.json extensions-deploy.json github-auth.json goals guest-services guest-storage managed-opencode mcp-project-local memory.json message-queue.json opencode-trust.json opencode.managed.json pr-fix-loops.json pr-watch.json projects project-icons session-drafts session-drafts.json session-warming.json sessions-archive.json sessions-directories.json sessions-unread.json skills-catalog-cache.json skills-github-meta.json source-control-audit.json source-control-bindings.json tracked-items.json walkthroughs classification.json').split(' '));
const FRONT = new Set(('settings.json ui-passkeys.json jwt-secret client-pairing-sessions.json remote-clients.json relay-identity.json apns-tokens.json notification-center.json notification-center-version.json spaces mcp-protected preferences.json voice-keys.json speech-models').split(' '));
const SKIP = new Set(['cache', 'tmp', 'run', 'logs', 'bin', 'update-install.log']);
export const classify = (name) => {
  if (SKIP.has(name) || name.endsWith('.lock')) return 'skipped';
  if (AGENT.has(name) || /^git-.*\.json$/.test(name)) return 'agent';
  if (FRONT.has(name) || name.startsWith('install-id-')) return 'front-door';
  return 'unclassified';
};
export const readOptional = async (file) => {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const entries = async (directory) => {
  try { return await fs.readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

/** Existing destination ancestors must be real directories, never aliases into human data. */
export async function requirePhysicalDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('migration_destination_outside_root', 'The migration destination must stay inside its installation root');
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stats = await fs.lstat(current).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stats && !stats.isDirectory()) fail('migration_destination_link', `Migration destination ancestor is not a physical directory: ${current}`);
  }
}

/** Parse the one systemd environment value needed for migration; never execute the old env. */
export function oldDataDirectory(text, human) {
  const line = (text ?? '').split('\n').find((entry) => /^\s*OPENCHAMBER_DATA_DIR=/.test(entry));
  const value = line?.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  return value && path.isAbsolute(value) ? value : path.join(human.home, '.config/openchamber');
}

export async function ownTree(system, directory, account) {
  const stats = await fs.lstat(directory);
  // A restored link must never redirect root's ownership walk to a human's files, and a hard link
  // the account made to a file it can only write must not make that file its own.
  if (stats.isSymbolicLink() || (!stats.isDirectory() && stats.nlink > 1)) return;
  await system.chown(directory, account.uid, account.gid);
  if (stats.isDirectory()) for (const name of await fs.readdir(directory)) await ownTree(system, path.join(directory, name), account);
}

/**
 * A source file as root opens it: without following a last link, and only when `owner` owns it.
 * Before the split the agents ran as the human and could plant links in this data, so root copies
 * only what the human could read anyway. Resolves the open handle, or null for anything else.
 */
async function openOwned(file, owner) {
  let handle;
  try { handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (['ELOOP', 'ENOENT', 'ENXIO'].includes(error.code)) return null; throw error; }
  const stats = await handle.stat();
  if (stats.isFile() && stats.uid === owner.uid) return handle;
  await handle.close();
  return null;
}

/** The text of a source file the human owns, through its links; null when missing or not the human's. */
async function readOwned(file, owner) {
  const real = await fs.realpath(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  const handle = real && await openOwned(real, owner);
  if (!handle) return null;
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
}

/**
 * Copy each entry exclusively. Links become private regular files/directories, never live aliases.
 * An entry the human does not own is recorded as `foreign-skipped` and never read.
 */
async function copyEntry({ source, target, account, owner, system, manifest, kind, dryRun, filter, ancestors = [], root }) {
  await requirePhysicalDirectory(root, path.dirname(target));
  const record = { source, target, class: kind, status: 'planned' };
  manifest.files.push(record);
  const existing = await fs.lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  const real = await fs.realpath(source);
  if (ancestors.includes(real)) { record.status = 'cycle-skipped'; return; }
  const stats = await fs.stat(real);
  if (existing && !(existing.isDirectory() && stats.isDirectory())) { record.status = 'existing'; return; }
  if (!stats.isDirectory() && !stats.isFile()) { record.status = 'special-skipped'; return; }
  if (stats.uid !== owner.uid) { record.status = 'foreign-skipped'; return; }
  if (existing) record.status = 'existing';
  else if (!dryRun) {
    if (stats.isDirectory()) await fs.mkdir(target, { mode: 0o700 });
    else {
      // The checks above looked at a path; this one is on the file actually read.
      const handle = await openOwned(real, owner);
      if (!handle) { record.status = 'foreign-skipped'; return; }
      await pipeline(handle.createReadStream(), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    }
    await system.chown(target, account.uid, account.gid);
    await fs.chmod(target, stats.isDirectory() ? 0o700 : (stats.mode & 0o100 ? 0o700 : 0o600));
    record.status = 'copied';
  }
  if (stats.isDirectory()) for (const name of await fs.readdir(real)) {
    if (filter && !filter(name)) { manifest.files.push({ source: path.join(source, name), target: null, class: 'skipped', status: 'skipped' }); continue; }
    await copyEntry({ source: path.join(real, name), target: path.join(target, name), account, owner, system, manifest, kind, dryRun, filter, ancestors: [...ancestors, real], root });
  }
}

const FIX_LOOPS = 'pr-fix-loops.json';

/**
 * Approval loops and prepared workers drive Spaces, which only the front door runs after the split,
 * so they go to the front door's copy with `spaces`. Automatic loops stay in the agent's. A file that
 * does not parse is copied whole to the agent, as before.
 */
async function splitFixLoops({ file, frontData, agentData, front, agent, owner, system, manifest, dryRun, root }) {
  const stored = await readOwned(file, owner).then(JSON.parse).catch(() => null);
  if (!Array.isArray(stored?.loops)) {
    await copyEntry({ source: file, target: path.join(agentData, FIX_LOOPS), account: agent, owner, system, manifest, kind: 'agent', dryRun, root });
    return;
  }
  const approval = (loop) => Boolean(loop?.worker || loop?.pendingApproval || loop?.config?.pushMode === 'approval');
  for (const [kind, directory, account, value] of [
    ['front-door', frontData, front, { ...stored, loops: stored.loops.filter(approval) }],
    ['agent', agentData, agent, { ...stored, loops: stored.loops.filter((loop) => !approval(loop)), workers: [] }],
  ]) {
    const target = path.join(directory, FIX_LOOPS);
    await requirePhysicalDirectory(root, directory);
    const record = { source: file, target, class: kind, status: 'planned' };
    manifest.files.push(record);
    if (dryRun) continue;
    try {
      await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await system.chown(target, account.uid, account.gid);
      record.status = 'copied';
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      record.status = 'existing';
    }
  }
}

export async function shareSettingsProjects({ settings, sharing, say = () => {} }) {
  const results = [];
  for (const project of Array.isArray(settings?.projects) ? settings.projects : []) {
    const directory = isString(project) ? project : project?.path;
    if (!isString(directory)) continue;
    try { results.push(await sharing.share(directory)); }
    catch (error) { results.push({ path: directory, status: 'refused', code: error.code, message: error.message }); say(`Project ${directory} was not shared: ${error.message}`); }
  }
  return results;
}

/** Sources survive every failure. An existing destination is always left intact. */
export async function migrateAccounts({ root = '/', system, accounts, envFile, dryRun = false, sharing, say = () => {} }) {
  const at = (file) => path.join(root, file);
  const { human, front, agent } = accounts;
  const source = at(oldDataDirectory(await readOptional(envFile), human));
  const frontData = at(`${FRONT_HOME}/.config/openchamber`);
  const agentData = at(`${agent.home}/.config/openchamber`);
  const manifestFile = at(`${FRONT_HOME}/migration.json`);
  const previous = await readOptional(manifestFile);
  const manifest = previous ? JSON.parse(previous) : { version: 1, files: [], worktrees: [], projects: [] };
  const originalCount = manifest.files.length;
  for (const directory of [frontData, agentData, at(`${agent.home}/.local/share/opencode`), at(`${agent.home}/.config/opencode`)]) await requirePhysicalDirectory(root, directory);
  if (!dryRun) {
    for (const [directory, account] of [[at(`${FRONT_HOME}/.config`), front], [frontData, front], [at(`${agent.home}/.config`), agent], [agentData, agent], [at(`${agent.home}/.local`), agent], [at(`${agent.home}/.local/share`), agent]]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await ownTree(system, directory, account);
    }
  }
  try {
    for (const name of await entries(source)) {
      const kind = classify(name);
      if (kind === 'skipped') { manifest.files.push({ source: path.join(source, name), target: null, class: kind, status: 'skipped' }); continue; }
      if (name === FIX_LOOPS) {
        await splitFixLoops({ file: path.join(source, name), frontData, agentData, front, agent, owner: human, system, manifest, dryRun, root });
        continue;
      }
      const account = kind === 'agent' ? agent : front;
      const target = path.join(kind === 'agent' ? agentData : frontData, name);
      await copyEntry({ source: path.join(source, name), target, account, owner: human, system, manifest, kind, dryRun, root });
      if (kind === 'unclassified') say(`Unclassified data retained by the front door: ${name}`);
    }
    const settingsText = await readOptional(path.join(frontData, 'settings.json')) ?? await readOwned(path.join(source, 'settings.json'), human);
    const settings = settingsText ? JSON.parse(settingsText) : {};
    const mirror = path.join(agentData, 'settings.json');
    manifest.files.push({ source: path.join(source, 'settings.json'), target: mirror, class: 'agent-settings', status: dryRun ? 'planned' : 'existing' });
    if (!dryRun) {
      try {
        await fs.writeFile(mirror, `${JSON.stringify(pickAgentSettings(settings), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await system.chown(mirror, agent.uid, agent.gid);
        manifest.files.at(-1).status = 'copied';
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    for (const [suffix, filter] of [['.local/share/opencode', (name) => !['worktree', 'log', 'bin'].includes(name)], ['.config/opencode', null]]) {
      const from = at(path.join(human.home, suffix));
      if (await fs.lstat(from).catch(() => null)) await copyEntry({ source: from, target: at(path.join(agent.home, suffix)), account: agent, owner: human, system, manifest, kind: 'opencode', dryRun, filter, root });
    }
    manifest.worktrees = (await entries(at(`${human.home}/.local/share/opencode/worktree`))).map((name) => `${human.home}/.local/share/opencode/worktree/${name}`);
    if (!dryRun && sharing) manifest.projects = await shareSettingsProjects({ settings, sharing, say });
    for (const directory of manifest.worktrees) say(`Existing OpenCode worktree left in place: ${directory}`);
    if (dryRun) say(JSON.stringify({ ...manifest, files: manifest.files.slice(originalCount) }, null, 2));
    return manifest;
  } finally {
    if (!dryRun) {
      // Root owns the journal even though the front door owns its parent.
      await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await fs.chmod(manifestFile, 0o600);
      await system.chown(manifestFile, 0, 0);
    }
  }
}
