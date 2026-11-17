import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { readTrustedBotWorktrees } from './bot-migration-access.js';
import { fakeSystem, FRONT, hostRoot, installOptions, OWNER } from './fake-system.js';
import { install, layout } from './host.js';
import { cli } from './main.js';
import * as migration from './migrate-accounts.js';

const cleanups = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const write = async (file, text) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.chmod(file, 0o600).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await fs.writeFile(file, text);
  if (file.endsWith('reviewed-bot-paths.json')) await fs.chmod(file, 0o400);
};
// Model root-owned metadata without chown, retaining real opened-file type, mode and identity checks.
const rootIdentity = async (handle) => Object.assign(await handle.stat({ bigint: true }), { uid: 0n });
const mapping = { projectId: 'p', itemId: 'removed', directory: '/home/alice/.config/openchamber/bot-worktrees/removed',
  directoryIdentity: '1:2', gitDirectory: '/home/alice/project/.git/worktrees/removed', gitIdentity: '1:3' };
const setup = async () => {
  const root = await hostRoot(cleanups);
  const file = '/etc/openchamber/reviewed-bot-paths.json';
  await write(path.join(root, file), JSON.stringify({ version: 1, entries: [mapping] }));
  await fs.chmod(path.join(root, file), 0o400);
  const descriptor = { version: 1, ...mapping, projectPath: '/home/alice/project', botId: 'b', repositoryId: 'R_exact', key: 'captured',
    branch: 'bot/removed', baseBranch: 'main', baseSha: 'a'.repeat(40), identityId: 'identity', identityRevision: 1, state: 'removed' };
  const source = path.join(root, OWNER.home, '.config/openchamber/bot-worktrees/removed.json');
  await write(source, JSON.stringify(descriptor));
  const system = fakeSystem(root);
  const migrate = migration.migrateAccounts;
  vi.spyOn(migration, 'migrateAccounts').mockImplementation((options) => migrate({ ...options,
    accounts: { ...options.accounts, human: { ...options.accounts.human, uid: process.getuid() } } }));
  system.isActive = async () => 'inactive';
  return { root, file, source, system, readIdentity: rootIdentity };
};

it.each([{ mode: [] }, { mode: ['--quiet'] }, { mode: ['--json'] }])('forwards the mapping in non-interactive CLI mode $mode and reports missing values', async ({ mode }) => {
  let received;
  const messages = [];
  const out = { write: (text) => messages.push(text) };
  const commands = { install: async (options) => { received = options; return { dryRun: options.dryRun }; } };
  expect(await cli(['install', '--bot-worktrees-file', '/etc/reviewed file.json', '--dry-run', ...mode], { out, err: out, commands })).toBe(0);
  expect(received).toMatchObject({ botWorktreesFile: '/etc/reviewed file.json', dryRun: true });
  messages.length = 0;
  expect(await cli(['install', '--bot-worktrees-file', ...mode], { out, err: out, commands })).toBe(64);
  if (mode.includes('--json')) expect(JSON.parse(messages.join(''))).toMatchObject({ ok: false, code: 'usage' });
  else expect(messages.join('')).toContain('Unknown option --bot-worktrees-file');
});

it.each([false, true])('forwards the explicit mapping from CLI to the real install orchestration with dryRun=%s', async (dryRun) => {
  const f = await setup();
  const chunks = [];
  const out = { write: (text) => chunks.push(text) };
  const code = await cli(['install', '--owner', 'alice', '--repo', 'fixture/repo', '--tarball', '/fixture/openchamber-web-2.6.0.tgz', '--version', '2.6.0',
    '--separation', '--bot-worktrees-file', f.file, '--json', ...(dryRun ? ['--dry-run'] : [])], {
    out, err: out,
    commands: { install: (options) => install({ ...installOptions(f.root, f.system), ...options,
      readUiPassword: async () => 'fixture password', readBotWorktreesIdentity: rootIdentity }) },
  });
  expect(code, chunks.join('')).toBe(0);
  const result = JSON.parse(chunks.join(''));
  expect(result.migration.botWorktrees).toEqual([mapping]);
  if (dryRun) {
    expect(f.system.calls).toEqual([]);
    expect(await fs.lstat(path.join(f.root, FRONT.home)).catch(() => null)).toBeNull();
  } else {
    expect(JSON.parse(await fs.readFile(path.join(f.root, FRONT.home, '.config/openchamber/bots/migration-paths.json'), 'utf8'))).toEqual({ version: 1, entries: [mapping] });
  }
  expect(JSON.parse(await fs.readFile(f.source, 'utf8')).state).toBe('removed');
});

it.each(['missing-option', 'missing-file', 'bad-json', 'wrong-version', 'extra-field', 'foreign-file', 'foreign-parent', 'foreign-mapping', 'file-link', 'parent-link', 'hard-link', 'writable-file', 'writable-parent', 'duplicate'])('fails closed for %s in install and dry-run', async (kind) => {
  const f = await setup();
  const physical = path.join(f.root, f.file);
  let file = f.file;
  if (kind === 'missing-option') file = undefined;
  if (kind === 'missing-file') file = '/etc/openchamber/absent.json';
  if (kind === 'bad-json') await write(physical, '{broken');
  if (kind === 'wrong-version') await write(physical, JSON.stringify({ version: 2, entries: [mapping] }));
  if (kind === 'extra-field') await write(physical, JSON.stringify({ version: 1, entries: [mapping], trustAgentSnapshot: true }));
  if (kind === 'foreign-mapping') await write(physical, JSON.stringify({ version: 1, entries: [{ ...mapping, projectId: 'foreign' }] }));
  if (kind === 'duplicate') await write(physical, JSON.stringify({ version: 1, entries: [mapping, mapping] }));
  if (kind === 'file-link') { await fs.rename(physical, `${physical}.kept`); await fs.symlink(`${physical}.kept`, physical); }
  if (kind === 'parent-link') { await fs.rename(path.dirname(physical), `${path.dirname(physical)}.kept`); await fs.symlink(`${path.dirname(physical)}.kept`, path.dirname(physical)); }
  if (kind === 'hard-link') await fs.link(physical, `${physical}.alias`);
  if (kind === 'writable-file') await fs.chmod(physical, 0o600);
  if (kind === 'writable-parent') await fs.chmod(path.dirname(physical), 0o777);
  const identity = async (handle) => {
    const stat = await rootIdentity(handle);
    if (kind === 'foreign-file' && stat.isFile() || kind === 'foreign-parent' && stat.isDirectory()) stat.uid = 1234n;
    return stat;
  };
  const before = await fs.readFile(f.source, 'utf8');
  for (const dryRun of [true, false]) {
    await expect(install(installOptions(f.root, f.system, { separation: true, dryRun, botWorktreesFile: file,
      readBotWorktreesIdentity: identity }))).rejects.toMatchObject({ code: 'migration_bots_path_authority_required' });
    expect(await fs.readFile(f.source, 'utf8')).toBe(before);
    expect(await fs.lstat(path.join(f.root, FRONT.home, '.config/openchamber/bots/migration-paths.json')).catch(() => null)).toBeNull();
  }
});

it('refuses a reviewed file whose opened identity changes during its read', async () => {
  const f = await setup();
  let reads = 0;
  const readIdentity = async (handle) => {
    const stat = await rootIdentity(handle);
    if (stat.isFile() && ++reads === 3) stat.ino += 1n;
    return stat;
  };
  await expect(readTrustedBotWorktrees({ root: f.root, file: f.file, readIdentity })).rejects.toMatchObject({ code: 'migration_bots_path_authority_required' });
});

it('plans a live retained checkout before the agent account exists without granting ACLs', async () => {
  const f = await setup();
  const captured = { ...mapping };
  for (const [location, key] of [[captured.directory, 'directoryIdentity'], [captured.gitDirectory, 'gitIdentity']]) {
    await fs.mkdir(path.join(f.root, location), { recursive: true });
    const stat = await fs.stat(path.join(f.root, location), { bigint: true });
    captured[key] = `${stat.dev}:${stat.ino}`;
  }
  await write(path.join(f.root, f.file), JSON.stringify({ version: 1, entries: [captured] }));
  await write(f.source, JSON.stringify({ ...JSON.parse(await fs.readFile(f.source, 'utf8')), ...captured, state: 'ready' }));
  const commands = [];
  f.system.runResult = async (command) => {
    commands.push(command);
    return { code: 0, stdout: 'user::rwx\ngroup::r-x\nother::r-x\n', stderr: '' };
  };
  const result = await install(installOptions(f.root, f.system, { separation: true, dryRun: true, botWorktreesFile: f.file, readBotWorktreesIdentity: rootIdentity }));
  expect(result.migration.botWorktrees).toEqual([captured]);
  expect(result.migration.botWorktreeAccess).toMatchObject({ status: 'planned', changed: [] });
  expect(commands).toContain('/usr/bin/getfacl');
  expect(commands).not.toContain('/usr/bin/setfacl');
  expect(f.system.calls).toEqual([]);
});

it('requires root-owned metadata by default and exact mapping fields', async () => {
  const f = await setup();
  if (process.getuid() !== 0) await expect(readTrustedBotWorktrees({ root: f.root, file: f.file })).rejects.toMatchObject({ code: 'migration_bots_path_authority_required' });
  expect(await readTrustedBotWorktrees({ root: f.root, file: f.file, readIdentity: rootIdentity })).toEqual([mapping]);
  for (const bad of [{ ...mapping, future: true }, { ...mapping, directory: '/home/alice/../foreign' }, { ...mapping, gitIdentity: 'invalid' }]) {
    await write(path.join(f.root, f.file), JSON.stringify({ version: 1, entries: [bad] }));
    await expect(readTrustedBotWorktrees({ root: f.root, file: f.file, readIdentity: rootIdentity })).rejects.toMatchObject({ code: 'migration_bots_path_authority_required' });
  }
});

it.each([false, true])('preserves the mapping filename through install.sh --host with dryRun=%s without remote or privileged operations', async (dryRun) => {
  const f = await setup();
  const workdir = path.join(f.root, 'bootstrap');
  const captured = path.join(f.root, 'forwarded.json');
  await write(path.join(workdir, 'package/server/lib/host-install/main.js'), 'import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));');
  const script = fileURLToPath(new URL('../../../../../scripts/install.sh', import.meta.url));
  const digest = 'a'.repeat(64);
  const program = [
    '. "$1"',
    'uname() { printf "Linux\\n"; }',
    'id() { printf "0\\n"; }',
    'protected_mcp_node() { printf "%s\\n" "$NODE"; }',
    'protected_mcp_trusted_path() { return 0; }',
    'protected_mcp_remove_on_exit() { :; }',
    'mktemp() { printf "%s\\n" "$WORKDIR"; }',
    'curl() { case "$*" in *" -o "*) return 0;; *) printf "%s\\n" "$RELEASE";; esac; }',
    'sha256sum() { printf "%s  package.tgz\\n" "$DIGEST"; }',
    'tar() { :; }; chown() { :; }; chmod() { :; }',
    'shift; main "$@"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', program, 'fixture', script, '--host', '--owner', 'alice', '--repo', 'fixture/repo',
    '--bot-worktrees-file', '/etc/reviewed bot paths.json', ...(dryRun ? ['--dry-run'] : [])], {
    env: { PATH: process.env.PATH, OPENCHAMBER_INSTALL_FUNCTIONS_ONLY: '1', NODE: process.execPath, WORKDIR: workdir, CAPTURE: captured, DIGEST: digest,
      RELEASE: JSON.stringify({ tag_name: 'v2.6.4', assets: [{ name: 'openchamber-web-2.6.4.tgz', digest: `sha256:${digest}`, browser_download_url: 'https://fixture.invalid/package' }] }) },
    encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  const forwarded = JSON.parse(await fs.readFile(captured, 'utf8'));
  expect(forwarded.slice(forwarded.indexOf('--bot-worktrees-file'), forwarded.indexOf('--bot-worktrees-file') + 2)).toEqual(['--bot-worktrees-file', '/etc/reviewed bot paths.json']);
  expect(forwarded.includes('--dry-run')).toBe(dryRun);
  expect(forwarded[0]).toBe('install');
});
