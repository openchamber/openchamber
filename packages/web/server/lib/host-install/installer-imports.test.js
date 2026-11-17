import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

// `scripts/install.sh` runs main.js from the unpacked release, before npm installed anything: every
// module it loads statically must need Node alone. A root command may still import a package
// dynamically, since those run from the installed tree.
const installerGraph = () => {
  const seen = new Set();
  const packages = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('.')) walk(path.resolve(path.dirname(file), specifier));
      else if (!specifier.startsWith('node:') && !builtinModules.includes(specifier)) packages.push(`${specifier} <- ${path.basename(file)}`);
    }
  };
  walk(fileURLToPath(new URL('./main.js', import.meta.url)));
  return { seen, packages };
};

it('loads only Node built-ins and its own files from the unpacked package', () => {
  const { seen, packages } = installerGraph();
  expect(seen.size).toBeGreaterThan(10);
  expect(packages).toEqual([]);
});

const scratch = [];
afterEach(async () => { for (const directory of scratch.splice(0)) await fs.promises.rm(directory, { recursive: true, force: true }); });

it.each([true, false])('runs explicit mapping input and mixed legacy queue migration without installed dependencies, dryRun=%s', async (dryRun) => {
  const directory = await fs.promises.mkdtemp('/tmp/opencode/installer-bootstrap-');
  scratch.push(directory);
  const unpacked = path.join(directory, 'package/server');
  const originalServer = fileURLToPath(new URL('../../', import.meta.url));
  const write = async (file, value) => { await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, value); };
  await write(path.join(directory, 'package/package.json'), '{"type":"module"}');
  for (const file of installerGraph().seen) {
    await write(path.join(unpacked, path.relative(originalServer, file)), await fs.promises.readFile(file));
  }
  const root = path.join(directory, 'root');
  const source = path.join(root, 'home/human/.config/openchamber');
  const mapping = { projectId: 'p', itemId: 'item', directory: '/home/human/.config/openchamber/bot-worktrees/item', directoryIdentity: '1:2',
    gitDirectory: '/home/human/project/.git/worktrees/item', gitIdentity: '1:3' };
  await write(path.join(root, 'etc/reviewed.json'), JSON.stringify({ version: 1, entries: [mapping] }));
  await fs.promises.chmod(path.join(root, 'etc/reviewed.json'), 0o400);
  await write(path.join(source, 'bot-worktrees/item.json'), JSON.stringify({ version: 1, ...mapping, state: 'removed', projectPath: '/home/human/project',
    botId: 'b', repositoryId: 'R_exact', key: 'retained', branch: 'bot/item', baseBranch: 'main', baseSha: 'a'.repeat(40), identityId: 'identity', identityRevision: 1 }));
  const item = { id: 'item', botId: 'b', title: 'Keep', state: 'fixing', revision: 2, createdAt: 1, updatedAt: 2,
    source: { kind: 'manual', id: 'original' }, worktree: mapping.directory, sessions: { fixing: 'ses_fixed' } };
  await write(path.join(source, 'projects/p/bots.json'), JSON.stringify({ version: 1, revision: 3, items: [item] }));
  const key = createHash('sha256').update('{"itemId":"item","projectId":"p"}').digest('hex');
  await write(path.join(source, 'bots/placements', `${key}.json`), JSON.stringify({ version: 1, projectId: 'p', itemId: 'item', botId: 'b', hostDirectory: mapping.directory, isolated: false }));
  const notice = { source: 'openchamber-notice', kind: 'bot', projectId: 'p', itemId: 'item', eventId: 'pending' };
  const digest = createHash('sha256').update(JSON.stringify(['p', 'item', 'pending'])).digest('hex');
  const bot = { id: `queued-bot-${digest}`, messageId: `msg_${digest}`, createdAt: 2, content: 'Bot', text: 'Captured Bot text',
    origin: { kind: 'bot', id: 'item' }, notice, sendConfig: {}, attachments: [], context: [] };
  const ordinary = { id: 'queued-human', createdAt: 1, content: 'User', text: 'Captured user text', sendConfig: { providerID: 'provider', modelID: 'model' } };
  const queue = JSON.stringify({ version: 1, revision: 77, sessions: { ses_fixed: { directory: mapping.directory, items: [ordinary, bot] } } });
  await write(path.join(source, 'message-queue.json'), queue);
  const driver = `
    import { cli } from ${JSON.stringify(path.join(unpacked, 'lib/host-install/main.js'))};
    import { migrateAccounts } from ${JSON.stringify(path.join(unpacked, 'lib/host-install/migrate-accounts.js'))};
    import { readTrustedBotWorktrees } from ${JSON.stringify(path.join(unpacked, 'lib/host-install/bot-migration-access.js'))};
    const root = ${JSON.stringify(root)};
    const accounts = { human: { name: 'human', uid: process.getuid(), gid: process.getgid(), home: '/home/human' },
      front: { uid: 2345, gid: 2345 }, agent: { uid: 3456, gid: 3456, home: '/home/agent' } };
    const system = { isActive: async () => 'inactive', chown: async () => {} };
    process.exitCode = await cli(['install', '--json', '--bot-worktrees-file', '/etc/reviewed.json', ${dryRun ? "'--dry-run'" : ''}], {
      commands: { install: async ({ botWorktreesFile, dryRun }) => ({ migration: await migrateAccounts({ root, accounts, system, dryRun,
        envFile: root + '/etc/old.env', trustedBotWorktrees: await readTrustedBotWorktrees({ root, file: botWorktreesFile,
          readIdentity: async (handle) => Object.assign(await handle.stat({ bigint: true }), { uid: 0n }) }) }) }) }
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { encoding: 'utf8', cwd: directory, timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: directory } });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).migration.botWorktrees).toEqual([mapping]);
  expect(await fs.promises.readFile(path.join(source, 'message-queue.json'), 'utf8')).toBe(queue);
  const ownerData = path.join(root, 'var/lib/openchamber/.config/openchamber');
  if (dryRun) expect(fs.existsSync(ownerData)).toBe(false);
  else {
    expect(JSON.parse(await fs.promises.readFile(path.join(ownerData, 'bots/host-queues/ses_fixed/message-queue.json'), 'utf8')))
      .toEqual({ version: 1, revision: 77, sessions: { ses_fixed: { directory: mapping.directory, items: [bot] } } });
    expect(JSON.parse(await fs.promises.readFile(path.join(root, 'home/agent/.config/openchamber/message-queue.json'), 'utf8')).sessions.ses_fixed.items).toEqual([ordinary]);
  }
});
