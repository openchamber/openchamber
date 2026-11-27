import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLeadActions } from './actions.js';
import { createLeadBriefEntry } from './brief-entry.js';
import { createLeadBriefStore } from './brief-store.js';
import { createLeadHandover } from './handover.js';
import { parseDigestInput, withoutDismissed } from './metadata.js';
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
      digest: { needsYou: [{ question: 'Keep the old relay protocol? Yes, until 2.5', options: [] }], now: ['git: 6 of 9 modules'], news: ['relay landed', 'mobile green'], suggestions: [], updatedAt: 5 },
    });
    expect(parseDigestInput({}, 5)).toEqual({ digest: { needsYou: [], now: [], news: [], suggestions: [], updatedAt: 5 } });
    expect(parseDigestInput({ needsYou: ['a', 'b', 'c', 'd'] }, 5)).toEqual({ error: expect.stringContaining('at most 3') });
    expect(parseDigestInput({ now: ['x'.repeat(301)] }, 5)).toEqual({ error: expect.stringContaining('300 characters') });
    expect(parseDigestInput({ news: '[not json' }, 5)).toEqual({ error: 'news must be a list of strings' });
  });

  it('keeps a question with the answers the user can pick, and only a recommendation among them', () => {
    const question = { question: 'Keep the old relay protocol?', options: ['Yes, until 2.5', 'Drop it now'], recommended: 'Yes, until 2.5' };
    expect(parseDigestInput({ needsYou: JSON.stringify([question]) }, 5)).toMatchObject({ digest: { needsYou: [question] } });
    expect(parseDigestInput({ needsYou: [{ ...question, recommended: 'Maybe' }] }, 5)).toEqual({ error: expect.stringContaining('one of the options') });
    expect(parseDigestInput({ needsYou: [{ ...question, options: ['a', 'b', 'c', 'd', 'e'] }] }, 5)).toEqual({ error: expect.stringContaining('at most 4 options') });
  });

  it('leaves out what the user dismissed from suggestions and says so', () => {
    const { digest } = parseDigestInput({ suggestions: ['Drop the v1 relay: nobody uses it', 'Speed up CI'] }, 5);
    expect(withoutDismissed(digest, ['drop the  v1 relay: nobody uses it'])).toMatchObject({
      digest: { suggestions: ['Speed up CI'] },
      dropped: ['Drop the v1 relay: nobody uses it'],
    });
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
    const handOver = vi.fn(async (sessionId, leadId) => ({ sessionId, leadId }));
    const actions = createLeadActions({
      getSession: async (id) => ({ id, directory: '/repo', metadata }),
      updateMetadata,
      briefs,
      handOver,
      createError,
      now: () => 42,
    });
    return { actions, briefs, updateMetadata, handOver, writes };
  };

  it('refuses a session that is not a lead and writes nothing', async () => {
    const { actions, updateMetadata } = await setup({});
    await expect(actions.execute('lead.digest', { now: ['x'] }, 'ses_plain')).rejects.toMatchObject({ status: 409 });
    await expect(actions.execute('lead.brief', { brief: '# Goal' }, 'ses_plain')).rejects.toMatchObject({ status: 409 });
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('keeps the brief in its file, within the limit', async () => {
    const { actions, briefs } = await setup();
    const missing = await actions.execute('lead.brief', {}, 'ses_lead');
    expect(missing).toMatchObject({ brief: '', empty: true });
    expect(missing).not.toHaveProperty('file');
    const saved = await actions.execute('lead.brief', { brief: '  # Goal\n\nShip it  ' }, 'ses_lead');
    expect(saved).toMatchObject({ saved: true, length: 15 });
    expect(await fs.readFile(saved.file, 'utf8')).toBe('# Goal\n\nShip it\n');
    expect(await actions.execute('lead.brief', {}, 'ses_lead')).toMatchObject({ file: saved.file });
    await expect(actions.execute('lead.brief', { brief: 'x'.repeat(12_001) }, 'ses_lead')).rejects.toMatchObject({ status: 400 });
    expect(await briefs.read('ses_lead')).toBe('# Goal\n\nShip it\n');
  });

  it('changes parts of the brief in order, and saves nothing when one edit does not fit', async () => {
    const { actions, briefs } = await setup();
    await expect(actions.execute('lead.brief', { edits: [{ find: 'Ship', replace: 'Land' }] }, 'ses_lead')).rejects.toMatchObject({ status: 409 });
    await actions.execute('lead.brief', { brief: '# Goal\n\nShip it\n\n## Rules\n\n- tests first' }, 'ses_lead');
    await actions.execute('lead.brief', { edits: '[{"find":"Ship it","replace":"Ship it by Friday"},{"find":"- tests first","replace":"- tests first\\n- no new deps"}]' }, 'ses_lead');
    expect(await briefs.read('ses_lead')).toBe('# Goal\n\nShip it by Friday\n\n## Rules\n\n- tests first\n- no new deps\n');
    for (const edits of [[{ find: 'Friday', replace: 'Monday' }, { find: 'missing', replace: 'x' }], [{ find: 'i', replace: 'I' }]]) {
      await expect(actions.execute('lead.brief', { edits }, 'ses_lead')).rejects.toMatchObject({ status: 409 });
    }
    await expect(actions.execute('lead.brief', { brief: '# New', edits: [] }, 'ses_lead')).rejects.toMatchObject({ status: 400 });
    expect(await briefs.read('ses_lead')).toContain('by Friday');
  });

  it('sets, replaces and closes a strand by its id and leaves the rest of the brief as it is', async () => {
    const { actions, briefs } = await setup();
    const legacy = '# Goal\n\nShip it\n\n## Strands\n\n### old heading\n\n- notes\n';
    await briefs.write('ses_lead', legacy);
    expect(await actions.execute('lead.brief', {}, 'ses_lead')).toMatchObject({ brief: legacy, strands: [] });
    const added = await actions.execute('lead.brief', { strands: [{ id: 'relay', text: 'Land the relay\n(ses_a)' }, { id: 'ci', text: 'Green main' }] }, 'ses_lead');
    expect(added.strands).toEqual({ added: ['relay', 'ci'], replaced: [], closed: [] });
    expect(await fs.readFile(added.file, 'utf8')).toContain('### relay\n\nLand the relay\n(ses_a)');
    const changed = await actions.execute('lead.brief', { edits: [{ find: 'Ship it', replace: 'Ship it whole' }], strands: '[{"id":"ci","text":"Green, waits on the VM"},{"id":"relay","close":true}]' }, 'ses_lead');
    expect(changed.strands).toEqual({ added: [], replaced: ['ci'], closed: ['relay'] });
    expect(await actions.execute('lead.brief', {}, 'ses_lead')).toMatchObject({
      brief: expect.stringContaining(legacy.trim().replace('Ship it', 'Ship it whole')),
      strands: [{ id: 'ci', text: 'Green, waits on the VM' }],
    });
    await actions.execute('lead.brief', { edits: [{ find: '- notes\n', replace: '- no notes\n' }] }, 'ses_lead');
    await actions.execute('lead.brief', { brief: '# New goal' }, 'ses_lead');
    expect((await actions.execute('lead.brief', {}, 'ses_lead')).strands).toEqual([{ id: 'ci', text: 'Green, waits on the VM' }]);
    await actions.execute('lead.brief', { strands: [{ id: 'ci', close: true }] }, 'ses_lead');
    expect(await briefs.read('ses_lead')).toBe('# New goal\n');
  });

  it('refuses a strand that is a history, a heading, unknown or named twice, and saves nothing of the call', async () => {
    const { actions, briefs } = await setup();
    await actions.execute('lead.brief', { brief: '# Goal', strands: [{ id: 'ci', text: 'Green main' }] }, 'ses_lead');
    const before = await briefs.read('ses_lead');
    for (const strands of [
      [{ id: 'ci', text: 'x'.repeat(601) }], [{ id: 'ci', text: 'a\n### other\nb' }], [{ id: 'CI run', text: 'a' }], [{ id: 'ci', text: ' ' }],
      [{ id: 'new', text: 'a' }, { id: 'typo', close: true }], [{ id: 'ci', text: 'a' }, { id: 'ci', close: true }],
    ]) {
      await expect(actions.execute('lead.brief', { strands }, 'ses_lead')).rejects.toMatchObject({ status: 409 });
    }
    await expect(actions.execute('lead.brief', { brief: before }, 'ses_lead')).rejects.toThrow('Leave the Strands section out');
    expect(await briefs.read('ses_lead')).toBe(before);
  });

  it('keeps what the user wrote by hand into the strands of the file', async () => {
    const { actions, briefs } = await setup();
    await actions.execute('lead.brief', { brief: '# Goal', strands: [{ id: 'ci', text: 'Green main' }] }, 'ses_lead');
    const stored = await briefs.read('ses_lead');
    await briefs.write('ses_lead', stored.replace('## Strands\n', '## Strands\n\nFirst CI\n') + '\n### My note\nby hand\n');
    await actions.execute('lead.brief', { strands: [{ id: 'relay', text: 'Land it' }] }, 'ses_lead');
    const read = await actions.execute('lead.brief', {}, 'ses_lead');
    expect(read.strands).toEqual([{ id: 'ci', text: 'Green main' }, { id: 'relay', text: 'Land it' }]);
    expect(read.brief).toMatch(/^# Goal\s+First CI\s+### My note\nby hand\s*$/);
    await actions.execute('lead.brief', { strands: [{ id: 'ci', close: true }] }, 'ses_lead');
    expect(await briefs.read('ses_lead')).toContain('### My note\nby hand');
  });

  it('says how full the brief is on every write, and asks to condense well before the limit', async () => {
    const { actions } = await setup();
    const small = await actions.execute('lead.brief', { brief: '# Goal', strands: [{ id: 'a', text: 'x' }, { id: 'b', text: 'xxx' }] }, 'ses_lead');
    expect(small).toMatchObject({ full: '1%', largestStrands: [{ id: 'b', length: 3 }, { id: 'a', length: 1 }] });
    expect(small).not.toHaveProperty('note');
    expect((await actions.execute('lead.brief', { brief: 'x'.repeat(9_000) }, 'ses_lead')).note).toContain('Condense it now');
  });

  it('refuses a field it does not have, names it, and saves nothing', async () => {
    const { actions, briefs, writes } = await setup();
    await expect(actions.execute('lead.brief', { text: '# Goal' }, 'ses_lead')).rejects.toThrow('lead.brief has no text; it takes brief, edits, strands.');
    await expect(actions.execute('lead.brief', { brief: '# Goal', body: 'more' }, 'ses_lead')).rejects.toMatchObject({ status: 400 });
    expect(await briefs.read('ses_lead')).toBeNull();
    await actions.execute('lead.brief', { action: 'lead.brief', brief: '# Goal', sessionId: 'ses_lead', directory: '/repo', title: '', all: false, args: {}, carry: [] }, 'ses_lead');
    await expect(actions.execute('lead.digest', { now: ['x'], summary: 'y' }, 'ses_lead')).rejects.toThrow('lead.digest has no summary');
    expect(writes).toEqual([]);
  });

  it('hands a session to a lead only for the user, never for an agent', async () => {
    const { actions, handOver } = await setup();
    await expect(actions.execute('lead.handover', { sessionId: 'ses_old', leadId: 'ses_lead' }, 'ses_agent')).rejects.toMatchObject({ status: 403 });
    expect(handOver).not.toHaveBeenCalled();
    await actions.execute('lead.handover', { sessionId: 'ses_old', leadId: 'ses_lead' }, null);
    expect(handOver).toHaveBeenCalledWith('ses_old', 'ses_lead');
  });

  it('refuses a digest until the lead wrote its brief', async () => {
    const { actions, writes } = await setup();
    await expect(actions.execute('lead.digest', { now: ['git: green'] }, 'ses_lead')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('lead.brief first') });
    expect(writes).toEqual([]);
  });

  it('replaces the whole digest with the time it was written', async () => {
    const { actions, briefs, writes } = await setup();
    await briefs.write('ses_lead', '# Goal\n');
    await actions.execute('lead.digest', { now: ['git: green'] }, 'ses_lead');
    expect(writes).toEqual([{ openchamber: { lead: { digest: { needsYou: [], now: ['git: green'], news: [], suggestions: [], updatedAt: 42 } } } }]);
  });

  it('filters what the user dismissed by the time the digest is written, not when the call began', async () => {
    const { actions, briefs, writes } = await setup(LEAD, { openchamber: { lead: { at: 1, dismissed: ['Speed up CI'] } } });
    await briefs.write('ses_lead', '# Goal\n');
    const result = await actions.execute('lead.digest', { suggestions: ['Speed up CI', 'Drop v1'] }, 'ses_lead');
    expect(writes[0].openchamber.lead.digest.suggestions).toEqual(['Drop v1']);
    expect(result.droppedFromSuggestions).toEqual(['Speed up CI']);
  });

  it('applies edits that arrive together one after the other', async () => {
    const { actions, briefs } = await setup();
    await actions.execute('lead.brief', { brief: '# Goal\n\nA\n\nB' }, 'ses_lead');
    await Promise.all([
      actions.execute('lead.brief', { edits: [{ find: 'A', replace: 'A1' }] }, 'ses_lead'),
      actions.execute('lead.brief', { edits: [{ find: 'B', replace: 'B1' }] }, 'ses_lead'),
    ]);
    expect(await briefs.read('ses_lead')).toBe('# Goal\n\nA1\n\nB1\n');
  });

  it('writes no digest once the user turned the lead back, or marked it again since', async () => {
    for (const stored of [{}, { openchamber: { lead: { at: 2 } } }]) {
      const { actions, briefs, writes } = await setup(LEAD, stored);
      await briefs.write('ses_lead', '# Goal\n');
      await expect(actions.execute('lead.digest', { now: ['x'] }, 'ses_lead')).rejects.toMatchObject({ status: 409 });
      expect(writes).toEqual([]);
    }
  });
});

describe('sleep compaction', () => {
  const setup = ({ metadata = LEAD, tokens = SLEEP_COMPACTION_MIN_TOKENS, busy = false, warm = false, revert = undefined, model = { id: 'm', providerID: 'p', cacheLifetimeMs: 60_000, window: 1_000_000 }, brief = '# Goal\n', onContext = () => {}, turnEndedAt = undefined, trailing = [], failing = {} } = {}) => {
    const timers = [];
    const requests = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const route = new URL(String(url)).pathname;
      requests.push({ route, method: init.method ?? 'GET' });
      const json = (data) => new Response(JSON.stringify({ data }), { status: 200 });
      if (route === '/api/session/active') return json(busy ? { ses_lead: {} } : {});
      if (route === '/api/session/ses_lead') return json({ id: 'ses_lead', revert });
      if (route.endsWith('/context') && failing.context) return new Response('{}', { status: 503 });
      if (route.endsWith('/context')) await onContext();
      if (route.endsWith('/context')) return json([{ type: 'user' }, { type: 'assistant', time: { created: 1, completed: turnEndedAt }, tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, ...trailing]);
      if (route.endsWith('/compact')) return json({ id: 'msg_1' });
      return new Response('{}', { status: 404 });
    });
    const briefs = { read: async () => (brief instanceof Error ? Promise.reject(brief) : brief), remove: vi.fn(async () => undefined) };
    const clearInherited = vi.fn(async () => ({ changed: true }));
    const quiet = { mark: vi.fn(), unmark: vi.fn() };
    let clock = 1_000;
    let reads = 0;
    const runtime = createSessionLeadRuntime({
      briefs,
      readSessionMetadata: async () => (reads += 1, failing.metadata ? Promise.reject(new Error('503')) : { openchamber: { ...metadata.openchamber, lead: metadata.openchamber?.lead && { ...metadata.openchamber.lead, digest: { needsYou: ['Keep it? Yes'], now: ['git: green'], news: [], updatedAt: 1 } } } }),
      buildOpenCodeUrl: (route) => `http://opencode${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      readModel: async () => (typeof model === 'function' ? model() : model),
      isSessionWarm: () => warm,
      listChildren: async () => [{ id: 'ses_child', title: 'Migrate git', status: { type: 'busy' } }],
      listLeads: async () => [{ id: 'ses_lead', directory: '/repo' }],
      quiet,
      clearInherited,
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
    const resume = async () => {
      await runtime.resumeSleep();
      await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    };
    return { runtime, requests, briefs, timers, idle, resume, fire, tick: (ms) => { clock += ms; }, clearInherited, quiet, metadataReads: () => reads };
  };

  it('picks up after a restart from when the last turn ended, through the same checks', async () => {
    const sleeper = setup({ turnEndedAt: 1_000 - 60_000 });
    await sleeper.resume();
    expect(sleeper.timers[0].delay).toBe(30_000);
    await sleeper.fire();
    expect(sleeper.requests).toContainEqual({ route: '/api/session/ses_lead/compact', method: 'POST' });

    const longAsleep = setup({ turnEndedAt: 1_000 - 24 * 60 * 60_000 });
    await longAsleep.resume();
    expect(longAsleep.timers[0].delay).toBe(0);

    for (const options of [{ tokens: SLEEP_COMPACTION_MIN_TOKENS - 1 }, { warm: true }, { busy: true }, { revert: { messageID: 'msg_1' } }]) {
      const { requests, resume, fire } = setup({ ...options, turnEndedAt: 1 });
      await resume();
      await fire();
      expect(requests.some((request) => request.route.endsWith('/compact'))).toBe(false);
    }
  });

  it('counts from the newest of the idle it saw and the last answer, also one that has no tokens', async () => {
    const seen = setup({ turnEndedAt: 1 });
    await seen.idle();
    seen.tick(30_000);
    await seen.runtime.resumeSleep();
    await vi.waitFor(() => expect(seen.timers).toHaveLength(2));
    expect(seen.timers[1].delay).toBe(60_000);

    const missed = setup({ turnEndedAt: 31_000 });
    await missed.idle();
    missed.tick(30_000);
    await missed.runtime.resumeSleep();
    await vi.waitFor(() => expect(missed.timers).toHaveLength(2));
    expect(missed.timers[1].delay).toBe(90_000);

    const failedStep = setup({ turnEndedAt: 1, trailing: [{ type: 'assistant', time: { created: 900, completed: 1_000 } }] });
    await failedStep.resume();
    expect(failedStep.timers[0].delay).toBe(90_000);
  });

  it('keeps a timer it cannot replace, and waits a full cache when the last answer cannot be read', async () => {
    const failing = {};
    const run = setup({ turnEndedAt: 1, failing });
    await run.idle();
    run.tick(30_000);
    failing.metadata = true;
    await run.runtime.resumeSleep();
    await vi.waitFor(() => expect(run.metadataReads()).toBe(2));
    failing.metadata = false;
    expect(run.timers).toHaveLength(1);
    await run.fire();
    expect(run.requests).toContainEqual({ route: '/api/session/ses_lead/compact', method: 'POST' });

    const unreadable = setup({ turnEndedAt: 1, failing: { context: true } });
    await unreadable.idle();
    unreadable.tick(30_000);
    await unreadable.runtime.resumeSleep();
    await vi.waitFor(() => expect(unreadable.timers).toHaveLength(2));
    expect(unreadable.timers[1].delay).toBe(90_000);
  });

  it('asks to clear what a new child copied from its parent, and leaves a session without a parent or linked by metadata alone', async () => {
    const { runtime, clearInherited } = setup();
    const created = (info) => runtime.processPayload({ type: 'session.created', properties: { sessionID: 'ses_new', info } }, '/repo');
    created({ id: 'ses_new', metadata: { openchamber: { lead: { at: 1 } } } });
    expect(clearInherited).not.toHaveBeenCalled();
    created({ id: 'ses_new', parentID: 'ses_operator', metadata: { openchamber: { kind: 'operator-child', parentID: 'ses_operator' } } });
    expect(clearInherited).not.toHaveBeenCalled();
    created({ id: 'ses_new', parentID: 'ses_lead' });
    expect(clearInherited).toHaveBeenCalledWith('ses_new', 'ses_lead', '/repo');
  });

  it('compacts an idle lead past its cache and answers the hook with its own note once', async () => {
    const { runtime, requests, timers, idle, fire, quiet } = setup();
    await idle();
    expect(timers[0].delay).toBe(90_000);
    await fire();
    expect(requests).toContainEqual({ route: '/api/session/ses_lead/compact', method: 'POST' });
    expect(quiet.mark).toHaveBeenCalledWith('ses_lead');
    expect(quiet.unmark).not.toHaveBeenCalled();

    const summary = await runtime.sleepSummary('ses_lead');
    expect(summary).toContain('session.messages for sessionId ses_lead');
    expect(summary).toContain('Keep it? Yes');
    expect(summary).toContain('Migrate git (ses_child): busy');
    expect(await runtime.sleepSummary('ses_lead')).toBeNull();
  });

  it('leaves the summary to the model when the lead has no brief to wake up with, or it cannot be read', async () => {
    for (const brief of [null, Object.assign(new Error('EACCES'), { code: 'EACCES' })]) {
      const { runtime, requests, idle, fire } = setup({ brief });
      await idle();
      await fire();
      expect(requests).toContainEqual({ route: '/api/session/ses_lead/compact', method: 'POST' });
      expect(await runtime.sleepSummary('ses_lead')).toBeNull();
    }
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

  it('waits an hour for a cache nobody describes and five minutes for a Claude one', async () => {
    const minutes = async (model) => {
      const { timers, idle } = setup({ model });
      await idle();
      return timers[0].delay / 60_000;
    };
    const unknown = { cacheLifetimeMs: null, window: null };
    expect(await minutes({ ...unknown, id: 'gpt-6', providerID: 'openai' })).toBe(60.5);
    expect(await minutes(null)).toBe(60.5);
    expect(await minutes({ ...unknown, id: 'anthropic/claude-opus', providerID: 'openrouter' })).toBe(5.5);
    expect(await minutes({ ...unknown, id: 'sonnet', family: 'claude-sonnet', providerID: 'gateway' })).toBe(5.5);
    expect(await minutes({ ...unknown, id: 'workhorse', modelID: 'claude-sonnet', providerID: 'gateway' })).toBe(5.5);
    expect(await minutes({ ...unknown, id: 'opus', providerID: 'claude-agent' })).toBe(5.5);
  });

  it('compacts a model with a small window at three quarters of it', async () => {
    const model = { id: 'm', providerID: 'p', cacheLifetimeMs: 60_000, window: 128_000 };
    for (const [tokens, compacts] of [[95_999, false], [96_000, true]]) {
      const { requests, idle, fire } = setup({ model, tokens });
      await idle();
      await fire();
      expect(requests.some((request) => request.route.endsWith('/compact'))).toBe(compacts);
    }
  });

  it('measures against the model the lead will wake up on', async () => {
    const at = (window) => ({ id: 'm', providerID: 'p', cacheLifetimeMs: 60_000, window });
    let current = at(128_000);
    const { requests, idle, fire } = setup({ model: () => current, tokens: 150_000 });
    await idle();
    current = at(1_000_000);
    await fire();
    expect(requests.some((request) => request.route.endsWith('/compact'))).toBe(false);
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
      registerResult: async () => ({}),
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

describe('brief entry', () => {
  it('keeps the brief the conversation began with until a compaction brings it up to date', async () => {
    const briefs = createLeadBriefStore({ dataDir: await dataDir() });
    const puts = [];
    const entry = createLeadBriefEntry({ briefs, putEntry: async (...args) => { puts.push(args); return true; } });
    expect(await entry.forEntry('ses_lead')).toBeNull();
    await briefs.write('ses_lead', '# Goal\n');
    expect(await entry.forEntry('ses_lead')).toBeNull();
    await entry.refresh('ses_lead', '/repo', true);
    expect(await entry.forEntry('ses_lead')).toBe('# Goal\n');
    await briefs.write('ses_lead', '# Goal, edited\n');
    expect(await entry.forEntry('ses_lead')).toBe('# Goal\n');
    await entry.refresh('ses_lead', '/repo', true);
    expect(puts).toEqual([['ses_lead', '/repo', '# Goal\n'], ['ses_lead', '/repo', '# Goal, edited\n']]);
    expect(await entry.forEntry('ses_lead')).toBe('# Goal, edited\n');
    await briefs.write('ses_lead', '# Third\n');
    await entry.refresh('ses_lead', '/repo', false);
    expect(await entry.forEntry('ses_lead')).toBe('# Third\n');
  });
});

describe('handing a session to a lead', () => {
  const setup = ({ sessions = {}, busy = false, failMetadata = false, failWake = false, revert = undefined } = {}) => {
    const metadata = { ses_lead: LEAD, ses_old: {}, ...sessions };
    const calls = [];
    const client = {
      session: {
        get: async ({ sessionID }) => ({ id: sessionID, title: 'Old work', revert: sessionID === 'ses_lead' ? revert : undefined, permissions: [{ action: 'edit', resource: '*', effect: 'allow' }] }),
        update: async (input) => { calls.push(['update', input.sessionID, input.permissions.map((rule) => rule.action)]); },
        synthetic: async (input) => {
          if (failWake && input.resume) throw new Error('lead unreachable');
          calls.push(['synthetic', input.sessionID, input.resume === true, input.text]);
        },
      },
      message: { list: async () => ({ data: [{ id: 'msg_turn', type: 'assistant' }, { id: 'msg_idle', type: 'idle' }] }) },
    };
    const handover = createLeadHandover({
      resolveSessionDirectory: async () => '/repo',
      readSessionMetadata: async (id) => metadata[id],
      updateMetadata: async (id, decide) => {
        if (failMetadata) throw new Error('disk full');
        const patch = decide(metadata[id]);
        if (patch) metadata[id] = patch;
        return { changed: patch !== null };
      },
      openCode: () => client,
      isBusy: async () => busy,
      registerResult: async (entry) => { calls.push(['register', entry.parentSessionId, entry.sessionId, entry.afterIdleId]); },
      createError,
      now: () => 7,
    });
    return { handover, calls, metadata };
  };

  it('makes the session one of the lead\'s own and wakes the lead with it', async () => {
    const { handover, calls, metadata } = setup({ busy: true });
    await handover.handOver('ses_old', 'ses_lead');
    expect(metadata.ses_old).toEqual({ openchamber: { kind: 'operator-child', parentID: 'ses_lead' } });
    expect(calls[0]).toEqual(['update', 'ses_old', ['edit', 'question', 'openchamber_secret']]);
    expect(calls).toContainEqual(['register', 'ses_lead', 'ses_old', 'msg_idle']);
    const wake = calls.find(([kind, id]) => kind === 'synthetic' && id === 'ses_lead');
    expect(wake[2]).toBe(true);
    expect(wake[3]).toContain('"Old work" (ses_old)');
    expect(wake[3]).toContain('Its answer comes to you');
  });

  it('starts following an idle session too, so every later answer of it reaches the lead', async () => {
    const { handover, calls } = setup({ busy: false });
    await handover.handOver('ses_old', 'ses_lead');
    expect(calls).toContainEqual(['register', 'ses_lead', 'ses_old', 'msg_idle']);
  });

  it('refuses a lead, a session another one runs and the lead itself, and undoes the permissions when the link fails', async () => {
    const refused = setup({ sessions: { ses_other_lead: LEAD, ses_theirs: { openchamber: { kind: 'operator-child', parentID: 'ses_x' } } } });
    for (const sessionId of ['ses_other_lead', 'ses_theirs', 'ses_lead']) {
      await expect(refused.handover.handOver(sessionId, 'ses_lead')).rejects.toHaveProperty('status');
    }
    await expect(refused.handover.handOver('ses_old', 'ses_old')).rejects.toMatchObject({ status: 400 });
    expect(refused.calls).toEqual([]);

    const failing = setup({ failMetadata: true });
    await expect(failing.handover.handOver('ses_old', 'ses_lead')).rejects.toThrow('disk full');
    expect(failing.calls.at(-1)).toEqual(['update', 'ses_old', ['edit']]);
    expect(failing.calls.some(([kind]) => kind === 'synthetic')).toBe(false);
  });

  it('gives the session back when the lead cannot be woken, and refuses a lead with an undo waiting', async () => {
    const unreachable = setup({ failWake: true, busy: true });
    await expect(unreachable.handover.handOver('ses_old', 'ses_lead')).rejects.toThrow('lead unreachable');
    expect(unreachable.metadata.ses_old).toEqual({ openchamber: { kind: null, parentID: null } });
    expect(unreachable.calls.at(-1)).toEqual(['update', 'ses_old', ['edit']]);
    expect(unreachable.calls.some(([kind]) => kind === 'register')).toBe(false);

    const reverting = setup({ revert: { messageID: 'msg_1' } });
    await expect(reverting.handover.handOver('ses_old', 'ses_lead')).rejects.toMatchObject({ status: 409 });
    expect(reverting.calls).toEqual([]);
  });

  it('hands one session to one lead when two ask at once', async () => {
    const { handover, calls, metadata } = setup({ sessions: { ses_lead2: LEAD } });
    const results = await Promise.allSettled([handover.handOver('ses_old', 'ses_lead'), handover.handOver('ses_old', 'ses_lead2')]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(metadata.ses_old.openchamber.parentID).toBe('ses_lead');
    expect(calls.filter(([kind]) => kind === 'update')).toEqual([['update', 'ses_old', ['edit', 'question', 'openchamber_secret']]]);
  });
});
