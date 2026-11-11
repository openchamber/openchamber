/**
 * Dreaming: a pass over the agent memory that runs on its own, in a session
 * nobody sees, and tidies the store the way the panel's Tidy up does with
 * someone watching. It merges related entries, removes what newer entries,
 * the project's code or its agent docs already settle, and fits the titles
 * into the index sessions are given. It never asks and never creates.
 *
 * When: the server checks a few minutes after it starts and every hour after,
 * so a desktop app that is opened and closed through the day still dreams.
 * A scope is due a day after its last pass, once it holds enough new or
 * changed entries or its titles no longer fit the index. A pass waits while
 * any session is running, so it never competes with the user's own work.
 *
 * One pass covers one project, and the user's global memory too when that is
 * due. The pass's session is registered as hidden before it exists
 * (`../opencode/hidden-sessions.js`) and removed when it ends; one left behind
 * by a server that stopped mid-pass is removed at the next start.
 */

import { z } from 'zod';

import { asNonEmptyString, isRecord } from '../shared/guards.js';

const DREAM_SESSION_KIND = 'memory-dream';

const START_DELAY_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** After a pass, the next due project is looked at soon rather than in an hour. */
const FOLLOW_UP_DELAY_MS = 60 * 1000;
const DUE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Fewer new or changed entries than this is not worth a pass, unless the index overflows. */
const MIN_CHANGED_ENTRIES = 10;
const PASS_TIMEOUT_MS = 30 * 60 * 1000;
/** A failed pass is tried again sooner than a finished one, but not every hour. */
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;
/**
 * How often a running pass is looked at. Polled rather than waited on: a long
 * wait request outlives the runtime's own fetch timeout (five minutes in Bun),
 * and a slow model spends that long on its first answer alone.
 */
const POLL_INTERVAL_MS = 5000;
/** A turn not seen running this long after its prompt has ended or never began. */
const START_GRACE_MS = 30 * 1000;
/** No single request to OpenCode may hold a pass, its cleanup included. */
const REQUEST_TIMEOUT_MS = 60 * 1000;
const LEFTOVER_PAGES = 10;

/**
 * Nobody answers a question or a permission request in a hidden session, and
 * a request left open would hold the pass until its timeout. So the session
 * denies everything, then allows what a pass needs: reading the project (never
 * its `.env` files), `git log` and `git show`, skills, the model, and Code Mode,
 * through which the memory tool is called. Session rules are read after the
 * agent's own, so an `ask` in the project's config cannot reach a person here.
 */
const DREAM_PERMISSIONS = [
  { action: '*', resource: '*', effect: 'deny' },
  { action: 'provider.use', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*.env', effect: 'deny' },
  { action: 'read', resource: '*.env.*', effect: 'deny' },
  { action: 'glob', resource: '*', effect: 'allow' },
  { action: 'grep', resource: '*', effect: 'allow' },
  { action: 'skill', resource: '*', effect: 'allow' },
  { action: 'execute', resource: '*', effect: 'allow' },
  { action: 'openchamber_*', resource: '*', effect: 'allow' },
  { action: 'shell', resource: 'git log*', effect: 'allow' },
  { action: 'shell', resource: 'git show*', effect: 'allow' },
]

const splitModel = (value) => {
  const text = asNonEmptyString(value);
  const slash = text ? text.indexOf('/') : -1;
  if (!text || slash <= 0 || slash === text.length - 1) return null;
  return { providerID: text.slice(0, slash), id: text.slice(slash + 1) };
};

const describeEntries = (entries) => entries.map((entry) => JSON.stringify({
  memoryId: entry.id,
  type: entry.type,
  title: entry.title,
  body: entry.body,
  updated: new Date(entry.updatedAt).toISOString().slice(0, 10),
  flagged: entry.flagged === true,
})).join('\n');

export const buildDreamPrompt = ({ directory, global, project, index }) => {
  const sections = [];
  if (project) sections.push(`## Project memory (scope "project", project at ${directory})\n\n${describeEntries(project) || '(empty)'}`);
  if (global) sections.push(`## The user's memory (scope "global")\n\n${describeEntries(global) || '(empty)'}`);
  // Merging merely related entries costs the index its specific titles, so it is done only to make room.
  const fit = index.omitted > 0
    ? `Sessions get every title in ${index.budget} characters, and ${index.omitted} titles do not fit now. Merge related entries into topical ones until every title fits: the one that stays gets a title naming the topic and a body keeping every detail that is still true. Never delete what is still true just to fit.`
    : `Sessions get every title in ${index.budget} characters, and all of them fit now. Keep entries that only touch the same topic apart: each title naming one thing is what tells a session which entry to read.`;
  return [
    'Tidy the agent memory below. This runs in the background: nobody reads this session, so never ask anything, and act only through the openchamber_memory tool. Do not save new entries: memory.save with a memoryId rewrites an entry, memory.delete removes one.',
    '',
    'Decide by evidence, whoever wrote an entry:',
    '- Project entries: check the files, commands, flags and decisions they name against the project (code, AGENTS.md, skills, module docs, git log). Delete an entry the project\'s code or agent docs already state, one about work that is finished, a one-off task state, or one a newer entry or the project contradicts. A thing gone from the code is a hint, not proof: a decision can outlive renamed code.',
    '- The user\'s entries cannot be checked against code: only merge duplicates and drop what a newer entry contradicts.',
    '- An entry nothing contradicts and nothing else holds stays, as it is.',
    '- Merge entries that say the same thing or overlap: rewrite the one that stays, by its memoryId (title at most 60 characters, no date; body at most 2000 characters, keeping every detail that is still true), then delete the others.',
    '- Rewrite an entry whose details went out of date with what is true now.',
    '- Leave flagged entries alone.',
    `- ${fit}`,
    '',
    'End your reply with one line and nothing after it: DREAM {"project": P, "global": G}, where P and G are how many entries of that scope you deleted because you folded them into another.',
    '',
    ...sections,
  ].join('\n');
};

/** The parts of OpenCode's message records a pass reads; anything else in them is left alone. */
const messageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('assistant'),
    finish: z.string().optional().catch(undefined),
    error: z.object({ message: z.string() }).optional().catch(undefined),
    content: z.array(z.object({ type: z.string(), text: z.string().optional().catch(undefined) })).catch([]),
  }),
  z.object({
    type: z.literal('idle'),
    outcome: z.string().optional().catch(undefined),
    error: z.object({ message: z.string() }).optional().catch(undefined),
  }),
]);
const messagesSchema = z.object({ data: z.array(z.unknown()) }).transform(({ data }) => data
  .map((message) => messageSchema.safeParse(message))
  .filter((parsed) => parsed.success)
  .map((parsed) => parsed.data));
/** `POST /api/session` answers `{ data: session }`; the id is all a pass keeps. */
const createdSessionSchema = z.union([
  z.object({ data: z.object({ id: z.string().min(1) }) }).transform(({ data }) => data.id),
  z.object({ id: z.string().min(1) }).transform(({ id }) => id),
]);

const mergedCountSchema = z.number().int().nonnegative().catch(0);
const mergedReportSchema = z.object({ project: mergedCountSchema, global: mergedCountSchema });

/** The agent's closing `DREAM {"project": P, "global": G}` line, newest answer first; none counts as 0 each. */
const readMergedCount = (messages) => {
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const part of message.content) {
      const match = part.type === 'text' && part.text ? /DREAM\s*(\{[^}]*\})/.exec(part.text) : null;
      if (!match) continue;
      try {
        const report = mergedReportSchema.safeParse(JSON.parse(match[1]));
        if (report.success) return report.data;
      } catch {
        // A malformed line counts as no report.
      }
    }
  }
  return { project: 0, global: 0 };
};

/**
 * Why the pass's turn failed, or null. A turn that ends on a provider error
 * (no credentials, retries used up) settles like a finished one; the newest
 * idle record and the last answer are what tell them apart.
 */
const readTurnFailure = (messages) => {
  const newestIdle = messages.find((message) => message.type === 'idle');
  if (newestIdle?.outcome === 'failed') return newestIdle.error?.message || 'The model run failed';
  const lastAnswer = messages.find((message) => message.type === 'assistant');
  if (!lastAnswer) return 'The model never answered';
  if (lastAnswer.finish === 'error') return lastAnswer.error?.message || 'The model run failed';
  return null;
};

/** What a pass changed in one scope, from the store before and after it. */
export const diffDream = (before, after) => {
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  let deleted = 0;
  let rewritten = 0;
  for (const entry of before) {
    const now = afterById.get(entry.id);
    if (!now) deleted += 1;
    else if (now.title !== entry.title || now.body !== entry.body || now.type !== entry.type) rewritten += 1;
  }
  return { deleted, rewritten };
};

export const createMemoryDreaming = (deps) => {
  const {
    agentMemoryRuntime,
    readSettings,
    resolveProjectId,
    measureIndex,
    hiddenSessions,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    emitMemoryChanged = () => {},
    isDirectoryTrusted = () => true,
    resolveSessionDefaults,
    isAutoModel = () => false,
    fetchImpl = fetch,
    now = () => Date.now(),
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (handle) => clearTimeout(handle),
    passTimeoutMs = PASS_TIMEOUT_MS,
    pollIntervalMs = POLL_INTERVAL_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    log = (message) => console.log(`[memory-dreaming] ${message}`),
  } = deps;

  let timer = null;
  let running = null;
  let stopped = true;
  let leftoversRemoved = false;

  const request = async (method, pathname, { directory, body, signal } = {}) => {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    const init = { method, headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
    if (body) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(buildOpenCodeUrl(pathname, ''), init);
    if (!response.ok) throw new Error(`${method} ${pathname} answered ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };

  const activeSessionIds = async () => {
    const answer = await request('GET', '/api/session/active');
    const data = isRecord(answer?.data) ? answer.data : isRecord(answer) ? answer : {};
    return Object.keys(data).filter((id) => !hiddenSessions.has(id));
  };

  /**
   * Sessions a pass left when its server stopped, found by kind and removed.
   * Tried on every look until one gets through, dreaming on or off: lists hide
   * them by kind meanwhile (`../opencode/hidden-sessions.js`).
   */
  const removeLeftovers = async () => {
    if (leftoversRemoved) return;
    let cursor = null;
    let complete = true;
    for (let page = 0; page < LEFTOVER_PAGES; page += 1) {
      const answer = await request('GET', `/api/session?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const sessions = Array.isArray(answer?.data) ? answer.data : Array.isArray(answer) ? answer : [];
      for (const session of sessions) {
        if (session?.metadata?.openchamber?.kind !== DREAM_SESSION_KIND || hiddenSessions.has(session.id)) continue;
        hiddenSessions.add(session.id);
        await request('DELETE', `/api/session/${encodeURIComponent(session.id)}`).catch(() => { complete = false; });
      }
      cursor = asNonEmptyString(answer?.cursor?.next);
      if (!cursor) break;
    }
    leftoversRemoved = complete;
  };

  const changedSince = (entries, lastRunAt) => entries.filter((entry) => entry.updatedAt > (lastRunAt ?? 0)).length;

  const scopeIsDue = (state, entries, overflows) => {
    if (entries.length === 0) return false;
    const wait = state.record?.status === 'failed' ? RETRY_AFTER_FAILURE_MS : DUE_AFTER_MS;
    if (state.lastRunAt !== null && now() - state.lastRunAt < wait) return false;
    return overflows || changedSince(entries, state.lastRunAt) >= MIN_CHANGED_ENTRIES;
  };

  /** The first project whose memory is due, with the global memory when that is due too. */
  const findDuePass = async (settings) => {
    const projects = Array.isArray(settings?.projects) ? settings.projects : [];
    const [globalMemory, globalState] = await Promise.all([
      agentMemoryRuntime.read({ scope: 'global' }),
      agentMemoryRuntime.readDreamState({ scope: 'global' }),
    ]);
    const candidates = [];
    for (const project of projects) {
      const directory = asNonEmptyString(project?.path);
      if (!directory || !(await isDirectoryTrusted(directory))) continue;
      const projectId = await resolveProjectId(directory).catch(() => '');
      if (!projectId) continue;
      const [memory, state] = await Promise.all([
        agentMemoryRuntime.read({ scope: 'project', projectId }),
        agentMemoryRuntime.readDreamState({ scope: 'project', projectId }),
      ]);
      candidates.push({ project, directory, projectId, entries: memory.entries, state });
    }
    // The project dreamed longest ago goes first, so none waits on the others.
    candidates.sort((left, right) => (left.state.lastRunAt ?? 0) - (right.state.lastRunAt ?? 0));

    const globalOverflows = measureIndex({ global: globalMemory.entries, project: [] }).omitted > 0;
    const globalDue = scopeIsDue(globalState, globalMemory.entries, globalOverflows);
    for (const candidate of candidates) {
      const overflows = measureIndex({ global: globalMemory.entries, project: candidate.entries }).omitted > 0;
      if (scopeIsDue(candidate.state, candidate.entries, overflows)) {
        return { ...candidate, includeProject: true, includeGlobal: globalDue, global: globalMemory.entries };
      }
    }
    if (globalDue && candidates.length > 0) {
      // The user's memory alone: it runs in the project used last, which needs no location of its own.
      const active = candidates.find((candidate) => candidate.project?.id === settings?.activeProjectId) ?? candidates[candidates.length - 1];
      return { ...active, includeProject: false, includeGlobal: true, global: globalMemory.entries };
    }
    return null;
  };

  const resolveModel = (settings, project) => {
    const chosen = splitModel(settings?.agentMemoryDreamingModel);
    if (chosen) {
      const variant = asNonEmptyString(settings?.agentMemoryDreamingVariant);
      if (variant) chosen.variant = variant;
      return chosen;
    }
    const defaults = resolveSessionDefaults({ settings, project });
    if (!defaults.providerID || !defaults.modelID) return null;
    // The Auto sentinel is no model OpenCode knows; without one it picks its own default.
    if (isAutoModel({ providerID: defaults.providerID, modelID: defaults.modelID })) return null;
    const model = { providerID: defaults.providerID, id: defaults.modelID };
    if (defaults.variant) model.variant = defaults.variant;
    return model;
  };

  const runPass = async (settings, pass) => {
    const { directory, projectId, includeProject, includeGlobal } = pass;
    const targets = [
      ...(includeProject ? [{ key: 'project', target: { scope: 'project', projectId } }] : []),
      ...(includeGlobal ? [{ key: 'global', target: { scope: 'global' } }] : []),
    ];
    const before = {};
    for (const { key, target } of targets) before[key] = (await agentMemoryRuntime.read(target)).entries;

    let sessionID = null;
    const model = resolveModel(settings, pass.project);
    let error = null;
    let merged = { project: 0, global: 0 };
    const controller = new AbortController();
    const timeout = setTimer(() => controller.abort(), passTimeoutMs);
    try {
      // `hidden` keeps the session from every client from its first event on
      // (`../opencode/hidden-sessions.js`); the kind is how a leftover is found.
      const session = {
        title: 'Memory dreaming',
        location: { directory },
        metadata: { hidden: true, openchamber: { kind: DREAM_SESSION_KIND } },
        permissions: DREAM_PERMISSIONS,
      };
      // Without a model OpenCode starts the session on its own default.
      if (model) session.model = model;
      const created = createdSessionSchema.safeParse(await request('POST', '/api/session', { directory, body: session }));
      if (!created.success) throw new Error('OpenCode did not say which session it created');
      sessionID = created.data;
      hiddenSessions.add(sessionID);
      await request('POST', `/api/session/${sessionID}/prompt`, {
        directory,
        body: {
          text: buildDreamPrompt({
            directory,
            project: includeProject ? before.project : null,
            global: includeGlobal ? before.global : null,
            index: measureIndex({ global: before.global ?? pass.global, project: before.project ?? pass.entries }),
          }),
        },
      });
      // Done once the turn was seen running and is no longer, or was never seen in the grace period.
      const promptedAt = now();
      let seenRunning = false;
      for (;;) {
        await new Promise((resolve) => setTimer(resolve, pollIntervalMs));
        if (controller.signal.aborted) throw new Error('aborted');
        const active = await request('GET', '/api/session/active', { signal: controller.signal });
        const data = isRecord(active?.data) ? active.data : isRecord(active) ? active : {};
        if (data[sessionID]) seenRunning = true;
        else if (seenRunning || now() - promptedAt > START_GRACE_MS) break;
      }
      const answer = messagesSchema.safeParse(await request('GET', `/api/session/${sessionID}/message`, { directory }));
      if (!answer.success) throw new Error('Could not read how the pass ended');
      const messages = answer.data;
      const failure = readTurnFailure(messages);
      if (failure) throw new Error(failure);
      merged = readMergedCount(messages);
    } catch (caught) {
      error = controller.signal.aborted ? 'The pass did not finish in time' : (caught instanceof Error ? caught.message : String(caught));
      if (sessionID) await request('POST', `/api/session/${sessionID}/interrupt`, { directory }).catch(() => {});
    } finally {
      clearTimer(timeout);
      // Stays registered as hidden: events after the delete, or a session whose delete failed, stay unseen.
      if (sessionID) {
        await request('DELETE', `/api/session/${sessionID}`).catch(() => {
          leftoversRemoved = false;
        });
      }
    }

    // Recorded even when the pass failed: what it changed before failing can be undone.
    const finishedAt = now();
    for (const { key, target } of targets) {
      const after = (await agentMemoryRuntime.read(target)).entries;
      const { deleted, rewritten } = diffDream(before[key], after);
      const mergedHere = Math.min(merged[key], deleted);
      const changed = deleted + rewritten > 0;
      await agentMemoryRuntime.recordDream(target, {
        lastRunAt: finishedAt,
        record: {
          finishedAt,
          status: error ? 'failed' : 'done',
          merged: mergedHere,
          removed: deleted - mergedHere,
          rewritten,
          error,
        },
        snapshot: changed ? before[key] : null,
        after: changed ? after.map((entry) => ({ id: entry.id, updatedAt: entry.updatedAt })) : null,
      });
      emitMemoryChanged(key === 'project' ? { scope: 'project', projectId } : { scope: 'global' });
    }
    log(error ? `pass in ${directory} failed: ${error}` : `pass in ${directory} done`);
    return { error };
  };

  const schedule = (ms) => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void check();
    }, ms);
    timer?.unref?.();
  };

  /** One look: a pass when one is due and nothing runs, then the next look. */
  const check = async () => {
    if (running) return running;
    running = (async () => {
      let next = CHECK_INTERVAL_MS;
      try {
        await removeLeftovers().catch(() => {});
        const settings = await readSettings();
        if (settings?.agentMemoryToolEnabled !== true || settings?.agentMemoryDreamingEnabled !== true) return;
        if ((await activeSessionIds()).length > 0) return;
        const pass = await findDuePass(settings);
        if (!pass) return;
        await runPass(settings, pass);
        next = FOLLOW_UP_DELAY_MS;
      } catch (caught) {
        log(`check failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      } finally {
        running = null;
        schedule(next);
      }
    })();
    return running;
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(START_DELAY_MS);
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    check,
  };
};
