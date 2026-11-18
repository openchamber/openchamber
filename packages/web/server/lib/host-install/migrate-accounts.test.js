import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT, fakeSystem, FRONT, hostRoot, OWNER } from './fake-system.js';
import { classify, migrateAccounts, oldDataDirectory, ownTree } from './migrate-accounts.js';
import { createOwnerBotConfig } from '../bots/owner-config.js';
import { createBotItem } from '../bots/schema.js';
import { createProjectIdFromPath, projectConfigFileStemOf } from '../projects/project-id.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
const setup = async () => {
  const root = await hostRoot(cleanups);
  const system = fakeSystem(root);
  system.isActive = async () => 'inactive';
  const aclCalls = [];
  system.runResult = async (command, args) => {
    system.calls.push([command, args]);
    const target = await fs.realpath(args.at(-1));
    aclCalls.push({ command, args, target });
    const stat = await fs.stat(target);
    const perms = (value) => `${value & 4 ? 'r' : '-'}${value & 2 ? 'w' : '-'}${value & 1 ? 'x' : '-'}`;
    return { code: 0, stdout: command.endsWith('/getfacl')
      ? `user::${perms(stat.mode >> 6)}\ngroup::${perms(stat.mode >> 3)}\nother::${perms(stat.mode)}\n` : '', stderr: '' };
  };
  // The fixtures belong to whoever runs the test, as the human's data belongs to the human.
  const accounts = { human: { ...OWNER, uid: process.getuid() }, front: FRONT, agent: AGENT };
  const envFile = path.join(root, 'etc/openchamber/openchamber.env');
  const source = path.join(root, OWNER.home, '.config/openchamber');
  const options = { root, system, accounts, envFile };
  return { root, system, source, options, aclCalls, front: path.join(root, FRONT.home, '.config/openchamber'), agent: path.join(root, AGENT.home, '.config/openchamber') };
};

async function capturedCheckout(f, { itemId = 'item', state = 'ready', publicationBranch } = {}) {
  const directory = `/home/alice/.config/openchamber/bot-worktrees/${itemId}`;
  const gitDirectory = `/home/alice/project/.git/worktrees/${itemId}`;
  await write(path.join(f.root, directory, 'code.js'), 'retained code');
  await write(path.join(f.root, gitDirectory, 'HEAD'), `ref: refs/heads/bot/${itemId}\n`);
  const identity = async (location) => { const stats = await fs.stat(path.join(f.root, location), { bigint: true }); return `${stats.dev}:${stats.ino}`; };
  const mapping = { projectId: 'p', itemId, directory, directoryIdentity: await identity(directory), gitDirectory, gitIdentity: await identity(gitDirectory) };
  const owner = { version: 1, ...mapping, projectPath: '/home/alice/project', botId: 'b', repositoryId: 'R_exact', key: `captured-${itemId}`,
    branch: `bot/${itemId}`, baseBranch: 'main', baseSha: 'a'.repeat(40), identityId: 'identity', identityRevision: 7 };
  const descriptor = { ...owner, state };
  if (publicationBranch) descriptor.publicationBranch = publicationBranch;
  const text = ` ${JSON.stringify(descriptor)}\n`;
  const file = path.join(f.source, 'bot-worktrees', `${itemId}.json`);
  await write(file, text);
  return { mapping, descriptor, owner, text, file };
}

describe('account migration', () => {
  it.each([
    ['settings.json', 'front-door'], ['ui-passkeys.json', 'front-door'], ['jwt-secret', 'front-door'], ['client-pairing-sessions.json', 'front-door'], ['remote-clients.json', 'front-door'], ['relay-identity.json', 'front-door'], ['apns-tokens.json', 'front-door'], ['notification-center.json', 'front-door'], ['notification-center-version.json', 'front-door'], ['spaces', 'front-door'], ['mcp-protected', 'front-door'], ['install-id-a', 'front-door'], ['preferences.json', 'front-door'], ['voice-keys.json', 'front-door'], ['speech-models', 'front-door'],
    ...('agent-tool chats dispatch-results.json extensions extensions.json extensions-deploy.json git-identities.json github-auth.json goals guest-services guest-storage managed-opencode mcp-project-local memory.json message-queue.json opencode-trust.json opencode.managed.json pr-fix-loops.json pr-watch.json projects project-icons session-drafts session-drafts.json session-warming.json sessions-archive.json sessions-directories.json sessions-unread.json skills-catalog-cache.json skills-github-meta.json source-control-audit.json source-control-bindings.json tracked-items.json walkthroughs classification.json').split(' ').map((name) => [name, 'agent']),
    ...['cache', 'tmp', 'run', 'logs', 'bin', 'git-identities.json.lock', 'update-install.log'].map((name) => [name, 'skipped']), ['unknown-file', 'unclassified'],
  ])('classifies %s as %s', (name, kind) => {
    // Given / When / Then
    expect(classify(name)).toBe(kind);
  });

  it('copies both account classes and mirrors only allowed settings, leaving the human data intact', async () => {
    // Given
    const { root, system, source, options, front, agent } = await setup();
    const settings = { locale: 'pt-BR', projects: [{ id: 'one', path: '/home/alice/project', injectedSecret: 'secret' }], desktopUiPassword: 'password', managedRemoteTunnelToken: 'token', isolatedSpacesEnabled: true, tunnelStuff: 'secret' };
    await write(path.join(source, 'settings.json'), JSON.stringify(settings));
    await write(path.join(source, 'chats/chat.json'), 'chat');
    await write(path.join(source, 'unknown-file'), 'unclassified');
    await write(path.join(source, 'cache/cache'), 'cache');
    const calls = [];
    // When
    const report = await migrateAccounts({ ...options, sharing: { share: async (directory) => { calls.push(directory); throw Object.assign(new Error('owner config'), { code: 'refused' }); } } });
    // Then
    expect(JSON.parse(await fs.readFile(path.join(front, 'settings.json'), 'utf8'))).toEqual(settings);
    expect(JSON.parse(await fs.readFile(path.join(agent, 'settings.json'), 'utf8'))).toEqual({ locale: 'pt-BR', projects: [{ id: 'one', path: '/home/alice/project' }] });
    expect(await fs.readFile(path.join(agent, 'chats/chat.json'), 'utf8')).toBe('chat');
    expect(await fs.readFile(path.join(front, 'unknown-file'), 'utf8')).toBe('unclassified');
    expect(await fs.readFile(path.join(source, 'chats/chat.json'), 'utf8')).toBe('chat');
    expect(await fs.lstat(path.join(front, 'cache')).catch(() => null)).toBeNull();
    expect(report.files).toContainEqual(expect.objectContaining({ source: path.join(source, 'unknown-file'), target: path.join(front, 'unknown-file'), class: 'unclassified', status: 'copied' }));
    expect(report.projects).toEqual([expect.objectContaining({ status: 'refused', code: 'refused' })]);
    expect(calls).toEqual(['/home/alice/project']);
    const manifest = path.join(root, FRONT.home, 'migration.json');
    expect((await fs.stat(manifest)).mode & 0o777).toBe(0o600);
    expect(system.calls).toContainEqual(['chown', manifest, 0, 0]);
  });

  it('moves approval fix loops and prepared workers to the front door and keeps automatic loops on the agent', async () => {
    // Given a single-account fix-loop file with an automatic loop, an approval loop and a prepared worker.
    const { system, source, options, front, agent } = await setup();
    const loop = (id, extra) => ({ id, sessionId: 'ses_a', internal: {}, config: { pushMode: 'auto' }, ...extra });
    const stored = { version: 2, loops: [loop('fixloop_auto'), loop('fixloop_approval', { config: { pushMode: 'approval' }, worker: { id: 'w' } }),
      loop('fixloop_receipt', { pendingApproval: { id: 'r' } })], workers: [{ id: 'prepared' }] };
    await write(path.join(source, 'pr-fix-loops.json'), JSON.stringify(stored));
    // When the accounts are separated.
    const report = await migrateAccounts(options);
    // Then each runtime gets the loops it can run, owned by its account; the human's file is unchanged.
    const read = async (directory) => JSON.parse(await fs.readFile(path.join(directory, 'pr-fix-loops.json'), 'utf8'));
    expect(await read(front)).toEqual({ version: 2, loops: [stored.loops[1], stored.loops[2]], workers: [{ id: 'prepared' }] });
    expect(await read(agent)).toEqual({ version: 2, loops: [stored.loops[0]], workers: [] });
    expect(system.calls).toContainEqual(['chown', path.join(front, 'pr-fix-loops.json'), FRONT.uid, FRONT.gid]);
    expect(system.calls).toContainEqual(['chown', path.join(agent, 'pr-fix-loops.json'), AGENT.uid, AGENT.gid]);
    expect(JSON.parse(await fs.readFile(path.join(source, 'pr-fix-loops.json'), 'utf8'))).toEqual(stored);
    expect(report.files.filter((file) => file.source.endsWith('pr-fix-loops.json')).map((file) => [file.class, file.status]))
      .toEqual([['front-door', 'copied'], ['agent', 'copied']]);
  });

  it('resolves OpenCode config links into regular copies and excludes worktrees and binaries', async () => {
    // Given
    const { root, options } = await setup();
    const config = path.join(root, OWNER.home, '.config/opencode');
    const share = path.join(root, OWNER.home, '.local/share/opencode');
    const linked = path.join(root, OWNER.home, 'versioned-config');
    await write(linked, 'settings');
    await fs.mkdir(config, { recursive: true });
    await fs.symlink(linked, path.join(config, 'opencode.json'));
    await write(path.join(share, 'opencode.db'), 'database');
    for (const name of ['worktree/one/file', 'log/file', 'bin/opencode']) await write(path.join(share, name), name);
    // When
    const report = await migrateAccounts(options);
    // Then
    const target = path.join(root, AGENT.home, '.config/opencode/opencode.json');
    expect((await fs.lstat(target)).isFile()).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('settings');
    expect(await fs.readFile(path.join(root, AGENT.home, '.local/share/opencode/opencode.db'), 'utf8')).toBe('database');
    for (const name of ['worktree', 'log', 'bin']) expect(await fs.lstat(path.join(root, AGENT.home, '.local/share/opencode', name)).catch(() => null)).toBeNull();
    expect(report.worktrees).toEqual([`${OWNER.home}/.local/share/opencode/worktree/one`]);
  });

  it('keeps existing files and resumes missing entries after a partial copy', async () => {
    // Given
    const { source, options, agent } = await setup();
    await write(path.join(source, 'chats/first'), 'old');
    await migrateAccounts(options);
    await write(path.join(agent, 'chats/first'), 'keep');
    await write(path.join(source, 'chats/second'), 'new');
    // When
    await migrateAccounts(options);
    // Then
    expect(await fs.readFile(path.join(agent, 'chats/first'), 'utf8')).toBe('keep');
    expect(await fs.readFile(path.join(agent, 'chats/second'), 'utf8')).toBe('new');
    expect(await fs.readFile(path.join(source, 'chats/first'), 'utf8')).toBe('old');
  });

  it('copies no link target the human does not own, file or directory, and leaves a record', async () => {
    // Given links an agent running as the human planted in its data, to files only root may read.
    const { root, source, options, agent } = await setup();
    await write(path.join(source, 'chats/own'), 'chat');
    await fs.symlink('/etc/hostname', path.join(source, 'chats/stolen'));
    await fs.symlink('/etc', path.join(source, 'goals'));
    await fs.symlink('/etc/hostname', path.join(source, 'git-x.json'));
    const opencode = path.join(root, OWNER.home, '.config/opencode');
    await fs.mkdir(opencode, { recursive: true });
    await fs.symlink('/etc/hostname', path.join(opencode, 'opencode.json'));
    // When the accounts are separated.
    const report = await migrateAccounts(options);
    // Then only the human's own file is copied; each foreign target is recorded and not copied.
    expect(await fs.readFile(path.join(agent, 'chats/own'), 'utf8')).toBe('chat');
    for (const target of [path.join(agent, 'chats/stolen'), path.join(agent, 'goals'), path.join(agent, 'git-x.json'), path.join(root, AGENT.home, '.config/opencode/opencode.json')]) {
      expect(await fs.lstat(target).catch(() => null)).toBeNull();
    }
    expect(report.files.filter((file) => file.status === 'foreign-skipped').map((file) => path.basename(file.source)).sort())
      .toEqual(['git-x.json', 'goals', 'opencode.json', 'stolen']);
  });

  it('leaves a hard-linked file out of an ownership repair', async () => {
    // Given an agent home holding its own file and a second name for a file it does not own.
    const { root, system } = await setup();
    const home = path.join(root, AGENT.home);
    await write(path.join(home, 'own'), 'own');
    await write(path.join(root, 'project/shared'), 'human');
    await fs.link(path.join(root, 'project/shared'), path.join(home, 'linked'));
    // When the home's ownership is repaired.
    await ownTree(system, home, AGENT);
    // Then the linked file keeps its owner.
    const chowned = system.calls.filter(([name]) => name === 'chown').map(([, target]) => path.basename(target));
    expect(chowned).toContain('own');
    expect(chowned).not.toContain('linked');
  });

  it('does not follow a pre-existing destination symlink', async () => {
    // Given
    const { root, source, options, agent } = await setup();
    await write(path.join(source, 'memory.json'), 'new');
    const kept = path.join(root, 'kept');
    await write(kept, 'keep');
    await fs.mkdir(agent, { recursive: true });
    await fs.symlink(kept, path.join(agent, 'memory.json'));
    // When
    await migrateAccounts(options);
    // Then
    expect(await fs.readFile(kept, 'utf8')).toBe('keep');
    expect((await fs.lstat(path.join(agent, 'memory.json'))).isSymbolicLink()).toBe(true);
  });

  it('refuses a destination ancestor linked into human data before changing any ownership', async () => {
    // Given
    const { root, source, options, system } = await setup();
    await write(path.join(source, 'memory.json'), 'human data');
    const agentHome = path.join(root, AGENT.home);
    await fs.mkdir(agentHome, { recursive: true });
    await fs.symlink(path.join(root, OWNER.home, '.config'), path.join(agentHome, '.config'));
    // When / Then
    await expect(migrateAccounts(options)).rejects.toMatchObject({ code: 'migration_destination_link' });
    expect(system.calls).toEqual([]);
    expect(await fs.readFile(path.join(source, 'memory.json'), 'utf8')).toBe('human data');
  });

  it('prints a complete dry run without creating accounts, destinations or a manifest', async () => {
    // Given
    const { root, source, options, front, agent, system } = await setup();
    await write(path.join(source, 'goals/one'), 'goal');
    const output = [];
    // When
    const report = await migrateAccounts({ ...options, dryRun: true, say: (text) => output.push(text) });
    // Then
    expect(report.files).toContainEqual(expect.objectContaining({ source: path.join(source, 'goals/one'), class: 'agent', status: 'planned' }));
    expect(JSON.parse(output.at(-1)).files).toEqual(report.files);
    for (const target of [front, agent, path.join(root, FRONT.home, 'migration.json')]) expect(await fs.lstat(target).catch(() => null)).toBeNull();
    expect(system.calls).toEqual([]);
  });

  it('uses an absolute data directory from the old env without executing its content', () => {
    // Given / When / Then
    expect(oldDataDirectory('OPENCHAMBER_DATA_DIR="/srv/my data"\nOTHER=$(touch /bad)', OWNER)).toBe('/srv/my data');
    expect(oldDataDirectory('OPENCHAMBER_DATA_DIR=relative', OWNER)).toBe('/home/alice/.config/openchamber');
  });

  it.each(['openchamber.service', 'openchamber-agent.service'])('refuses copying while %s is running', async (active) => {
    const f = await setup();
    f.system.isActive = async (unit) => unit === active ? 'active' : 'inactive';
    await write(path.join(f.source, 'bots/discovery/a.json'), '{"version":1}');
    await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_runtime_running' });
    expect(f.system.calls).toEqual([]);
    expect(await fs.lstat(f.front).catch(() => null)).toBeNull();
  });

  it('classifies Bot control, secrets and execution authority explicitly', () => {
    for (const name of ['bots', 'bot-provider-events.json']) expect(classify(name)).toBe('front-door');
    for (const name of ['bot-identities.json', 'bot-worktrees', 'source-control-mutations.json', 'source-control-audit.json']) expect(classify(name)).toBe('agent');
  });

  it('splits canonical project config and Bot rows while preserving descriptor bytes, IDs, revisions and unknown outcomes', async () => {
    const f = await setup();
    const projectId = createProjectIdFromPath(`/unreadable/${'nested/'.repeat(60)}`);
    const stem = projectConfigFileStemOf(projectId);
    const row = { id: 'historical-row-id', botId: 'b', name: 'Bot', enabled: true,
      schedule: { kind: 'daily', time: '09:00' }, execution: { useDefaults: true, prompt: 'Run' },
      state: { lastScheduledFor: 12345, futureReceipt: { unknown: true } }, newerField: ['preserve'] };
    const ordinary = { id: 'user-task', name: 'Keep', loopFile: '/project/.agents/loops/a.md' };
    const bots = { definitions: [{ id: 'b', name: 'Bot', mission: 'Fix' }], approvals: {} };
    const config = { version: 1, bots, scheduledTasks: [ordinary, row], suggestedTasks: { enabled: true }, unknownRoot: { keep: true } };
    const item = createBotItem({ id: 'item-stable', botId: 'b', source: { kind: 'manual', id: 'source-stable' }, title: 'Keep', now: 9 });
    Object.assign(item, { revision: 77, worktree: '/existing/live-checkout', branch: 'bot/item-stable', sessions: { fixing: 'ses_existing' },
      effects: [{ key: 'effect-stable', kind: 'git.push', inputDigest: 'a'.repeat(64), authority: { service: 'git', identityId: 'identity-stable', revision: 11, target: 'exact-remote' },
        createdAt: 9, updatedAt: 10, state: 'outcome-unknown', code: 'response-lost' }] });
    const snapshot = ` { "version": 1, "revision": 123, "items": ${JSON.stringify([item])} }\n`;
    const descriptor = ' {"version":1,"operations":{"effect-stable":{"directory":"/existing/live-checkout","receipt":{"state":"unknown","operationKey":"stable"}}},"data":{"runs":{"fixing":{"id":"unchanged"}}}}\n';
    await write(path.join(f.source, 'projects', `${stem}.json`), JSON.stringify(config));
    await write(path.join(f.source, 'projects', stem, 'bots.json'), snapshot);
    await write(path.join(f.source, 'projects', stem, 'bot-executions/a.json'), descriptor);
    await write(path.join(f.source, 'projects', stem, 'memory/keep.md'), 'ordinary memory');
    const control = ' { "version": 1, "pending": [{"receipt":"unknown","id":"dispatch-stable"}] }\n';
    for (const name of ['placements', 'isolated-stages', 'isolated-queues', 'discovery', 'isolated-tool-receipts', 'provider-links']) {
      await write(path.join(f.source, 'bots', name, 'a.json'), control);
    }
    const hostPlacement = '{"version":1,"projectId":"p","itemId":"item-stable","botId":"b","hostDirectory":"/existing/live-checkout","isolated":false}\n';
    await write(path.join(f.source, 'bots/placements/host.json'), hostPlacement);
    await write(path.join(f.source, 'bots/proof/scratch/project-code.cjs'), 'untrusted execution object');
    for (const name of ['bot-identities.json', 'source-control-mutations.json', 'source-control-audit.json']) await write(path.join(f.source, name), control);
    await migrateAccounts(f.options);
    expect(JSON.parse(await fs.readFile(path.join(f.front, 'projects', `${stem}.json`), 'utf8'))).toEqual({ version: 1, bots, scheduledTasks: [row] });
    const { bots: _bots, ...expected } = config; expected.scheduledTasks = [ordinary];
    expect(JSON.parse(await fs.readFile(path.join(f.agent, 'projects', `${stem}.json`), 'utf8'))).toEqual(expected);
    expect(await fs.readFile(path.join(f.front, 'projects', stem, 'bots.json'), 'utf8')).toBe(snapshot);
    expect(await fs.readFile(path.join(f.front, 'projects', stem, 'bot-executions/a.json'), 'utf8')).toBe(descriptor);
    expect(await fs.readFile(path.join(f.agent, 'projects', stem, 'memory/keep.md'), 'utf8')).toBe('ordinary memory');
    expect(await fs.lstat(path.join(f.agent, 'projects', stem, 'bots.json')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(f.front, 'bots/placements/host.json'), 'utf8')).toBe(hostPlacement);
    expect(await fs.readFile(path.join(f.agent, 'bots/proof/scratch/project-code.cjs'), 'utf8')).toBe('untrusted execution object');
    expect(await fs.lstat(path.join(f.front, 'bots/proof')).catch(() => null)).toBeNull();
    for (const name of ['placements', 'isolated-stages', 'isolated-queues', 'discovery', 'isolated-tool-receipts', 'provider-links']) {
      expect(await fs.readFile(path.join(f.front, 'bots', name, 'a.json'), 'utf8')).toBe(control);
      expect(await fs.lstat(path.join(f.agent, 'bots', name)).catch(() => null)).toBeNull();
    }
    for (const name of ['bot-identities.json', 'source-control-mutations.json', 'source-control-audit.json']) expect(await fs.readFile(path.join(f.agent, name), 'utf8')).toBe(control);
    expect((await createOwnerBotConfig({ projectsDirPath: path.join(f.front, 'projects') }).listScheduledTasks(projectId))[0]).toEqual(row);
    await migrateAccounts(f.options);
    expect(await fs.readFile(path.join(f.front, 'projects', stem, 'bot-executions/a.json'), 'utf8')).toBe(descriptor);
  });

  it('moves auto Bot watches to the owner without rewriting private authority or history', async () => {
    const f = await setup();
    const botAuthority = { project: { id: 'p', path: '/project' }, botId: 'b', itemId: 'item', identityId: 'identity', identityRevision: 3,
      target: { repositoryId: 'R_exact', owner: 'acme', repo: 'app' } };
    const watch = { id: 'watch-stable', sessionId: 'ses_existing', owner: 'acme', repo: 'app', number: 3, branch: 'bot/item',
      config: { pushMode: 'auto' }, botAuthority, internal: { handled: [1, 2], receipt: { state: 'unknown' } }, revision: 27 };
    const auto = { id: 'auto-stable', sessionId: 'ses_user', config: { pushMode: 'auto' }, internal: {} };
    await write(path.join(f.source, 'pr-fix-loops.json'), JSON.stringify({ version: 2, loops: [watch, auto], workers: [] }));
    await migrateAccounts(f.options);
    expect(JSON.parse(await fs.readFile(path.join(f.front, 'pr-fix-loops.json'), 'utf8')).loops).toEqual([watch]);
    expect(JSON.parse(await fs.readFile(path.join(f.agent, 'pr-fix-loops.json'), 'utf8')).loops).toEqual([auto]);
  });

  it.each(['malformed', 'conflict', 'duplicate-id'])('blocks an affected project on %s and preserves both copies', async (kind) => {
    const f = await setup();
    const raw = kind === 'malformed' ? '{broken' : JSON.stringify({ version: 1, bots: {}, scheduledTasks: kind === 'duplicate-id' ? [{ id: 'a' }, { id: 'a' }] : [] });
    await write(path.join(f.source, 'projects/bad.json'), raw);
    await write(path.join(f.source, 'projects/good.json'), '{"version":1,"bots":{},"scheduledTasks":[]}');
    if (kind === 'conflict') await write(path.join(f.front, 'projects/bad.json'), '{"version":1,"bots":{"definitions":[]},"scheduledTasks":[]}');
    await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_blocked' });
    expect(await fs.readFile(path.join(f.source, 'projects/bad.json'), 'utf8')).toBe(raw);
    if (kind === 'conflict') expect(await fs.readFile(path.join(f.front, 'projects/bad.json'), 'utf8')).toBe('{"version":1,"bots":{"definitions":[]},"scheduledTasks":[]}');
    const owner = createOwnerBotConfig({ projectsDirPath: path.join(f.front, 'projects') });
    await expect(owner.readBotsSection('bad')).rejects.toThrow('migration is blocked');
    expect(await owner.readBotsSection('good')).toEqual({});
  });

  it('retains live checkout paths and inode identities only through an explicit verified mapping', async () => {
    const f = await setup();
    const directory = '/home/alice/.config/openchamber/bot-worktrees/live';
    const gitDirectory = '/home/alice/project/.git/worktrees/live';
    await write(path.join(f.root, directory, 'keep'), 'work');
    await write(path.join(f.root, gitDirectory, 'keep'), 'git');
    const identity = async (location) => { const stats = await fs.stat(path.join(f.root, location), { bigint: true }); return `${stats.dev}:${stats.ino}`; };
    const mapping = { projectId: 'p', itemId: 'item', directory, directoryIdentity: await identity(directory), gitDirectory, gitIdentity: await identity(gitDirectory) };
    const descriptor = ` {"version":1,"state":"ready",${JSON.stringify(mapping).slice(1, -1)},"projectPath":"/home/alice/project","botId":"b","repositoryId":"R_exact","key":"captured-key","branch":"bot/item","baseBranch":"main","baseSha":"${'a'.repeat(40)}","identityId":"identity","identityRevision":7}\n`;
    await write(path.join(f.source, 'bot-worktrees/owner.json'), descriptor);
    await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_path_authority_required' });
    await migrateAccounts({ ...f.options, trustedBotWorktrees: [mapping] });
    expect(await fs.readFile(path.join(f.agent, 'bot-worktrees/owner.json'), 'utf8')).toBe(descriptor);
    expect(JSON.parse(await fs.readFile(path.join(f.agent, 'bot-worktrees/migration-paths.json'), 'utf8'))).toEqual({ version: 1, entries: [mapping] });
    expect(JSON.parse(await fs.readFile(path.join(f.front, 'bots/migration-paths.json'), 'utf8'))).toEqual({ version: 1, entries: [mapping] });
    expect(await identity(directory)).toBe(mapping.directoryIdentity);
    expect(await identity(gitDirectory)).toBe(mapping.gitIdentity);
    expect(await fs.lstat(path.join(f.agent, 'bot-worktrees/live')).catch(() => null)).toBeNull();
    await expect(migrateAccounts({ ...f.options, trustedBotWorktrees: [{ ...mapping, directoryIdentity: '1:1' }] })).rejects.toMatchObject({ code: 'migration_bots_path_authority_required' });
    await fs.rename(path.join(f.root, directory), path.join(f.root, `${directory}.retained`));
    await fs.mkdir(path.join(f.root, directory));
    await expect(migrateAccounts({ ...f.options, trustedBotWorktrees: [mapping] })).rejects.toMatchObject({ code: 'migration_bots_path_changed' });
    expect(await identity(`${directory}.retained`)).toBe(mapping.directoryIdentity);
    expect(await fs.readFile(path.join(f.source, 'bot-worktrees/owner.json'), 'utf8')).toBe(descriptor);
  });

  it('refuses malformed Bot control and conflicting byte descriptors without replacing source or destination', async () => {
    const f = await setup();
    await write(path.join(f.source, 'bots/placements/a.json'), '{bad');
    await expect(migrateAccounts(f.options)).rejects.toThrow();
    expect(await fs.readFile(path.join(f.source, 'bots/placements/a.json'), 'utf8')).toBe('{bad');
    await write(path.join(f.source, 'bots/placements/a.json'), '{"version":1,"key":"original"}');
    await write(path.join(f.front, 'bots/placements/a.json'), '{"version":1,"key":"conflict"}');
    await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_conflict' });
    expect(await fs.readFile(path.join(f.front, 'bots/placements/a.json'), 'utf8')).toBe('{"version":1,"key":"conflict"}');
  });

  it('refuses a historical Bot watch and automatic loop conflict before creating either loop file', async () => {
    const f = await setup();
    const botAuthority = { project: { id: 'p', path: '/project' }, botId: 'b', itemId: 'item', identityId: 'identity', identityRevision: 3,
      target: { repositoryId: 'R_exact', owner: 'acme', repo: 'app' } };
    const common = { owner: 'acme', repo: 'app', number: 3, status: 'watching', internal: {}, config: { pushMode: 'auto' } };
    const stored = { version: 2, loops: [{ ...common, id: 'bot-watch', sessionId: 'ses_bot', branch: 'bot/item', botAuthority },
      { ...common, id: 'user-auto', sessionId: 'ses_user' }], workers: [] };
    const text = JSON.stringify(stored);
    await write(path.join(f.source, 'pr-fix-loops.json'), text);
    await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_conflict' });
    expect(await fs.readFile(path.join(f.source, 'pr-fix-loops.json'), 'utf8')).toBe(text);
    for (const target of [f.front, f.agent]) expect(await fs.lstat(path.join(target, 'pr-fix-loops.json')).catch(() => null)).toBeNull();
  });

  it.each(['bot-identities.json', 'source-control-mutations.json', 'source-control-audit.json'])('refuses conflicting agent-side %s without erasing an unknown receipt', async (name) => {
    const f = await setup();
    const source = '[{"id":"stable","receipt":{"state":"unknown","operationKey":"captured"}}]';
    const target = '[{"id":"different"}]';
    await write(path.join(f.source, name), source);
    await write(path.join(f.agent, name), target);
    await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_conflict' });
    expect(await fs.readFile(path.join(f.source, name), 'utf8')).toBe(source);
    expect(await fs.readFile(path.join(f.agent, name), 'utf8')).toBe(target);
  });

  it('finishes a repaired project only after its blocker is explicitly cleared, retaining failure history', async () => {
    const f = await setup();
    await write(path.join(f.source, 'projects/p.json'), '{broken');
    await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_blocked' });
    await write(path.join(f.source, 'projects/p.json'), '{"version":1,"bots":{},"scheduledTasks":[]}');
    await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_blocked' });
    await fs.unlink(path.join(f.front, 'projects/p.json.bots-migration-blocked'));
    const result = await migrateAccounts(f.options);
    expect(result.blockedProjects).toEqual([]);
    expect(result.files.some((entry) => entry.status === 'blocked')).toBe(true);
    expect(await createOwnerBotConfig({ projectsDirPath: path.join(f.front, 'projects') }).readBotsSection('p')).toEqual({});
  });

  it('grants retained live roots independently of ordinary project sharing without giving access to their private parent data', async () => {
    const f = await setup();
    const c = await capturedCheckout(f);
    for (const directory of ['/home/alice', '/home/alice/.config', '/home/alice/.config/openchamber', '/home/alice/.config/openchamber/bot-worktrees']) {
      await fs.chmod(path.join(f.root, directory), 0o700);
    }
    await write(path.join(f.source, 'settings.json'), '{"projects":[{"id":"p","path":"/home/alice/project"}]}');
    const shares = [];
    const result = await migrateAccounts({ ...f.options, trustedBotWorktrees: [c.mapping], sharing: { share: async (directory) => { shares.push(directory); return { status: 'shared' }; } } });
    expect(shares).toEqual(['/home/alice/project']);
    expect(result.botWorktreeAccess.status).toBe('granted');
    const grants = f.aclCalls.filter((call) => call.command.endsWith('/setfacl'));
    expect(grants.some((call) => call.target === path.join(f.root, c.mapping.directory))).toBe(true);
    expect(grants.some((call) => call.target === path.join(f.root, c.mapping.gitDirectory))).toBe(true);
    for (const directory of ['/home/alice', '/home/alice/.config', '/home/alice/.config/openchamber', '/home/alice/.config/openchamber/bot-worktrees']) {
      const grant = grants.find((call) => call.target === path.join(f.root, directory));
      expect(grant.args[1]).toContain(`user:${AGENT.uid}:--x`);
      expect(grant.args[1]).not.toContain('d:');
    }
    expect(grants.some((call) => call.target.endsWith('/settings.json'))).toBe(false);
    expect(await fs.readFile(c.file, 'utf8')).toBe(c.text);
    expect(await fs.readFile(path.join(f.agent, 'bot-worktrees/item.json'), 'utf8')).toBe(c.text);
  });

  it('maps removed owners and validates their publication registries without granting or recreating removed paths', async () => {
    const f = await setup();
    const live = await capturedCheckout(f, { itemId: 'live' });
    const removed = await capturedCheckout(f, { itemId: 'retired', state: 'removed', publicationBranch: 'task/BUG-1' });
    const registry = ` ${JSON.stringify({ version: 1, repositoryId: 'R_exact', reservations: [{ publicationBranch: 'task/BUG-1', owner: removed.owner }] })}\n`;
    await write(path.join(f.source, 'bot-worktrees/repository.publications.json'), registry);
    await fs.rename(path.join(f.root, removed.mapping.directory), path.join(f.root, `${removed.mapping.directory}.retained`));
    await fs.rename(path.join(f.root, removed.mapping.gitDirectory), path.join(f.root, `${removed.mapping.gitDirectory}.retained`));
    const result = await migrateAccounts({ ...f.options, trustedBotWorktrees: [live.mapping, removed.mapping] });
    expect(result.botWorktrees).toEqual([live.mapping, removed.mapping]);
    expect(result.botWorktreeAccess.trees).toEqual([path.join(f.root, live.mapping.directory), path.join(f.root, live.mapping.gitDirectory)]);
    expect(f.aclCalls.some((call) => call.target.includes('retired'))).toBe(false);
    expect(await fs.lstat(path.join(f.root, removed.mapping.directory)).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(f.agent, 'bot-worktrees/retired.json'), 'utf8')).toBe(removed.text);
    expect(await fs.readFile(path.join(f.agent, 'bot-worktrees/repository.publications.json'), 'utf8')).toBe(registry);
    expect(JSON.parse(await fs.readFile(path.join(f.front, 'bots/migration-paths.json'), 'utf8')).entries).toEqual([live.mapping, removed.mapping]);
  });

  it.each(['mixed-registry', 'missing-version', 'wrong-adoption', 'bad-inode-shape', 'unknown-owner-field', 'wrong-reservation-version'])('rejects malformed %s before ACL grants or descriptor copies', async (kind) => {
    const f = await setup();
    const c = await capturedCheckout(f);
    const record = { ...c.descriptor };
    if (kind === 'mixed-registry') record.reservations = [];
    if (kind === 'missing-version') delete record.version;
    if (kind === 'wrong-adoption') record.adoption = { fromSha: 'a'.repeat(40), resultSha: 'b'.repeat(40), resultRef: 'refs/openchamber/spaces/abcdef123456/result' };
    if (kind === 'bad-inode-shape') record.gitIdentity = 'not-an-inode';
    if (kind === 'unknown-owner-field') record.unrecognizedAuthority = true;
    if (kind === 'wrong-reservation-version') {
      await write(path.join(f.source, 'bot-worktrees/repository.publications.json'), JSON.stringify({ version: 1, repositoryId: 'R_exact',
        reservations: [{ publicationBranch: c.owner.branch, owner: { ...c.owner, version: 2 } }] }));
    } else await write(c.file, JSON.stringify(record));
    await expect(migrateAccounts({ ...f.options, trustedBotWorktrees: [c.mapping] })).rejects.toMatchObject({ code: 'migration_bots_malformed' });
    expect(f.aclCalls.filter((call) => call.command.endsWith('/setfacl'))).toEqual([]);
    expect(await fs.lstat(path.join(f.agent, 'bot-worktrees/item.json')).catch(() => null)).toBeNull();
  });

  it('refuses a publication reservation that disagrees with its retained immutable checkout owner', async () => {
    const f = await setup();
    const c = await capturedCheckout(f);
    const registry = JSON.stringify({ version: 1, repositoryId: 'R_exact', reservations: [{ publicationBranch: c.owner.branch,
      owner: { ...c.owner, key: 'different-immutable-key' } }] });
    await write(path.join(f.source, 'bot-worktrees/repository.publications.json'), registry);
    await expect(migrateAccounts({ ...f.options, trustedBotWorktrees: [c.mapping] })).rejects.toMatchObject({ code: 'migration_bots_conflict' });
    expect(f.aclCalls.filter((call) => call.command.endsWith('/setfacl'))).toEqual([]);
    expect(await fs.readFile(c.file, 'utf8')).toBe(c.text);
    expect(await fs.readFile(path.join(f.source, 'bot-worktrees/repository.publications.json'), 'utf8')).toBe(registry);
  });

  it('refuses a removed historical owner without an explicit trusted mapping rather than inventing identity', async () => {
    const f = await setup();
    const c = await capturedCheckout(f, { state: 'removed' });
    await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_path_authority_required' });
    expect(f.aclCalls).toEqual([]);
    expect(await fs.readFile(c.file, 'utf8')).toBe(c.text);
  });

  it('retains a partial ACL failure in the root journal without publishing a usable owner mapping', async () => {
    const f = await setup();
    const c = await capturedCheckout(f);
    const run = f.system.runResult;
    f.system.runResult = (command, args) => command.endsWith('/setfacl') ? { code: 1, stdout: '', stderr: 'fixture refusal' } : run(command, args);
    await expect(migrateAccounts({ ...f.options, trustedBotWorktrees: [c.mapping] })).rejects.toMatchObject({ code: 'migration_bots_access_refused' });
    const manifest = JSON.parse(await fs.readFile(path.join(f.root, FRONT.home, 'migration.json'), 'utf8'));
    expect(manifest.botWorktreeAccess.status).toBe('partial');
    expect(await fs.lstat(path.join(f.front, 'bots/migration-paths.json')).catch(() => null)).toBeNull();
    expect(await fs.lstat(path.join(f.agent, 'bot-worktrees/item.json')).catch(() => null)).toBeNull();
    expect(await fs.readFile(c.file, 'utf8')).toBe(c.text);
  });
});
