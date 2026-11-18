import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createBotDiscovery } from './discovery.js';
import { createBotSources } from './sources.js';
import { createBotStageSessions } from './stage-sessions.js';
import { botDefinitionSchema } from './config.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const setup = async (maxItems = 4) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-discovery-')); roots.push(dataDir);
  const bot = botDefinitionSchema.parse({ id: 'bugs', name: 'Bugs', mission: 'Find bugs', source: { kind: 'investigation', prompt: 'Inspect', maxItems },
    models: { investigation: { useDefaults: false, providerID: 'chosen', modelID: 'investigate' } } });
  const request = { project: { id: 'p', path: dataDir }, bot, occurrence: 'once', maxItems };
  const calls = []; let completed = false; let unavailable = false; let lost = false;
  const candidate = { source: { kind: 'investigation', id: 'stable-bug' }, title: 'Verified bug' };
  let output = [candidate, candidate];
  const client = { session: { update: async (value) => calls.push(['permissions', value]), interrupt: async () => {} },
    message: { list: async () => ({ data: completed ? [
      { id: 'idle_done', type: 'idle', outcome: 'succeeded', time: { created: 1 } },
      { type: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }], time: { created: 0 } },
    ] : [] }) } };
  const stages = createBotStageSessions({
    sessionService: {
      create: async (_value, options) => { calls.push(['create', options.metadata]); await options.onSessionCreated({ sessionId: 'ses_discovery', directory: dataDir }); return { sessionId: 'ses_discovery', directory: dataDir }; },
      send: async (_id, value) => {
        const files = await fs.readdir(path.join(dataDir, 'bots/discovery'));
        const record = JSON.parse(await fs.readFile(path.join(dataDir, 'bots/discovery', files.find((file) => file.endsWith('.json'))), 'utf8'));
        expect(record).toMatchObject({ state: 'dispatching', key: expect.stringMatching(/^discovery:/), run: { sessionId: 'ses_discovery' } });
        calls.push(['send', value]); if (lost) throw new Error('response lost'); return { promptDispatched: true };
      },
    }, clientFor: () => client, permissionAutoAcceptRuntime: { setSessionPolicy: async (...args) => calls.push(['mode', ...args]) },
    sessionKnowledgeRuntime: { sync: async (...args) => calls.push(['knowledge', ...args]) },
    activityProbe: { fetchActiveSessionStatuses: async () => unavailable ? null : completed ? {} : { ses_discovery: { type: 'busy' } }, hasWorkingChildren: async () => false },
    readSessionDefaults: async () => { throw new Error('should use bot selection'); }, readTokenSnapshot: async () => 7,
    isolated: Object.fromEntries(['create', 'dispatch', 'outcome', 'reconcile', 'stop'].map((name) => [name, async () => { throw new Error('not isolated'); }])),
  });
  const ready = []; const attention = [];
  const build = (options = {}) => createBotDiscovery({ dataDir, stages, onReady: async (value) => ready.push(value), onAttention: async (value) => attention.push(value), ...options });
  return { dataDir, request, calls, build, ready, attention, setOutput: (value) => { output = value; }, complete: () => { completed = true; }, failActivity: () => { unavailable = true; }, lose: () => { lost = true; } };
};

it('persists the dispatch before send, applies investigation policy and resumes without another prompt', async () => {
  const fixture = await setup();
  const discovery = fixture.build();
  const sources = createBotSources({ services: { read: async () => {} }, resolveJiraContext: async () => {}, discover: discovery.discover });
  await expect(sources.investigate(fixture.request)).rejects.toMatchObject({ code: 'BOT_DISCOVERY_PENDING', pending: { sessionId: 'ses_discovery' } });
  expect(fixture.calls.find(([name]) => name === 'create')[1].openchamber.automation).toMatchObject({ source: 'bot', stage: 'investigation', botId: 'bugs' });
  expect(fixture.calls.find(([name]) => name === 'permissions')[1].permissions).toContainEqual({ action: '*', resource: '*', effect: 'deny' });
  expect(fixture.calls.find(([name]) => name === 'mode')[2]).toBe('ask');
  expect(fixture.calls.find(([name]) => name === 'knowledge')[3]).toEqual({ includeMemorySaveRule: false });
  expect(fixture.calls.find(([name]) => name === 'send')[1].model).toBe('chosen/investigate');
  fixture.complete();
  const restarted = fixture.build();
  await restarted.start();
  expect(fixture.ready).toEqual([{ projectId: 'p', botId: 'bugs', occurrence: 'once' }]);
  expect(await restarted.discover(fixture.request)).toHaveLength(1);
  expect(await restarted.discover(fixture.request)).toHaveLength(1);
  expect(fixture.calls.filter(([name]) => name === 'send')).toHaveLength(1);
});

it('keeps failed activity and ambiguous sends distinct from completed empty discovery', async () => {
  const fixture = await setup(); fixture.lose();
  await expect(fixture.build().discover(fixture.request)).rejects.toThrow('response lost');
  await expect(fixture.build().discover(fixture.request)).rejects.toMatchObject({ code: 'BOT_DISCOVERY_PENDING' });
  fixture.failActivity();
  await expect(fixture.build().discover(fixture.request)).rejects.toThrow('activity is unavailable');
  expect(fixture.calls.filter(([name]) => name === 'send')).toHaveLength(1);
});

it('routes permission attention and refuses malformed disk state without replacing it', async () => {
  const fixture = await setup(); const discovery = fixture.build();
  await expect(discovery.discover(fixture.request)).rejects.toMatchObject({ code: 'BOT_DISCOVERY_PENDING' });
  await discovery.onSessionEvent({ sessionId: 'ses_discovery', reason: 'authorization' });
  expect(fixture.attention[0]).toMatchObject({ state: 'needs-you', reason: 'authorization' });
  const directory = path.join(fixture.dataDir, 'bots/discovery');
  const file = (await fs.readdir(directory)).find((entry) => entry.endsWith('.json'));
  await fs.writeFile(path.join(directory, file), '{broken');
  await expect(fixture.build().discover(fixture.request)).rejects.toThrow();
  expect(await fs.readFile(path.join(directory, file), 'utf8')).toBe('{broken');
});

it('returns authoritative empty only after completion and applies only the explicit source limit', async () => {
  const empty = await setup();
  await expect(empty.build().discover(empty.request)).rejects.toMatchObject({ code: 'BOT_DISCOVERY_PENDING' });
  empty.setOutput([]); empty.complete();
  expect(await empty.build().discover(empty.request)).toEqual([]);
  const many = await setup(140);
  await expect(many.build().discover(many.request)).rejects.toMatchObject({ code: 'BOT_DISCOVERY_PENDING' });
  many.setOutput(Array.from({ length: 150 }, (_, index) => ({ source: { kind: 'investigation', id: `bug-${index}` }, title: `Bug ${index}` })));
  many.complete();
  expect(await many.build().discover(many.request)).toHaveLength(140);
});

it('persists cumulative discovery usage once, assigns deltas per day and includes failed output', async () => {
  const fixture = await setup(); const now = () => Date.parse('2026-10-23T01:00:00Z');
  const discovery = fixture.build({ now });
  await expect(discovery.discover(fixture.request)).rejects.toMatchObject({ code: 'BOT_DISCOVERY_PENDING' });
  const dayOne = Date.parse('2026-10-22T23:50:00Z');
  await discovery.recordUsage({ sessionId: 'ses_discovery', total: 3, at: dayOne });
  await discovery.recordUsage({ sessionId: 'ses_discovery', total: 3, at: dayOne });
  await discovery.recordUsage({ sessionId: 'ses_discovery', total: 2, at: dayOne });
  expect(await fixture.build({ now }).usage({ projectId: 'p', botId: 'bugs', day: '2026-10-22' })).toMatchObject({ total: 3, dailyTotal: 3, complete: true });
  fixture.setOutput({ malformed: true }); fixture.complete();
  await expect(discovery.discover(fixture.request)).rejects.toThrow();
  expect(await fixture.build({ now }).usage({ projectId: 'p', botId: 'bugs' })).toEqual({ total: 7, byDay: { '2026-10-22': 3, '2026-10-23': 4 }, day: '2026-10-23', dailyTotal: 4, complete: true });
  await discovery.recordUsage({ sessionId: 'ses_discovery', total: 999 });
  expect((await discovery.usage({ projectId: 'p', botId: 'bugs' })).total).toBe(7);
  expect(await discovery.recordUsage({ sessionId: 'ses_other', total: 10 })).toEqual({ tracked: false });
});

it('marks legacy missing usage as incomplete instead of treating it as known zero', async () => {
  const fixture = await setup(); const discovery = fixture.build();
  await expect(discovery.discover(fixture.request)).rejects.toMatchObject({ code: 'BOT_DISCOVERY_PENDING' });
  const directory = path.join(fixture.dataDir, 'bots/discovery');
  const file = (await fs.readdir(directory)).find((entry) => entry.endsWith('.json'));
  const record = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')); delete record.usage;
  await fs.writeFile(path.join(directory, file), JSON.stringify(record));
  expect(await fixture.build().usage({ projectId: 'p', botId: 'bugs' })).toMatchObject({ total: 0, complete: false });
});
