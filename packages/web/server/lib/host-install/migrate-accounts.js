import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pickAgentSettings } from '../agent-server/settings-mirror.js';
import { isPrimitiveString, isRecord, isString } from '../shared/guards.js';
import { fail, FRONT_HOME } from './accounts.js';
import { isDeepStrictEqual } from 'node:util';
import { checkoutOwnerKeys, isBotScheduledRow, readBotItem, readBotWatchAuthority, readCheckout,
  readPlacement, readPublicationRegistry, readQueuedItem, readQueueSnapshot, readRuns, validateOwnerBotsProject } from './migration-records.js';
import { grantRetainedBotAccess } from './bot-migration-access.js';
import { projectConfigFileStemOf } from '../projects/project-id.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';

const AGENT = new Set(('agent-tool chats dispatch-results.json extensions extensions.json extensions-deploy.json github-auth.json goals guest-services guest-storage managed-opencode mcp-project-local memory.json message-queue.json opencode-trust.json opencode.managed.json pr-fix-loops.json pr-watch.json projects project-icons session-drafts session-drafts.json session-warming.json sessions-archive.json sessions-directories.json sessions-unread.json skills-catalog-cache.json skills-github-meta.json source-control-audit.json source-control-mutations.json source-control-bindings.json tracked-items.json walkthroughs classification.json bot-identities.json bot-worktrees').split(' '));
const FRONT = new Set(('settings.json ui-passkeys.json jwt-secret client-pairing-sessions.json remote-clients.json relay-identity.json apns-tokens.json notification-center.json notification-center-version.json spaces mcp-protected preferences.json voice-keys.json speech-models bots bot-provider-events.json').split(' '));
const SKIP = new Set(['cache', 'tmp', 'run', 'logs', 'bin', 'update-install.log']);
const AGENT_BOT_RECORDS = new Set(['bot-identities.json', 'source-control-mutations.json', 'source-control-audit.json']);
const parseMigrationRecord = (text) => {
  try { return JSON.parse(text); }
  catch { fail('migration_bots_malformed', 'Invalid migration JSON record'); }
};
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

async function readOptionalAuthority(file, owner) {
  const exists = await fs.lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!exists) return null;
  const content = await readOwned(file, owner);
  if (content === null) fail('migration_bots_malformed', 'Unreadable Bots migration authority');
  return content;
}

/**
 * Copy each entry exclusively. Links become private regular files/directories, never live aliases.
 * An entry the human does not own is recorded as `foreign-skipped` and never read.
 */
async function copyEntry({ source, target, account, owner, system, manifest, kind, dryRun, filter, ancestors = [], root, strict = false }) {
  await requirePhysicalDirectory(root, path.dirname(target));
  const record = { source, target, class: kind, status: 'planned' };
  manifest.files.push(record);
  const existing = await fs.lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  const real = await fs.realpath(source);
  if (ancestors.includes(real)) { if (strict) fail('migration_bots_malformed', 'Cyclic Bots migration source'); record.status = 'cycle-skipped'; return; }
  const stats = await fs.stat(real);
  if (!stats.isDirectory() && !stats.isFile()) { if (strict) fail('migration_bots_malformed', 'Unsupported Bots migration source'); record.status = 'special-skipped'; return; }
  if (stats.uid !== owner.uid) { if (strict) fail('migration_bots_malformed', 'Unreadable Bots migration source'); record.status = 'foreign-skipped'; return; }
  if (strict && stats.isFile()) {
    const content = await readOwned(source, owner);
    if (/\.json$/.test(source)) {
      const parsed = parseMigrationRecord(content);
      if (!(isRecord(parsed) || Array.isArray(parsed) && AGENT_BOT_RECORDS.has(path.basename(source)))) fail('migration_bots_malformed', 'Invalid Bots migration record');
      if (path.basename(source) === 'bots.json') {
        if (parsed.version !== 1 || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || !Array.isArray(parsed.items)
          || new Set(parsed.items.map((item) => item?.id)).size !== parsed.items.length) fail('migration_bots_malformed', 'Invalid Bots snapshot');
        for (const item of parsed.items) readBotItem(item);
      }
      if (path.basename(path.dirname(source)) === 'bot-executions'
        && (parsed.version !== 1 || !isRecord(parsed.operations)
          || !isRecord(parsed.data))) fail('migration_bots_malformed', 'Invalid Bot execution journal');
    }
    if (/\.jsonl$/.test(source)) for (const line of content.split('\n').filter(Boolean)) readBotItem(parseMigrationRecord(line).item);
    if (existing && (!existing.isFile() || await fs.readFile(target, 'utf8') !== content)) fail('migration_bots_conflict', `Conflicting Bots migration destination: ${target}`);
  }
  if (existing && !(existing.isDirectory() && stats.isDirectory())) { record.status = 'existing'; return; }
  if (existing) record.status = 'existing';
  else if (!dryRun) {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await system.chown(path.dirname(target), account.uid, account.gid);
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
    if (name.endsWith('.lock') || name.endsWith('.lock.guard')) continue;
    if (filter && !filter(name)) { manifest.files.push({ source: path.join(source, name), target: null, class: 'skipped', status: 'skipped' }); continue; }
    await copyEntry({ source: path.join(real, name), target: path.join(target, name), account, owner, system, manifest, kind, dryRun, filter, ancestors: [...ancestors, real], root, strict });
  }
}

const FIX_LOOPS = 'pr-fix-loops.json';

async function writeSplitJson({ source, target, value, account, system, manifest, kind, dryRun, root }) {
  await requirePhysicalDirectory(root, path.dirname(target));
  const record = { source, target, class: kind, status: 'planned' };
  manifest.files.push(record);
  const existing = await fs.lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    if (!existing.isFile() || !isDeepStrictEqual(parseMigrationRecord(await fs.readFile(target, 'utf8')), value)) {
      record.status = 'conflict';
      fail('migration_bots_conflict', `Conflicting Bots migration destination: ${target}`);
    }
    record.status = 'existing';
    return;
  }
  if (dryRun) return;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await system.chown(path.dirname(target), account.uid, account.gid);
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await system.chown(target, account.uid, account.gid);
  record.status = 'copied';
}

/**
 * Approval loops and prepared workers drive Spaces, which only the front door runs after the split,
 * so they go to the front door's copy with `spaces`. Bot watches also belong to the front door.
 * Malformed state refuses migration before either runtime can start.
 */
async function splitFixLoops({ file, frontData, agentData, front, agent, owner, system, manifest, dryRun, root }) {
  const stored = parseMigrationRecord(await readOwned(file, owner));
  if (![1, 2].includes(stored?.version) || !Array.isArray(stored?.loops)
    || stored.workers !== undefined && !Array.isArray(stored.workers)
    || new Set(stored.loops.map((loop) => loop?.id)).size !== stored.loops.length
    || stored.loops.some((loop) => !loop?.id || !loop.sessionId || !(isRecord(loop.internal) || Array.isArray(loop.internal)))) fail('migration_bots_malformed', 'Invalid fix-loop migration state');
  const approval = (loop) => Boolean(loop.botAuthority || loop.worker || loop.pendingApproval || loop.config?.pushMode === 'approval');
  for (const loop of stored.loops) if (loop.botAuthority) {
    const authority = readBotWatchAuthority(loop.botAuthority);
    if (loop.config?.pushMode !== 'auto' || !Number.isInteger(loop.number) || loop.number < 1
      || loop.owner !== authority.target.owner || loop.repo !== authority.target.repo
      || loop.branch !== (authority.publicationBranch ?? `bot/${authority.itemId}`)) fail('migration_bots_malformed', 'Invalid Bot PR watch migration authority');
  }
  const terminal = new Set(['ready', 'stopped', 'closed', 'limitReached', 'budgetReached', 'error']);
  const held = (loop) => !terminal.has(loop.status) || Boolean(loop.pendingApproval || loop.internal.reviewJob);
  for (const bot of stored.loops.filter((loop) => loop.botAuthority && held(loop))) {
    if (stored.loops.some((loop) => loop !== bot && held(loop) && loop.owner?.toLowerCase() === bot.owner.toLowerCase()
      && loop.repo?.toLowerCase() === bot.repo.toLowerCase() && loop.number === bot.number)) {
      fail('migration_bots_conflict', 'A Bot watch and another fix loop hold the same pull request');
    }
  }
  for (const [kind, directory, account, value] of [
    ['front-door', frontData, front, { ...stored, loops: stored.loops.filter(approval) }],
    ['agent', agentData, agent, { ...stored, loops: stored.loops.filter((loop) => !approval(loop)), workers: [] }],
  ]) {
    const target = path.join(directory, FIX_LOOPS);
    await writeSplitJson({ source: file, target, value, account, system, manifest, kind, dryRun, root });
  }
}

const PROJECT_BOTS = new Set(['bots.json', 'bots-archive', 'bot-executions']);

async function splitBotControl(options) {
  const { source, frontData, agentData, front, agent, owner, system, manifest, dryRun, root } = options;
  for (const name of await entries(path.join(source, 'bots'))) {
    if (name.endsWith('.lock') || name.endsWith('.lock.guard')) continue;
    // Proof scratch contains executable project copies. It has no owner control authority.
    const execution = name === 'proof';
    await copyEntry({ source: path.join(source, 'bots', name), target: path.join(execution ? agentData : frontData, 'bots', name),
      account: execution ? agent : front, owner, system, manifest, dryRun, root, kind: execution ? 'agent' : 'front-door', strict: !execution });
  }
}

async function splitProjects(options) {
  const { source, frontData, agentData, front, agent, owner, system, manifest, dryRun, root } = options;
  const directory = path.join(source, 'projects');
  for (const name of await entries(directory)) {
    if (name.endsWith('.lock')) continue;
    const file = path.join(directory, name);
    const stem = name.endsWith('.json') ? name.slice(0, -5) : name;
    const marker = path.join(frontData, 'projects', `${stem}.json.bots-migration-blocked`);
    try {
      const blocked = await fs.lstat(marker).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (blocked) fail('migration_bots_blocked', 'Repair and explicitly clear the project migration blocker before retrying');
      const stats = await fs.stat(file);
      if (stats.uid !== owner.uid) fail('migration_bots_malformed', 'Unreadable project migration source');
      if (stats.isDirectory()) {
        for (const child of await entries(file)) {
          if (child.endsWith('.lock') || child.endsWith('.lock.guard')) continue;
          const bot = PROJECT_BOTS.has(child);
          await copyEntry({ source: path.join(file, child), target: path.join(bot ? frontData : agentData, 'projects', name, child),
            account: bot ? front : agent, owner, system, manifest, kind: bot ? 'front-door' : 'agent', dryRun, root, strict: bot });
        }
        continue;
      }
      if (!name.endsWith('.json')) {
        await copyEntry({ ...options, source: file, target: path.join(agentData, 'projects', name), account: agent, kind: 'agent' });
        continue;
      }
      const text = await readOwned(file, owner);
      if (text === null) fail('migration_bots_malformed', 'Unreadable project migration source');
      const stored = validateOwnerBotsProject(parseMigrationRecord(text));
      const botRows = (stored.scheduledTasks ?? []).filter(isBotScheduledRow);
      const { bots, ...ordinary } = stored;
      ordinary.scheduledTasks = (stored.scheduledTasks ?? []).filter((row) => !isBotScheduledRow(row));
      const owned = { version: 1, scheduledTasks: botRows };
      if (bots !== undefined) owned.bots = bots;
      // Both destinations are checked before either is created.
      for (const [data, value] of [[frontData, owned], [agentData, ordinary]]) {
        const target = path.join(data, 'projects', name);
        await requirePhysicalDirectory(root, path.dirname(target));
        const targetStat = await fs.lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (targetStat && !targetStat.isFile()) fail('migration_bots_conflict', `Conflicting project migration destination: ${target}`);
        const previous = targetStat ? await readOptional(target) : null;
        if (previous !== null && !isDeepStrictEqual(parseMigrationRecord(previous), value)) fail('migration_bots_conflict', `Conflicting project migration destination: ${target}`);
      }
      for (const [data, account, kind, value] of [[frontData, front, 'front-door', owned], [agentData, agent, 'agent', ordinary]]) {
        await writeSplitJson({ source: file, target: path.join(data, 'projects', name), value, account, system, manifest, kind, dryRun, root });
      }
    } catch (error) {
      await blockProjectMigration({ ...options, file, stem, error });
    }
  }
}

async function blockProjectMigration({ file, stem, error, frontData, front, system, manifest, dryRun, root }) {
  const marker = path.join(frontData, 'projects', `${stem}.json.bots-migration-blocked`);
  const code = error.code ?? 'migration_bots_malformed';
  if (!manifest.blockedProjects.some((entry) => entry.stem === stem)) manifest.blockedProjects.push({ stem, code });
  manifest.files.push({ source: file, target: marker, class: 'front-door', status: 'blocked', code });
  if (dryRun) return;
  await requirePhysicalDirectory(root, path.dirname(marker));
  await fs.mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  await system.chown(path.dirname(marker), front.uid, front.gid);
  await fs.writeFile(marker, `${code}\n`, { flag: 'wx', mode: 0o600 })
    .catch((writeError) => { if (writeError.code !== 'EEXIST') throw writeError; });
  const stats = await fs.lstat(marker);
  if (!stats.isFile() || stats.nlink > 1) fail('migration_destination_link', 'The Bots migration blocker must be a private regular file');
  await system.chown(marker, front.uid, front.gid);
}

/** Item ownership and the captured execution decide host placement, never current Bot defaults. */
async function requireHostQueueOwner({ source, owner }, sessionId, directory, queued) {
  const { projectId, itemId } = queued.notice;
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/.test(projectId) || ['.', '..'].includes(projectId)) fail('migration_bots_malformed', 'Invalid queued Bot project identity');
  const stem = projectConfigFileStemOf(projectId);
  const projectDirectory = path.join(source, 'projects', stem);
  const snapshot = parseMigrationRecord(await readOwned(path.join(projectDirectory, 'bots.json'), owner));
  if (snapshot?.version !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.items)
    || new Set(snapshot.items.map((item) => item?.id)).size !== snapshot.items.length) fail('migration_bots_malformed', 'Invalid queued Bot item snapshot');
  const items = snapshot.items.map(readBotItem);
  const item = items.find((entry) => entry.id === itemId);
  const stage = item && Object.keys(item.sessions ?? {}).find((stage) => item.sessions[stage] === sessionId);
  if (!item || !stage || item.worktree !== directory || /^\/spaces(?:\/|$)/.test(directory)
    || items.filter((entry) => Object.values(entry.sessions ?? {}).includes(sessionId)).length !== 1) fail('migration_bots_conflict', 'Queued Bot session ownership does not match the retained item');
  const executionText = await readOptionalAuthority(path.join(projectDirectory, 'bot-executions', `${createHash('sha256').update(itemId).digest('hex')}.json`), owner);
  const execution = executionText === null ? null : parseMigrationRecord(executionText);
  if (executionText !== null && (!execution || execution.version !== 1 || !isRecord(execution.data)
    || !isRecord(execution.operations))) fail('migration_bots_malformed', 'Invalid queued Bot execution history');
  const runs = readRuns(execution?.data.runs ?? {});
  for (const run of Object.values(runs)) if (run.projectId !== projectId || run.itemId !== itemId || run.bot.id !== item.botId
    || run.directory !== directory || run.bot.isolated) fail('migration_bots_conflict', 'Queued Bot execution placement conflicts with host delivery');
  const key = { projectId, itemId };
  const placementText = await readOptionalAuthority(path.join(source, 'bots/placements', `${digestMutationInput(key)}.json`), owner);
  const placement = placementText === null ? null : readPlacement(parseMigrationRecord(placementText));
  if (placement && (placement.projectId !== projectId || placement.itemId !== itemId || placement.botId !== item.botId
    || placement.hostDirectory !== directory || placement.isolated)
    || !placement && !Object.values(runs).some((run) => run.stage === stage)) fail('migration_bots_conflict', 'Queued Bot notice has no matching captured host placement');
  const binding = await readOptionalAuthority(path.join(source, 'bots/isolated-stages', `${digestMutationInput(key)}.json`), owner);
  if (binding !== null) fail('migration_bots_conflict', 'An isolated Bot notice cannot migrate into a host queue');
}

async function splitMessageQueue(options) {
  const { source, frontData, agentData, front, agent, owner, system, manifest, dryRun, root } = options;
  const file = path.join(source, 'message-queue.json');
  const affected = new Set();
  try {
    const stored = readQueueSnapshot(parseMigrationRecord(await readOwned(file, owner)));
    const ordinarySessions = [];
    const destinations = [];
    const ids = new Set();
    for (const session of Object.values(stored.sessions)) for (const item of session.items) {
      if (item?.notice?.kind === 'bot' && isPrimitiveString(item.notice.projectId) && /^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/.test(item.notice.projectId)) {
        affected.add(projectConfigFileStemOf(item.notice.projectId));
      }
    }
    for (const [sessionId, session] of Object.entries(stored.sessions)) {
      const ordinary = [];
      const bots = [];
      let botOwner;
      for (const item of session.items) {
        readQueuedItem(item);
        if (item.id !== item.id.trim() || ids.has(item.id)) fail('migration_bots_malformed', 'Invalid or duplicate queued message');
        ids.add(item.id);
        if (item.origin?.kind !== 'bot') { ordinary.push(item); continue; }
        const identity = `${item.notice.projectId}\0${item.notice.itemId}`;
        if (botOwner && botOwner !== identity) fail('migration_bots_conflict', 'A queued Bot session has conflicting item owners');
        botOwner = identity;
        const marker = path.join(frontData, 'projects', `${projectConfigFileStemOf(item.notice.projectId)}.json.bots-migration-blocked`);
        if (await fs.lstat(marker).catch((error) => { if (error.code === 'ENOENT') return null; throw error; })) fail('migration_bots_blocked', 'Repair and explicitly clear the project migration blocker before retrying');
        await requireHostQueueOwner(options, sessionId, session.directory, item);
        bots.push(item);
      }
      if (ordinary.length || !session.items.length) ordinarySessions.push([sessionId, { ...session, items: ordinary }]);
      if (bots.length) destinations.push({ target: path.join(frontData, 'bots/host-queues', sessionId, 'message-queue.json'), account: front,
        kind: 'front-door', value: { ...stored, sessions: { [sessionId]: { ...session, items: bots } } } });
    }
    destinations.push({ target: path.join(agentData, 'message-queue.json'), account: agent, kind: 'agent', value: { ...stored, sessions: Object.fromEntries(ordinarySessions) } });
    // Preflight every destination before publishing any part of the shared source queue.
    for (const destination of destinations) await writeSplitJson({ source: file, ...destination, system, manifest, root, dryRun: true });
    if (!dryRun) for (const destination of destinations) await writeSplitJson({ source: file, ...destination, system, manifest, root, dryRun: false });
  } catch (error) {
    if (!affected.size) for (const stem of await entries(path.join(source, 'projects'))) {
      if (await fs.lstat(path.join(source, 'projects', stem, 'bots.json')).catch(() => null)) affected.add(stem);
    }
    if (!affected.size) throw error;
    for (const stem of affected) await blockProjectMigration({ ...options, file, stem, error });
  }
}

/** Caller supplies root-reviewed path authority. Captured descriptors and live directory inodes stay intact. */
async function retainBotWorktrees(options) {
  const { source, botRoot, frontData, front, agentData, agent, owner, system, manifest, dryRun, root, trustedBotWorktrees } = options;
  const directory = path.join(source, 'bot-worktrees');
  const retained = [];
  const live = [];
  const owners = new Map();
  const registries = [];
  const files = [];
  for (const name of await entries(directory)) {
    if (!name.endsWith('.json') || name === 'migration-paths.json') continue;
    const file = path.join(directory, name);
    const text = await readOwned(file, owner);
    if (text === null) fail('migration_bots_malformed', 'Unreadable bot worktree descriptor');
    const record = parseMigrationRecord(text);
    files.push({ name, file });
    if (record && Object.hasOwn(record, 'reservations')) {
      readPublicationRegistry(record);
      if (new Set(record.reservations.map((entry) => entry.publicationBranch)).size !== record.reservations.length
        || new Set(record.reservations.map((entry) => `${entry.owner.botId}\0${entry.owner.itemId}`)).size !== record.reservations.length) {
        fail('migration_bots_conflict', 'Conflicting bot publication authority');
      }
      registries.push(record);
      continue;
    }
    readCheckout(record);
    if (record.branch !== `bot/${record.itemId}`) fail('migration_bots_malformed', 'Invalid bot checkout authority');
    const key = `${record.projectId}\0${record.itemId}`;
    if (owners.has(key)) fail('migration_bots_conflict', 'Duplicate bot checkout ownership');
    owners.set(key, record);
    const fields = ['projectId', 'itemId', 'directory', 'directoryIdentity', 'gitDirectory', 'gitIdentity'];
    const captured = Object.fromEntries(fields.map((key) => [key, record[key]]));
    if (fields.some((key) => !isPrimitiveString(captured[key]) || !captured[key])
      || !trustedBotWorktrees.some((entry) => isDeepStrictEqual(entry, captured))) fail('migration_bots_path_authority_required', 'Existing bot checkouts require an explicit trusted path mapping');
    if (record.state !== 'removed') {
      for (const [location, identity] of [[record.directory, record.directoryIdentity], [record.gitDirectory, record.gitIdentity]]) {
        if (!path.isAbsolute(location)) fail('migration_bots_malformed', 'Invalid bot worktree path');
        const physical = path.join(root, location);
        const stats = await fs.lstat(physical, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink() || await fs.realpath(physical) !== physical
          || `${stats.dev}:${stats.ino}` !== identity) fail('migration_bots_path_changed', 'An existing bot checkout changed identity');
      }
      live.push(captured);
    }
    retained.push(captured);
  }
  for (const registry of registries) for (const reservation of registry.reservations) {
    const owner = owners.get(`${reservation.owner.projectId}\0${reservation.owner.itemId}`);
    const captured = owner && Object.fromEntries(checkoutOwnerKeys.filter((key) => owner[key] !== undefined).map((key) => [key, owner[key]]));
    if (!owner || registry.repositoryId !== owner.repositoryId || !isDeepStrictEqual(captured, reservation.owner)
      || reservation.publicationBranch !== (owner.publicationBranch ?? owner.branch)) fail('migration_bots_conflict', 'Conflicting bot publication ownership');
  }
  try {
    manifest.botWorktreeAccess = await grantRetainedBotAccess({ root, botRoot, entries: live, human: owner, agent, run: system.runResult, dryRun });
  } catch (error) {
    manifest.botWorktreeAccess = error.botAccess ?? { status: 'refused', changed: [] };
    throw error;
  }
  for (const { name, file } of files) await copyEntry({ source: file, target: path.join(agentData, 'bot-worktrees', name), account: agent, owner, system, manifest,
    kind: 'agent', dryRun, root, strict: true });
  if (retained.length) await writeSplitJson({ source: directory, target: path.join(agentData, 'bot-worktrees/migration-paths.json'),
    value: { version: 1, entries: retained }, account: agent, system, manifest, kind: 'agent', dryRun, root });
  if (retained.length) await writeSplitJson({ source: directory, target: path.join(frontData, 'bots/migration-paths.json'),
    value: { version: 1, entries: retained }, account: front, system, manifest, kind: 'front-door', dryRun, root });
  manifest.botWorktrees = retained;
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
export async function migrateAccounts({ root = '/', system, accounts, envFile, dryRun = false, sharing, trustedBotWorktrees = [], say = () => {} }) {
  const at = (file) => path.join(root, file);
  const { human, front, agent } = accounts;
  const oldData = oldDataDirectory(await readOptional(envFile), human);
  const source = at(oldData);
  const frontData = at(`${FRONT_HOME}/.config/openchamber`);
  const agentData = at(`${agent.home}/.config/openchamber`);
  const manifestFile = at(`${FRONT_HOME}/migration.json`);
  const previous = await readOptional(manifestFile);
  const manifest = previous ? JSON.parse(previous) : { version: 1, files: [], worktrees: [], projects: [] };
  manifest.blockedProjects = [];
  const originalCount = manifest.files.length;
  for (const directory of [frontData, agentData, at(`${agent.home}/.local/share/opencode`), at(`${agent.home}/.config/opencode`)]) await requirePhysicalDirectory(root, directory);
  if (!dryRun) for (const unit of ['openchamber.service', 'openchamber-agent.service']) {
    if (!['inactive', 'failed', 'unknown'].includes(await system.isActive(unit))) fail('migration_runtime_running', `Stop ${unit} before migrating account data`);
  }
  if (!dryRun) {
    for (const [directory, account] of [[at(`${FRONT_HOME}/.config`), front], [frontData, front], [at(`${agent.home}/.config`), agent], [agentData, agent], [at(`${agent.home}/.local`), agent], [at(`${agent.home}/.local/share`), agent]]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await ownTree(system, directory, account);
    }
  }
  try {
    for (const name of await entries(source)) {
      const kind = classify(name);
      const options = { source, botRoot: path.join(oldData, 'bot-worktrees'), frontData, agentData, front, agent, owner: human, system, manifest, dryRun, root, trustedBotWorktrees };
      if (name === 'projects') { await splitProjects(options); continue; }
      if (name === 'bots') { await splitBotControl(options); continue; }
      if (name === 'bot-worktrees') { await retainBotWorktrees(options); continue; }
      if (name === 'message-queue.json') { await splitMessageQueue(options); continue; }
      if (kind === 'skipped') { manifest.files.push({ source: path.join(source, name), target: null, class: kind, status: 'skipped' }); continue; }
      if (name === FIX_LOOPS) {
        await splitFixLoops({ file: path.join(source, name), frontData, agentData, front, agent, owner: human, system, manifest, dryRun, root });
        continue;
      }
      const account = kind === 'agent' ? agent : front;
      const target = path.join(kind === 'agent' ? agentData : frontData, name);
      await copyEntry({ source: path.join(source, name), target, account, owner: human, system, manifest, kind, dryRun, root,
        strict: name === 'bot-provider-events.json' || AGENT_BOT_RECORDS.has(name) });
      if (kind === 'unclassified') say(`Unclassified data retained by the front door: ${name}`);
    }
    if (manifest.blockedProjects?.length) fail('migration_bots_blocked', 'Repair the blocked Bots projects before starting either runtime');
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
