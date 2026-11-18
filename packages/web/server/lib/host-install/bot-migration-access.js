import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './accounts.js';
import { isPrimitiveString } from '../shared/guards.js';

const localFilesystems = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'tmpfs', 'overlay', 'bcachefs']);
const inside = (child, parent) => child === parent || child.startsWith(`${parent.replace(/\/$/, '')}/`);
const identity = (stat) => `${stat.dev}:${stat.ino}`;
const bits = (value) => (value[0] === 'r' ? 4 : 0) | (value[1] === 'w' ? 2 : 0) | (value[2] === 'x' ? 1 : 0);
const permissions = (value) => `${value & 4 ? 'r' : '-'}${value & 2 ? 'w' : '-'}${value & 1 ? 'x' : '-'}`;
const refuse = () => fail('migration_bots_access_refused', 'The exact retained Bot filesystem access could not be granted safely');

/** Only an offline, root-reviewed file can introduce retained checkout authority. */
export async function readTrustedBotWorktrees({ root = '/', file, readIdentity = (handle) => handle.stat({ bigint: true }) }) {
  if (file === undefined) return [];
  const invalid = () => fail('migration_bots_path_authority_required', 'Give --bot-worktrees-file with a root-owned, read-only regular JSON file on a root-owned physical path');
  if (!isPrimitiveString(file) || !path.isAbsolute(file) || path.normalize(file) !== file || file.endsWith('/')) invalid();
  const physicalRoot = path.resolve(root);
  let handle;
  try {
    handle = await fs.open(physicalRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const components = path.relative('/', file).split(path.sep);
    for (let index = 0; index <= components.length; index += 1) {
      const stat = await readIdentity(handle);
      const last = index === components.length;
      if (Number(stat.uid) !== 0 || Number(stat.mode) & (last ? 0o222 : 0o022)
        || (last ? !stat.isFile() || Number(stat.nlink) !== 1 : !stat.isDirectory())) invalid();
      if (last) break;
      const next = await fs.open(`/proc/self/fd/${handle.fd}/${components[index]}`,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      await handle.close(); handle = next;
    }
    const before = await readIdentity(handle);
    const raw = await handle.readFile('utf8');
    const after = await readIdentity(handle);
    if (['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].some((key) => before[key] !== after[key])) invalid();
    const value = JSON.parse(raw);
    if (!value || Object.keys(value).sort().join(',') !== 'entries,version' || value.version !== 1 || !Array.isArray(value.entries)) invalid();
    const keys = ['directory', 'directoryIdentity', 'gitDirectory', 'gitIdentity', 'itemId', 'projectId'];
    const owners = new Set();
    const locations = new Set();
    for (const entry of value.entries) {
      if (!entry || Object.keys(entry).sort().join(',') !== keys.join(',')
        || keys.some((key) => !isPrimitiveString(entry[key]) || !entry[key] || /[\x00-\x1f\x7f]/.test(entry[key]))
        || !['directoryIdentity', 'gitIdentity'].every((key) => /^[0-9]+:[0-9]+$/.test(entry[key]))
        || !['directory', 'gitDirectory'].every((key) => path.isAbsolute(entry[key]) && path.normalize(entry[key]) === entry[key] && !entry[key].endsWith('/'))) invalid();
      const owner = `${entry.projectId}\0${entry.itemId}`;
      if (owners.has(owner)) invalid();
      owners.add(owner);
      for (const location of [entry.directory, entry.gitDirectory]) {
        if (locations.has(location)) invalid();
        locations.add(location);
      }
    }
    return value.entries;
  } catch (error) {
    if (error.code === 'migration_bots_path_authority_required') throw error;
    invalid();
  } finally { await handle?.close(); }
}

function parseAcl(text) {
  const entries = text.trim().split('\n').filter(Boolean).map((line) => {
    const match = /^(default:)?(user|group|mask|other):([0-9]*):([r-][w-][x-])$/.exec(line);
    if (!match || ['mask', 'other'].includes(match[2]) && match[3]) refuse();
    return { scope: match[1] ? 'default' : 'access', type: match[2], id: match[3], value: bits(match[4]) };
  });
  if (new Set(entries.map((entry) => `${entry.scope}:${entry.type}:${entry.id}`)).size !== entries.length) refuse();
  for (const scope of ['access', 'default']) {
    const selected = entries.filter((entry) => entry.scope === scope);
    if (scope === 'default' && selected.length === 0) continue;
    if (!['user', 'group', 'other'].every((type) => selected.some((entry) => entry.type === type && !entry.id))) refuse();
    if (selected.some((entry) => entry.id) && !selected.some((entry) => entry.type === 'mask')) refuse();
  }
  return entries;
}

const entryOf = (entries, type, id = '') => entries.find((entry) => entry.type === type && entry.id === id);
function effectiveAccess(entries, stat, agent) {
  if (Number(stat.uid) === agent.uid) return entryOf(entries, 'user').value;
  const mask = entryOf(entries, 'mask')?.value ?? 7;
  const named = entryOf(entries, 'user', String(agent.uid));
  if (named) return named.value & mask;
  const groups = new Set([agent.gid, ...agent.gids ?? []].map(String));
  const applicable = entries.filter((entry) => entry.type === 'group' && groups.has(entry.id || String(stat.gid)));
  return applicable.length ? applicable.reduce((value, entry) => value | entry.value, 0) & mask : entryOf(entries, 'other').value;
}

/** Widen only the requested principal's effective rights, including ACLs with a restrictive mask. */
function grantScope(entries, scope, grants) {
  const selected = entries.filter((entry) => entry.scope === scope);
  const previousMask = entryOf(selected, 'mask')?.value ?? 7;
  for (const entry of selected) if (entry.type === 'group' || entry.type === 'user' && entry.id) entry.value &= previousMask;
  for (const [uid, desired] of grants) {
    const previous = entryOf(selected, 'user', String(uid));
    if (previous) previous.value |= desired;
    else { const entry = { scope, type: 'user', id: String(uid), value: desired }; selected.push(entry); entries.push(entry); }
  }
  let mask = entryOf(selected, 'mask');
  const wanted = selected.filter((entry) => entry.type === 'group' || entry.type === 'user' && entry.id).reduce((value, entry) => value | entry.value, 0);
  if (mask) mask.value = wanted;
  else { mask = { scope, type: 'mask', id: '', value: wanted }; entries.push(mask); }
}

function aclFor(text, stat, { human, agent, ancestor }) {
  const originalEntries = parseAcl(text);
  const entries = structuredClone(originalEntries);
  const access = entries.filter((entry) => entry.scope === 'access');
  const original = effectiveAccess(access, stat, agent);
  const needed = ancestor ? 1 : (stat.isDirectory() || Number(stat.mode) & 0o111 ? 7 : 6);
  if (ancestor && (original & 1)) return null;
  if (Number(stat.uid) === agent.uid) entryOf(access, 'user').value |= needed;
  else grantScope(entries, 'access', [[agent.uid, original | needed]]);
  if (!ancestor && stat.isDirectory()) {
    if (!entries.some((entry) => entry.scope === 'default')) {
      for (const type of ['user', 'group', 'other']) {
        const originalAccess = originalEntries.filter((entry) => entry.scope === 'access');
        const originalEntry = entryOf(originalAccess, type);
        const value = type === 'group' ? originalEntry.value & (entryOf(originalAccess, 'mask')?.value ?? 7) : originalEntry.value;
        entries.push({ scope: 'default', type, id: '', value });
      }
    }
    // The creator is the inode owner, so its named user entry cannot supply these rights.
    entryOf(entries.filter((entry) => entry.scope === 'default'), 'user').value = 7;
    grantScope(entries, 'default', [[agent.uid, 7], [human.uid, 7]]);
  }
  if (!stat.isDirectory() && entries.some((entry) => entry.scope === 'default')) refuse();
  return entries.map((entry) => `${entry.scope === 'default' ? 'd:' : ''}${entry.type}:${entry.id}:${permissions(entry.value)}`).join(',');
}

/** Open each component without following links. The ACL tools address only this root-held descriptor. */
async function openPhysical(root, target) {
  if (!inside(target, root) || path.normalize(target) !== target) refuse();
  let handle = await fs.open(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
      const next = await fs.open(`/proc/self/fd/${handle.fd}/${component}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      await handle.close(); handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

function requireLocalTrees(trees, text) {
  const decode = (value) => value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
  const mounts = text.split('\n').filter(Boolean).map((line) => {
    const [before, after] = line.split(' - ');
    return { directory: decode(before.split(' ')[4] ?? ''), type: after?.split(' ')[0] };
  });
  for (const tree of trees) {
    const containing = mounts.filter((mount) => inside(tree, mount.directory)).sort((a, b) => b.directory.length - a.directory.length)[0];
    if (!containing || !localFilesystems.has(containing.type)
      || mounts.some((mount) => mount.directory !== tree && inside(mount.directory, tree))) refuse();
  }
}

/** Offline root migration only. Entries have already matched explicit trusted descriptor mappings. */
export async function grantRetainedBotAccess({ root = '/', botRoot, entries, human, agent, run, dryRun = false,
  readMountInfo = () => fs.readFile('/proc/self/mountinfo', 'utf8') }) {
  const pendingAgent = dryRun && agent.uid === undefined && agent.gid === undefined;
  if (!Number.isSafeInteger(human.uid) || human.uid < 0 || !pendingAgent
    && (![agent.uid, agent.gid].every((id) => Number.isSafeInteger(id) && id >= 0) || agent.uid === 0 || human.uid === agent.uid)) refuse();
  const physicalRoot = path.resolve(root);
  const trees = new Map();
  for (const entry of entries) {
    if (path.dirname(entry.directory) !== botRoot) refuse();
    for (const [directory, expected] of [[entry.directory, entry.directoryIdentity], [entry.gitDirectory, entry.gitIdentity]]) {
      if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.endsWith('/')
        || inside(human.home, directory) || inside(botRoot, directory)) refuse();
      const physical = path.join(physicalRoot, directory);
      if (trees.has(physical) && trees.get(physical) !== expected) refuse();
      trees.set(physical, expected);
    }
  }
  if (!trees.size) return { status: dryRun ? 'planned' : 'granted', trees: [], changed: [] };
  requireLocalTrees([...trees.keys()], await readMountInfo());
  const plan = new Map();
  const inspect = async (target, expected, ancestor) => {
    const handle = await openPhysical(physicalRoot, target);
    try {
      const stat = await handle.stat({ bigint: true });
      if (expected && identity(stat) !== expected || !stat.isDirectory() && !stat.isFile()
        || !ancestor && ![human.uid, agent.uid].includes(Number(stat.uid))
        || stat.isFile() && (stat.nlink > 1n || Number(stat.mode) & 0o6000)) refuse();
      const result = await run('/usr/bin/getfacl', ['-cEn', '--', `/proc/${process.pid}/fd/${handle.fd}`]);
      if (result.code !== 0) refuse();
      // A dry run may precede account creation. Validate ACLs without inventing a future UID.
      if (pendingAgent) parseAcl(result.stdout);
      const acl = pendingAgent ? null : aclFor(result.stdout, stat, { human, agent, ancestor });
      const previous = plan.get(target);
      if (!previous || !ancestor) plan.set(target, { target, identity: identity(stat), acl, previousAcl: result.stdout.trim(), ancestor });
      if (!ancestor && stat.isDirectory()) {
        for (const name of await fs.readdir(`/proc/self/fd/${handle.fd}`)) {
          const child = await fs.lstat(`/proc/self/fd/${handle.fd}/${name}`, { bigint: true });
          if (child.isSymbolicLink()) continue;
          if (child.dev !== stat.dev) refuse();
          await inspect(path.join(target, name), identity(child), false);
        }
      }
    } finally { await handle.close(); }
  };
  for (const [tree, expected] of trees) {
    await inspect(tree, expected, false);
    for (let ancestor = path.dirname(tree); inside(ancestor, physicalRoot); ancestor = path.dirname(ancestor)) {
      await inspect(ancestor, null, true);
      if (ancestor === physicalRoot) break;
    }
  }
  const changed = [];
  try {
    if (!dryRun) for (const entry of plan.values()) {
      if (!entry.acl) continue;
      const handle = await openPhysical(physicalRoot, entry.target);
      try {
        const stat = await handle.stat({ bigint: true });
        if (identity(stat) !== entry.identity || !entry.ancestor && ![human.uid, agent.uid].includes(Number(stat.uid))
          || stat.isFile() && (stat.nlink > 1n || Number(stat.mode) & 0o6000)) refuse();
        const current = await run('/usr/bin/getfacl', ['-cEn', '--', `/proc/${process.pid}/fd/${handle.fd}`]);
        if (current.code !== 0 || current.stdout.trim() !== entry.previousAcl) refuse();
        const result = await run('/usr/bin/setfacl', ['-n', `--set=${entry.acl}`, '--', `/proc/${process.pid}/fd/${handle.fd}`]);
        if (result.code !== 0) {
          const error = Object.assign(new Error('A retained Bot access grant failed; retain the migration journal and retry offline'),
            { code: 'migration_bots_access_refused', botAccess: { status: 'partial', trees: [...trees.keys()], changed, failed: entry.target } });
          throw error;
        }
        changed.push({ path: entry.target, access: entry.ancestor ? 'traverse' : 'tree' });
      } finally { await handle.close(); }
    }
  } catch (error) {
    error.botAccess ??= { status: changed.length ? 'partial' : 'refused', trees: [...trees.keys()], changed };
    throw error;
  }
  return { status: dryRun ? 'planned' : 'granted', trees: [...trees.keys()], changed };
}
