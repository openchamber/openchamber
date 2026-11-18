import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createBotPlacement } from './placement.js';
import { createBotExecutionStore } from './execution-store.js';
import { createBotStore } from './store.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const dataDir = await fs.mkdtemp('/tmp/opencode/bot-placement-');
  roots.push(dataDir);
  const store = createBotStore({ projectsDirPath: path.join(dataDir, 'projects') });
  const journal = createBotExecutionStore({ store });
  let binding = null;
  const create = () => createBotPlacement({ dataDir, journal, isolated: { readBinding: async () => binding } });
  return { journal, create, bind: (value) => { binding = value; } };
};
const request = (isolated) => ({ projectId: 'project', itemId: 'item', directory: '/owned/checkout', bot: { id: 'bot', isolated } });
const run = (isolated) => ({ ...request(isolated), stage: 'investigation', dispatchedAt: 1 });

it.each([false, true])('keeps initial isolation=%s through config toggles and a fresh owner', async (isolated) => {
  const f = await fixture();
  const initial = await f.create().resolve(request(isolated));
  expect(initial.isolated).toBe(isolated);
  expect(await f.create().resolve(request(!isolated))).toEqual(initial);
});

it.each([false, true])('migrates captured isolation=%s independently of current config', async (isolated) => {
  const f = await fixture();
  await f.journal.update('project', 'item', (entry) => ({ ...entry, data: { runs: { 'investigation:0': run(isolated) } } }));
  expect((await f.create().resolve(request(!isolated))).isolated).toBe(isolated);
});

it('uses the first stage snapshot when later stage config differs', async () => {
  const f = await fixture();
  await f.journal.update('project', 'item', (entry) => ({ ...entry, data: { runs: {
    'fixing:0': { ...run(true), stage: 'fixing', dispatchedAt: 2 }, 'investigation:0': run(false),
  } } }));
  expect((await f.create().resolve(request(true))).isolated).toBe(false);
});

it('preserves a recorded isolated binding without a stage journal and refuses conflicting host history', async () => {
  const f = await fixture();
  f.bind({ botId: 'bot', hostDirectory: '/owned/checkout', sessions: {} });
  expect((await f.create().resolve(request(false))).isolated).toBe(true);
  await f.journal.update('project', 'conflict', (entry) => ({ ...entry, data: { runs: {
    'investigation:0': { ...run(false), itemId: 'conflict' },
  } } }));
  await expect(f.create().resolve({ ...request(false), itemId: 'conflict' })).rejects.toMatchObject({ code: 'BOT_PLACEMENT_MISMATCH' });
});

it('refuses reuse of an item placement for another bot or checkout', async () => {
  const f = await fixture();
  await f.create().resolve(request(false));
  await expect(f.create().resolve({ ...request(false), directory: '/another' })).rejects.toMatchObject({ code: 'BOT_PLACEMENT_MISMATCH' });
  await expect(f.create().resolve({ ...request(false), bot: { id: 'another', isolated: false } })).rejects.toMatchObject({ code: 'BOT_PLACEMENT_MISMATCH' });
});

it('refuses to place an existing session without captured execution history', async () => {
  const f = await fixture();
  await expect(f.create().resolve({ ...request(true), sessions: { fixing: 'ses_unknown' } })).rejects.toMatchObject({ code: 'BOT_PLACEMENT_MISMATCH' });
  await expect(f.create().resolve({ ...request(false), sessionId: 'ses_unknown' })).rejects.toMatchObject({ code: 'BOT_PLACEMENT_MISMATCH' });
});

it('recovers a discovery session from its own persisted run snapshot', async () => {
  const f = await fixture();
  const capturedRun = { ...run(false), itemId: 'discovery_1', sessionId: 'ses_discovery' };
  expect((await f.create().resolve({ ...request(true), itemId: 'discovery_1', sessionId: 'ses_discovery', capturedRun })).isolated).toBe(false);
});

it('projects only matching isolated session directories from the host-owned binding', async () => {
  const f = await fixture();
  const directory = '/spaces/123456abcdef/repo';
  f.bind({ botId: 'bot', hostDirectory: '/owned/checkout', directory,
    sessions: { first: { id: 'ses_isolated', stage: 'investigation', directory },
      wrong: { id: 'ses_other', stage: 'judge', directory } } });
  const input = { projectId: 'project',
    item: { id: 'item', botId: 'bot', worktree: '/owned/checkout', sessions: { investigation: 'ses_isolated', fixing: 'ses_other' } } };
  expect(await f.create().sessionDirectories(input)).toEqual({ ses_isolated: directory });
});

it('projects the captured host directory even after isolation is enabled', async () => {
  const f = await fixture();
  await f.create().resolve(request(false));
  expect(await f.create().sessionDirectories({ projectId: 'project',
    item: { id: 'item', botId: 'bot', worktree: '/owned/checkout', sessions: { fixing: 'ses_host' } } })).toEqual({ ses_host: '/owned/checkout' });
});

it('grants no old-container address when a removed space has no retained archive entry', async () => {
  const f = await fixture();
  const directory = '/spaces/123456abcdef/repo';
  f.bind({ botId: 'bot', hostDirectory: '/owned/checkout', state: 'removed', spaceId: '123456abcdef', directory,
    sessions: { fixing: { id: 'ses_removed', stage: 'fixing', directory } } });
  expect(await f.create().sessionDirectories({ projectId: 'project', item: { id: 'item', botId: 'bot',
    worktree: '/owned/checkout', sessions: { fixing: 'ses_removed' } } })).toEqual({});
});
