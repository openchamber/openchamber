import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT, fakeSystem, FRONT, hostRoot, OWNER } from './fake-system.js';
import { classify, migrateAccounts, oldDataDirectory, ownTree } from './migrate-accounts.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
const setup = async () => {
  const root = await hostRoot(cleanups);
  const system = fakeSystem(root);
  // The fixtures belong to whoever runs the test, as the human's data belongs to the human.
  const accounts = { human: { ...OWNER, uid: process.getuid() }, front: FRONT, agent: AGENT };
  const envFile = path.join(root, 'etc/openchamber/openchamber.env');
  const source = path.join(root, OWNER.home, '.config/openchamber');
  const options = { root, system, accounts, envFile };
  return { root, system, source, options, front: path.join(root, FRONT.home, '.config/openchamber'), agent: path.join(root, AGENT.home, '.config/openchamber') };
};

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
});
