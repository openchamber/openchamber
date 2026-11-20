import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLeadActions } from './actions.js';
import { createLeadBriefStore } from './brief-store.js';
import { parseDigestInput } from './metadata.js';
import { createSessionLeadRuntime, SLEEP_COMPACTION_MIN_TOKENS } from './runtime.js';

const createError = (message, status) => Object.assign(new Error(message), { status });
const LEAD = { openchamber: { lead: { at: 1 } } };

const temporaryDirectories = [];
const dataDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lead-test-'));
  temporaryDirectories.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('lead digest input', () => {
  it('reads lists, JSON-encoded lists and one item per line, and refuses what does not fit', () => {
    expect(parseDigestInput({ needsYou: ['Keep the old relay protocol? Yes, until 2.5'], now: '["git: 6 of 9 modules"]', news: '- relay landed\n\n- mobile green' }, 5)).toEqual({
      digest: { needsYou: ['Keep the old relay protocol? Yes, until 2.5'], now: ['git: 6 of 9 modules'], news: ['relay landed', 'mobile green'], updatedAt: 5 },
    });
    expect(parseDigestInput({}, 5)).toEqual({ digest: { needsYou: [], now: [], news: [], updatedAt: 5 } });
    expect(parseDigestInput({ needsYou: ['a', 'b', 'c', 'd'] }, 5)).toEqual({ error: expect.stringContaining('at most 3') });
    expect(parseDigestInput({ now: ['x'.repeat(301)] }, 5)).toEqual({ error: expect.stringContaining('300 characters') });
    expect(parseDigestInput({ news: '[not json' }, 5)).toEqual({ error: 'news must be a list of strings' });
  });
});

describe('lead actions', () => {
  const setup = async (metadata = LEAD, stored = metadata) => {
    const briefs = createLeadBriefStore({ dataDir: await dataDir() });
    const writes = [];
    const updateMetadata = vi.fn(async (_id, decide) => {
      const patch = decide(stored);
      if (patch) writes.push(patch);
      return { changed: patch !== null };
    });
    const syncBriefEntry = vi.fn(async () => true);
    const actions = createLeadActions({
      getSession: async (id) => ({ id, directory: '/repo', metadata }),
      updateMetadata,
      briefs,
      syncBriefEntry,
      createError,
      now: () => 42,
    });
    return { actions, briefs, updateMetadata, syncBriefEntry, writes };
  };

  it('refuses a session that is not a lead and writes nothing', async () => {
    const { actions, updateMetadata } = await setup({});
    await expect(actions.execute('lead.digest', { now: ['x'] }, 'ses_plain')).rejects.toMatchObject({ status: 409 });
    await expect(actions.execute('lead.brief', { brief: '# Goal' }, 'ses_plain')).rejects.toMatchObject({ status: 409 });
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('keeps the brief in its file and in the instruction entry, within the limit', async () => {
    const { actions, briefs, syncBriefEntry } = await setup();
    expect(await actions.execute('lead.brief', {}, 'ses_lead')).toMatchObject({ brief: '', empty: true });
    expect(await actions.execute('lead.brief', { brief: '  # Goal\n\nShip it  ' }, 'ses_lead')).toMatchObject({ saved: true, length: 15 });
    expect(await briefs.read('ses_lead')).toBe('# Goal\n\nShip it\n');
    expect(syncBriefEntry).toHaveBeenCalledWith('ses_lead', '/repo', '# Goal\n\nShip it');
    await expect(actions.execute('lead.brief', { brief: 'x'.repeat(12_001) }, 'ses_lead')).rejects.toMatchObject({ status: 400 });
    expect(await briefs.read('ses_lead')).toBe('# Goal\n\nShip it\n');
  });

  it('replaces the whole digest with the time it was written', async () => {
    const { actions, writes } = await setup();
    await actions.execute('lead.digest', { now: ['git: green'] }, 'ses_lead');
    expect(writes).toEqual([{ openchamber: { lead: { digest: { needsYou: [], now: ['git: green'], news: [], updatedAt: 42 } } } }]);
  });

  it('writes no digest once the user turned the lead back, or marked it again since', async () => {
    for (const stored of [{}, { openchamber: { lead: { at: 2 } } }]) {
      const { actions, writes } = await setup(LEAD, stored);
      await expect(actions.execute('lead.digest', { now: ['x'] }, 'ses_lead')).rejects.toMatchObject({ status: 409 });
      expect(writes).toEqual([]);
    }
  });
});

describe('sleep compaction', () => {
  const setup = ({ metadata = LEAD, tokens = SLEEP_COMPACTION_MIN_TOKENS, busy = false, warm = false, revert = undefined, onContext = () => {} } = {}) => {
    const timers = [];
    const requests = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const route = new URL(String(url)).pathname;
      requests.push({ route, method: init.method ?? 'GET' });
      const json = (data) => new Response(JSON.stringify({ data }), { status: 200 });
      if (route === '/api/session/active') return json(busy ? { ses_lead: {} } : {});
      if (route === '/api/session/ses_lead') return json({ id: 'ses_lead', revert });
      if (route.endsWith('/context')) await onContext();
      if (route.endsWith('/context')) return json([{ type: 'user' }, { type: 'assistant', tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }]);
      if (route.endsWith('/compact')) return json({ id: 'msg_1' });
      return new Response('{}', { status: 404 });
    });
    const briefs = { remove: vi.fn(async () => undefined) };
    let clock = 1_000;
    let reads = 0;
    const runtime = createSessionLeadRuntime({
      briefs,
      readSessionMetadata: async () => (reads += 1, { openchamber: { ...metadata.openchamber, lead: metadata.openchamber?.lead && { ...metadata.openchamber.lead, digest: { needsYou: ['Keep it? Yes'], now: ['git: green'], news: [], updatedAt: 1 } } } }),
      buildOpenCodeUrl: (route) => `http://opencode${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      readCacheLifetime: async () => 60_000,
      isSessionWarm: () => warm,
      listChildren: async () => [{ id: 'ses_child', title: 'Migrate git', status: { type: 'busy' } }],
      fetchImpl,
      now: () => clock,
      setTimer: (run, delay) => { timers.push({ run, delay }); return timers.length; },
      clearTimer: () => undefined,
    });
    const idle = async () => {
      runtime.processPayload({ type: 'session.idle', properties: { sessionID: 'ses_lead' } }, '/repo');
      await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    };
    const fire = async () => {
      clock += 90_000;
      await timers.at(-1).run();
    };
    return { runtime, requests, briefs, timers, idle, fire, metadataReads: () => reads };
  };

  it('compacts an idle lead past its cache and answers the hook with its own note once', async () => {
    const { runtime, requests, timers, idle, fire } = setup();
    await idle();
    expect(timers[0].delay).toBe(90_000);
    await fire();
    expect(requests).toContainEqual({ route: '/api/session/ses_lead/compact', method: 'POST' });

    const summary = await runtime.sleepSummary('ses_lead');
    expect(summary).toContain('session.messages');
    expect(summary).toContain('Keep it? Yes');
    expect(summary).toContain('Migrate git (ses_child): busy');
    expect(await runtime.sleepSummary('ses_lead')).toBeNull();
  });

  it('leaves a small context, a warm session, a running one, a staged undo and a plain session to the model', async () => {
    for (const options of [{ tokens: SLEEP_COMPACTION_MIN_TOKENS - 1 }, { warm: true }, { busy: true }, { revert: { messageID: 'msg_1' } }]) {
      const { runtime, requests, idle, fire } = setup(options);
      await idle();
      await fire();
      expect(requests.some((request) => request.route.endsWith('/compact'))).toBe(false);
      expect(await runtime.sleepSummary('ses_lead')).toBeNull();
    }
    const plain = setup({ metadata: {} });
    plain.runtime.processPayload({ type: 'session.idle', properties: { sessionID: 'ses_lead' } }, '/repo');
    await vi.waitFor(() => expect(plain.metadataReads()).toBe(1));
    await Promise.resolve();
    expect(plain.timers).toEqual([]);
  });

  it('stands down when a turn starts while it is checking', async () => {
    let runtime;
    const turnStarts = () => runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_lead', status: { type: 'busy' } } }, '/repo');
    const run = setup({ onContext: turnStarts });
    runtime = run.runtime;
    await run.idle();
    await run.fire();
    expect(run.requests.some((request) => request.route.endsWith('/compact'))).toBe(false);
    expect(await run.runtime.sleepSummary('ses_lead')).toBeNull();
  });

  it("removes a deleted lead's brief", () => {
    const { runtime, briefs } = setup();
    runtime.processPayload({ type: 'session.deleted', properties: { sessionID: 'ses_lead' } }, '');
    expect(briefs.remove).toHaveBeenCalledWith('ses_lead');
  });
});

describe('workflow runs without approval', () => {
  const decide = async (settings, metadata) => {
    const { createSessionLeadServer } = await import('./server.js');
    const server = createSessionLeadServer({
      dataDir: await dataDir(),
      readSessionMetadata: async () => metadata,
      updateMetadata: async () => ({ changed: false }),
      resolveSessionDirectory: async () => '/repo',
      syncBriefEntry: async () => true,
      executeControl: async () => ({ sessions: [] }),
      readWorkflowSettings: async () => settings,
      createError,
      buildOpenCodeUrl: (route) => route,
      getOpenCodeAuthHeaders: () => ({}),
    });
    return server.startsWorkflowWithoutApproval('ses_x');
  };

  it('start at once for every session, for leads only, or never', async () => {
    expect(await decide({ agentWorkflowAutoApprove: true }, {})).toBe(true);
    expect(await decide({ agentWorkflowAutoApproveLeads: true }, LEAD)).toBe(true);
    expect(await decide({ agentWorkflowAutoApproveLeads: true }, {})).toBe(false);
    expect(await decide({}, LEAD)).toBe(false);
    expect(await decide(null, LEAD)).toBe(false);
  });
});
