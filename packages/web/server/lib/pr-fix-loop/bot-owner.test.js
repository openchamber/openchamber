import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFixLoopRuntime } from './runtime.js';

const roots = [];
const runtimes = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const authority = { project: { id: 'p', path: '/project' }, botId: 'b', itemId: 'item', identityId: 'identity', identityRevision: 7,
  target: { repositoryId: 'R_1', owner: 'acme', repo: 'app' } };
const input = { sessionId: 'ses_a', directory: '/checkout', owner: 'acme', repo: 'app', number: 3, branch: 'bot/item' };
async function fixture(options = {}) {
  const dataDir = await fs.mkdtemp('/tmp/opencode/bot-owner-watch-'); roots.push(dataDir);
  const timers = [];
  const deps = { dataDir, approvalOnly: true,
    botWatch: { getOctokit: vi.fn(), deliver: vi.fn(), authorizeApp: vi.fn() },
    assertBotWatchAvailable: vi.fn(async () => {}),
    setTimer: (fn) => { const timer = { fn, unref() {} }; timers.push(timer); return timer; }, clearTimer: vi.fn(),
    log: { warn() {} }, ...options };
  const make = (extra) => { const runtime = createFixLoopRuntime({ ...deps, ...extra }); runtimes.push(runtime); return runtime; };
  return { dataDir, file: path.join(dataDir, 'pr-fix-loops.json'), timers, deps, make, runtime: make() };
}

it('accepts private auto Bot watches in the approval owner and reloads the exact persisted authority', async () => {
  const f = await fixture();
  const loop = await f.runtime.createBotWatch(input, authority);
  expect(loop.config.pushMode).toBe('auto');
  expect(loop).not.toHaveProperty('botAuthority');
  expect(f.deps.assertBotWatchAvailable).toHaveBeenCalledWith(expect.objectContaining({ id: loop.id }), authority);
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8'));
  expect(stored.loops[0].botAuthority).toEqual(authority);
  await f.runtime.stop();
  const restarted = f.make();
  await restarted.start();
  expect((await restarted.list())[0].id).toBe(loop.id);
  expect(JSON.parse(await fs.readFile(f.file, 'utf8')).loops[0].botAuthority).toEqual(authority);
  expect(f.timers).toHaveLength(2);
});

it('refuses public forged authority and private watches without cross-runtime admission', async () => {
  const f = await fixture();
  await expect(f.runtime.create({ ...input, botAuthority: authority, config: { pushMode: 'auto' } })).rejects.toThrow('only on the agent');
  await expect(f.make({ assertBotWatchAvailable: null }).createBotWatch(input, authority)).rejects.toThrow('admission is unavailable');
  expect(await fs.readdir(f.dataDir)).toEqual([]);
});

it('cross-runtime conflicts refuse Bot admission before its first durable save', async () => {
  const f = await fixture({ assertBotWatchAvailable: async () => { throw Object.assign(new Error('PR held by agent'), { code: 'fix_loop_automation_conflict' }); } });
  await expect(f.runtime.createBotWatch(input, authority)).rejects.toMatchObject({ code: 'fix_loop_automation_conflict' });
  expect(await f.runtime.list()).toEqual([]);
  expect(await fs.readdir(f.dataDir)).toEqual([]);
});

it('a cross-runtime conflict found by a running Bot watch preserves its history and blocks provider reads', async () => {
  const f = await fixture();
  const created = await f.runtime.createBotWatch(input, authority);
  f.deps.assertBotWatchAvailable.mockRejectedValueOnce(new Error('PR held by agent'));
  await f.timers[0].fn();
  const loop = (await f.runtime.list())[0];
  expect(loop.id).toBe(created.id);
  expect(loop.lastError).toContain('PR held by agent');
  expect(f.deps.botWatch.getOctokit).not.toHaveBeenCalled();
  expect(JSON.parse(await fs.readFile(f.file, 'utf8')).loops[0].botAuthority).toEqual(authority);
});

it('agent excludes loaded Bot watches, refuses manual reattachment and retains their bytes as records on ordinary saves', async () => {
  const f = await fixture();
  await f.runtime.createBotWatch(input, authority);
  await f.runtime.stop();
  const botRecord = JSON.parse(await fs.readFile(f.file, 'utf8')).loops[0];
  const agent = f.make({ approvalOnly: false, excludeBotWatches: true });
  await agent.start();
  expect(await agent.list()).toEqual([]);
  expect(agent.ownershipClaims()).toEqual([]);
  await expect(agent.createBotWatch(input, authority)).rejects.toThrow('only on the owner');
  await agent.create({ ...input, number: 4, config: { pushMode: 'auto' } });
  expect(JSON.parse(await fs.readFile(f.file, 'utf8')).loops.find((loop) => loop.id === botRecord.id)).toEqual(botRecord);
});

it('malformed or target-mismatched persisted Bot authority blocks owner loading', async () => {
  const f = await fixture();
  await f.runtime.createBotWatch(input, authority);
  await f.runtime.stop();
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8'));
  stored.loops[0].botAuthority.identityRevision = 0;
  const text = JSON.stringify(stored); await fs.writeFile(f.file, text);
  await expect(f.make().load()).rejects.toThrow();
  expect(await fs.readFile(f.file, 'utf8')).toBe(text);
  stored.loops[0].botAuthority.identityRevision = 7;
  stored.loops[0].branch = 'some-other-branch'; await fs.writeFile(f.file, JSON.stringify(stored));
  await expect(f.make().load()).rejects.toThrow('Invalid bot PR watch target');
});
