import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { AGENT, fakeSystem, FRONT, hostRoot, OWNER } from './fake-system.js';
import { migrateAccounts } from './migrate-accounts.js';
import { createBotItem } from '../bots/schema.js';
import { botNoticeIds } from '../message-queue/bot-notice.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const setup = async () => {
  const root = await hostRoot(cleanups);
  const system = fakeSystem(root);
  system.isActive = async () => 'inactive';
  const source = path.join(root, OWNER.home, '.config/openchamber');
  const front = path.join(root, FRONT.home, '.config/openchamber');
  const agent = path.join(root, AGENT.home, '.config/openchamber');
  const item = createBotItem({ id: 'item', botId: 'b', source: { kind: 'manual', id: 'original' }, title: 'Work', now: 1 });
  Object.assign(item, { worktree: '/retained/checkout', state: 'fixing', sessions: { fixing: 'ses_fixed' } });
  const execution = { version: 1, operations: {}, data: {
    runs: { 'fixing:0': { projectId: 'p', itemId: 'item', stage: 'fixing', directory: item.worktree, dispatchedAt: 1, bot: { id: 'b', isolated: false } } },
    delivered: { 'event-1': true },
  } };
  const journal = path.join(source, 'projects/p/bot-executions', `${createHash('sha256').update('item').digest('hex')}.json`);
  await write(journal, JSON.stringify(execution));
  await write(path.join(source, 'projects/p/bots.json'), JSON.stringify({ version: 1, revision: 21, items: [item] }));
  const placementFile = path.join(source, 'bots/placements', `${digestMutationInput({ projectId: 'p', itemId: 'item' })}.json`);
  const placement = { version: 1, projectId: 'p', itemId: 'item', botId: 'b', hostDirectory: item.worktree, isolated: false };
  await write(placementFile, JSON.stringify(placement));
  const notice = { source: 'openchamber-notice', kind: 'bot', projectId: 'p', itemId: 'item', eventId: 'event-1' };
  const ids = botNoticeIds(notice);
  const pending = { id: ids.itemId, messageId: ids.messageId, createdAt: 42, content: 'Original display', text: 'Original delivery\n',
    attachments: [], context: [], sendConfig: {}, origin: { kind: 'bot', id: 'item' }, notice, futurePayload: { retained: [1, 2] } };
  const ordinary = { id: 'queued-human', createdAt: 40, content: 'User', text: 'Expanded user', sendConfig: { providerID: 'test', modelID: 'model' },
    attachments: [{ id: 'attachment', filename: 'file.txt', mimeType: 'text/plain', size: 3, source: 'local', dataUrl: 'data:text/plain;base64,YWJj', agentPath: '/original/file.txt' }],
    context: [{ kind: 'context', text: 'Captured context', metadata: { original: { exact: true } } }], unknown: ['keep'] };
  const stored = { version: 1, revision: 93, sessions: {
    ses_fixed: { directory: item.worktree, items: [ordinary, pending] },
    ses_user: { directory: '/user/project', items: [{ ...ordinary, id: 'queued-other' }] },
  } };
  const queueFile = path.join(source, 'message-queue.json');
  const ownerQueue = path.join(front, 'bots/host-queues/ses_fixed/message-queue.json');
  const options = { root, system, envFile: path.join(root, 'etc/openchamber/openchamber.env'),
    accounts: { human: { ...OWNER, uid: process.getuid() }, front: FRONT, agent: AGENT } };
  const save = () => write(queueFile, ` ${JSON.stringify(stored)}\n`);
  await save();
  return { root, system, source, front, agent, options, stored, pending, ordinary, queueFile, ownerQueue, item, execution, journal, placement, placementFile, save };
};

it('moves pending host Bot notices despite an existing enqueue receipt, retaining exact payloads and queue revision', async () => {
  const f = await setup();
  const sourceBytes = await fs.readFile(f.queueFile, 'utf8');
  const journalBytes = await fs.readFile(f.journal, 'utf8');
  await migrateAccounts(f.options);
  expect(await json(f.ownerQueue)).toEqual({ version: 1, revision: 93, sessions: { ses_fixed: { directory: f.item.worktree, items: [f.pending] } } });
  expect(await json(path.join(f.agent, 'message-queue.json'))).toEqual({ ...f.stored, sessions: { ...f.stored.sessions,
    ses_fixed: { directory: f.item.worktree, items: [f.ordinary] } } });
  expect(await fs.readFile(f.queueFile, 'utf8')).toBe(sourceBytes);
  expect(await fs.readFile(path.join(f.front, path.relative(f.source, f.journal)), 'utf8')).toBe(journalBytes);
  const ownerBytes = await fs.readFile(f.ownerQueue, 'utf8');
  await migrateAccounts(f.options);
  expect(await fs.readFile(f.ownerQueue, 'utf8')).toBe(ownerBytes);
});

it('plans both queue destinations without writing a dry run', async () => {
  const f = await setup();
  const result = await migrateAccounts({ ...f.options, dryRun: true });
  expect(result.files).toContainEqual(expect.objectContaining({ target: f.ownerQueue, status: 'planned', class: 'front-door' }));
  expect(await fs.lstat(f.front).catch(() => null)).toBeNull();
  expect(await fs.lstat(f.agent).catch(() => null)).toBeNull();
  expect(f.system.calls).toEqual([]);
});

it.each(['owner', 'agent', 'linked-owner'])('checks a conflicting %s destination before creating either queue and leaves retries untouched', async (kind) => {
  const f = await setup();
  const target = kind === 'agent' ? path.join(f.agent, 'message-queue.json') : f.ownerQueue;
  const kept = JSON.stringify({ version: 1, revision: 101, sessions: {} });
  if (kind === 'linked-owner') {
    await write(path.join(f.root, 'kept-queue'), kept);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(path.join(f.root, 'kept-queue'), target);
  } else await write(target, kept);
  await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_blocked' });
  expect(await fs.readFile(target, 'utf8')).toBe(kept);
  const other = kind === 'agent' ? f.ownerQueue : path.join(f.agent, 'message-queue.json');
  expect(await fs.lstat(other).catch(() => null)).toBeNull();
  expect(await fs.readFile(path.join(f.front, 'projects/p.json.bots-migration-blocked'), 'utf8')).toContain('migration_bots_conflict');
  await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_blocked' });
  expect(await fs.readFile(target, 'utf8')).toBe(kept);
});

it.each(['duplicate', 'duplicate-other-session', 'wrong-message-id', 'malformed-item', 'malformed-json', 'bad-revision', 'wrong-session', 'wrong-bot', 'wrong-directory', 'isolated-placement', 'isolated-run', 'missing-authority'])('blocks %s without losing source bytes or publishing queues', async (kind) => {
  const f = await setup();
  if (kind === 'duplicate') f.stored.sessions.ses_fixed.items.push(f.pending);
  if (kind === 'duplicate-other-session') f.stored.sessions.ses_user.items.push(f.pending);
  if (kind === 'wrong-message-id') f.pending.messageId = `msg_${'b'.repeat(64)}`;
  if (kind === 'malformed-item') f.pending.notice.eventId = '';
  if (kind === 'bad-revision') f.stored.revision = -1;
  if (kind === 'wrong-session') f.item.sessions.fixing = 'ses_other';
  if (kind === 'wrong-bot') f.item.botId = 'foreign';
  if (kind === 'wrong-directory') f.stored.sessions.ses_fixed.directory = '/foreign';
  if (kind === 'isolated-placement') f.placement.isolated = true;
  if (kind === 'isolated-run') f.execution.data.runs['fixing:0'].bot.isolated = true;
  await write(path.join(f.source, 'projects/p/bots.json'), JSON.stringify({ version: 1, revision: 21, items: [f.item] }));
  await write(f.journal, JSON.stringify(f.execution));
  await write(f.placementFile, JSON.stringify(f.placement));
  if (kind === 'missing-authority') { await fs.unlink(f.placementFile); await fs.unlink(f.journal); }
  await f.save();
  if (kind === 'malformed-json') await write(f.queueFile, '{broken');
  const before = await fs.readFile(f.queueFile, 'utf8');
  await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_blocked' });
  expect(await fs.readFile(f.queueFile, 'utf8')).toBe(before);
  expect(await fs.lstat(f.ownerQueue).catch(() => null)).toBeNull();
  expect(await fs.lstat(path.join(f.agent, 'message-queue.json')).catch(() => null)).toBeNull();
  expect(await fs.lstat(path.join(f.front, 'projects/p.json.bots-migration-blocked'))).toBeTruthy();
});

it('accepts captured host execution history when placement has not been materialized', async () => {
  const f = await setup();
  await fs.unlink(f.placementFile);
  await migrateAccounts(f.options);
  expect((await json(f.ownerQueue)).sessions.ses_fixed.items).toEqual([f.pending]);
});

it('refuses a destination changed after a completed migration without overwriting either queue', async () => {
  const f = await setup();
  await migrateAccounts(f.options);
  const agentBytes = await fs.readFile(path.join(f.agent, 'message-queue.json'), 'utf8');
  const sourceBytes = await fs.readFile(f.queueFile, 'utf8');
  const altered = { ...await json(f.ownerQueue), revision: 94 };
  const kept = JSON.stringify(altered);
  await fs.writeFile(f.ownerQueue, kept);
  await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_blocked' });
  expect(await fs.readFile(f.ownerQueue, 'utf8')).toBe(kept);
  expect(await fs.readFile(path.join(f.agent, 'message-queue.json'), 'utf8')).toBe(agentBytes);
  expect(await fs.readFile(f.queueFile, 'utf8')).toBe(sourceBytes);
});

it('blocks duplicate retained session owners while copying unrelated complete projects', async () => {
  const f = await setup();
  await write(path.join(f.source, 'projects/p/bots.json'), JSON.stringify({ version: 1, revision: 21, items: [f.item, { ...f.item, id: 'other' }] }));
  await write(path.join(f.source, 'projects/good.json'), '{"version":1,"bots":{},"scheduledTasks":[]}');
  await expect(migrateAccounts(f.options)).rejects.toMatchObject({ code: 'migration_bots_blocked' });
  expect(await json(path.join(f.front, 'projects/good.json'))).toEqual({ version: 1, bots: {}, scheduledTasks: [] });
  const manifest = await json(path.join(f.root, FRONT.home, 'migration.json'));
  expect(manifest.blockedProjects.map((entry) => entry.stem)).toEqual(['p']);
  expect(await fs.lstat(f.ownerQueue).catch(() => null)).toBeNull();
});
