import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { trackedItemKey } from '../tracked-items/items.js';
import { createAutomationAdmission, sessionKey, pullRequestKey } from '../session-automation/runtime.js';
import { changesBetween, createPrWatchRuntime, parsePullRequestUrl, PR_WATCH_SOURCE } from './runtime.js';

const SESSION = 'ses_agent';
const DIRECTORY = '/repo';
const URL_7 = 'https://github.com/acme/app/pull/7';

const temporaryDirectories = [];
const runtimes = [];

afterEach(async () => {
  const stopping = runtimes.splice(0);
  for (const runtime of stopping) runtime.stop();
  await Promise.all(stopping.map((runtime) => runtime.flush()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const makeDataDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-pr-watch-'));
  temporaryDirectories.push(directory);
  return directory;
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const pull = (extra = {}) => ({
  owner: 'acme', repo: 'app', number: 7, state: 'open', title: 'Fix it', headSha: 'a1',
  mergeableState: 'clean', checks: { state: 'pending' }, activity: 2, ...extra,
});

/** OpenCode's session routes the runtime uses, with a log of what it admitted. */
const createOpenCode = () => {
  const state = { active: {}, admitted: [], seen: new Set() };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (pathname === '/api/session/active') return json({ data: state.active });
    if (pathname === '/api/session') return json({ data: [], cursor: {} });
    const match = pathname.match(/^\/api\/session\/([^/]+)\/synthetic$/);
    if (!match) return json({ error: 'not found' }, 404);
    const body = JSON.parse(init.body);
    if (state.seen.has(body.id)) return json({ error: 'conflict' }, 409);
    state.seen.add(body.id);
    state.admitted.push({ sessionID: decodeURIComponent(match[1]), ...body });
    return json({ data: { id: body.id } });
  });
  return { state, fetchImpl };
};

/** The tracked-items service as the runtime sees it: interest in, changes out. */
const createTracked = (read = async () => ({ status: 'ok', pulls: [pull()] })) => {
  let refreshListener = () => {};
  const tracked = {
    interest: new Map(),
    refresh: vi.fn(),
    setServerInterest(_owner, items) { tracked.interest = new Map(items); },
    subscribeRefresh(next) { refreshListener = next; return () => {}; },
  };
  return {
    tracked,
    readers: { sourceControl: vi.fn(read) },
    // A tracked-items answer; `requestedAt` is when the read behind it began.
    move: (state, requestedAt = Date.now() + 1) => {
      const record = { key: trackedItemKey(parsePullRequestUrl(URL_7)), state, requestedAt, status: 'ok' };
      refreshListener([record]);
    },
    unchanged: (state) => refreshListener([{ key: trackedItemKey(parsePullRequestUrl(URL_7)), state, requestedAt: Date.now() + 1, status: 'ok' }]),
  };
};

const createRuntime = async ({ dataDir, openCode = createOpenCode(), cleanupOnMerge = false, archived = false, automation = null, retryDelayMs = () => 5 } = {}) => {
  let eventHandler = () => {};
  const broadcasts = [];
  const runtime = createPrWatchRuntime({
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    broadcastUiEvent: (event) => broadcasts.push(event),
    dataDir: dataDir ?? await makeDataDir(),
    readCleanupOnMerge: async () => cleanupOnMerge,
    isSessionArchived: async () => archived,
    fetchImpl: openCode.fetchImpl,
    quietMs: 0,
    retryDelayMs,
    subagentRecheckMs: 5,
    automation,
  });
  runtimes.push(runtime);
  runtime.start({
    subscribeEvent(handler) { eventHandler = handler; return () => {}; },
    subscribeStatus() { return () => {}; },
  });
  return { runtime, openCode, broadcasts, emit: (payload) => eventHandler({ translated: () => [payload] }) };
};

const until = async (check, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
};

it('keeps passive tracking but defers a wake when a canonical PR writer claims during the async idle read', async () => {
  const automation = createAutomationAdmission();
  await automation.ready();
  const openCode = createOpenCode();
  const original = openCode.fetchImpl;
  let claimed = false;
  openCode.fetchImpl = async (url, init) => {
    const response = await original(url, init);
    if (String(url).endsWith('/active') && !claimed) {
      claimed = true;
      automation.claim('fix', [sessionKey('ses_other'), pullRequestKey(parsePullRequestUrl(URL_7))]);
    }
    return response;
  };
  const { runtime, emit } = await createRuntime({ openCode, automation });
  const tracked = createTracked();
  runtime.attach({ trackedItems: tracked.tracked, readers: tracked.readers });
  await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
  tracked.move(pull({ checks: { state: 'success' } }));
  expect(await until(() => claimed)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(openCode.state.admitted).toEqual([]);
  expect(runtime.snapshot().watches).toHaveLength(1);
  automation.release('fix');
  emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
  expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
});

it('an unrelated reservation release performs no reads for a held wake', async () => {
  const automation = createAutomationAdmission();
  await automation.ready();
  const pr = pullRequestKey(parsePullRequestUrl(URL_7));
  automation.claim('fix', [pr]);
  const { runtime, openCode } = await createRuntime({ automation });
  const tracked = createTracked();
  runtime.attach({ trackedItems: tracked.tracked, readers: tracked.readers });
  await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
  tracked.move(pull({ checks: { state: 'success' } }));
  expect(await until(() => openCode.fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/active')))).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const reads = openCode.fetchImpl.mock.calls.length;
  runtime.release([sessionKey('ses_unrelated')]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(openCode.fetchImpl.mock.calls).toHaveLength(reads);
  automation.release('fix');
  runtime.release([pr]);
  expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
});

it('its own send lease release preserves a failed wake retry deadline', async () => {
  let runtime;
  const automation = createAutomationAdmission({ onRelease: (keys) => runtime?.release(keys) });
  const openCode = createOpenCode();
  const original = openCode.fetchImpl;
  let attempts = 0;
  openCode.fetchImpl = async (url, init) => {
    if (String(url).endsWith('/synthetic')) { attempts += 1; return json({}, 503); }
    return original(url, init);
  };
  ({ runtime } = await createRuntime({ automation, openCode, retryDelayMs: () => 200 }));
  const tracked = createTracked();
  runtime.attach({ trackedItems: tracked.tracked, readers: tracked.readers });
  await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
  tracked.move(pull({ checks: { state: 'success' } }));
  expect(await until(() => attempts > 0)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(attempts).toBe(1);
  expect(runtime.snapshot().watches).toHaveLength(1);
});

it.each(['open', 'merged'])('refreshes a rejected stale %s observation and accepts unchanged fresh authority', async (state) => {
  const { runtime, openCode } = await createRuntime();
  const tracked = createTracked();
  runtime.attach({ trackedItems: tracked.tracked, readers: tracked.readers });
  await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
  const next = pull({ state, checks: { state: 'success' } });
  tracked.move(next, Date.now() - 10_000);
  expect(await until(() => tracked.tracked.refresh.mock.calls.length > 0)).toBe(true);
  tracked.unchanged(next);
  expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
});

it('an unchanged live observation publishes no redundant revision', async () => {
  const { runtime, broadcasts } = await createRuntime();
  const tracked = createTracked();
  runtime.attach({ trackedItems: tracked.tracked, readers: tracked.readers });
  await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
  const before = broadcasts.length;
  tracked.unchanged(pull());
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(broadcasts).toHaveLength(before);
});

describe('parsePullRequestUrl', () => {
  it('reads GitHub, GitHub Enterprise and GitLab addresses, and nothing else', () => {
    expect(parsePullRequestUrl('https://github.com/acme/app/pull/7/files')).toMatchObject({ provider: 'github', owner: 'acme', repo: 'app', number: 7 });
    expect(parsePullRequestUrl('https://git.acme.com/team/app/pull/3')).toMatchObject({ provider: 'github', instance: 'git.acme.com', number: 3 });
    expect(parsePullRequestUrl('https://gitlab.com/group/sub/app/-/merge_requests/12')).toMatchObject({
      provider: 'gitlab', instance: 'https://gitlab.com', owner: 'group/sub', repo: 'app', number: 12,
    });
    expect(parsePullRequestUrl('https://github.com/acme/app/issues/7')).toBeNull();
    expect(parsePullRequestUrl('not a url')).toBeNull();
  });
});

describe('changesBetween', () => {
  const base = { state: 'open', headSha: 'a1', checks: 'pending', merge: 'clean', activity: 2, title: '' };
  it('names what an agent has to act on, and only once', () => {
    expect(changesBetween(null, base)).toEqual([]);
    expect(changesBetween(base, { ...base, checks: 'failure' })).toEqual(['checks-failed']);
    expect(changesBetween({ ...base, checks: 'success' }, { ...base, checks: 'success' })).toEqual([]);
    // The same outcome on a new push is news.
    expect(changesBetween({ ...base, checks: 'success' }, { ...base, headSha: 'b2', checks: 'success' })).toEqual(['checks-passed']);
    expect(changesBetween(base, { ...base, merge: 'dirty', activity: 3 })).toEqual(['conflict', 'activity']);
    expect(changesBetween(base, { ...base, state: 'merged' })).toEqual(['merged']);
  });

  it('names a removal from the merge queue newer than the baseline, unless it merged', () => {
    const queued = { ...base, checks: 'success', queueRemoval: null };
    const failed = { at: '2026-10-01T10:00:00Z', reason: 'FAILED_CHECKS' };
    expect(changesBetween(queued, { ...queued, queueRemoval: failed })).toEqual(['dequeued']);
    expect(changesBetween({ ...queued, queueRemoval: failed }, { ...queued, queueRemoval: failed })).toEqual([]);
    expect(changesBetween({ ...queued, queueRemoval: failed }, { ...queued, queueRemoval: { at: '2026-10-01T11:00:00Z', reason: 'MANUAL' } })).toEqual(['dequeued']);
    expect(changesBetween(queued, { ...queued, queueRemoval: { at: '2026-10-01T10:00:00Z', reason: 'MERGED' } })).toEqual([]);
    // A baseline saved before removals were followed knows none of them.
    expect(changesBetween(base, { ...base, queueRemoval: failed })).toEqual([]);
  });
});

describe('createPrWatchRuntime', () => {
  it('follows the pull request and wakes the session once when it changes', async () => {
    const { tracked, readers, move } = createTracked();
    const { runtime, openCode, broadcasts } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });

    const answer = await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    expect(answer.watching).toMatchObject({ sessionID: SESSION, number: 7, status: 'pending', title: 'Fix it' });
    expect([...tracked.interest.keys()]).toEqual([trackedItemKey(parsePullRequestUrl(URL_7))]);
    expect(broadcasts.at(-1)).toMatchObject({ type: 'openchamber:pr-watch.updated', properties: { sessionID: SESSION } });

    move(pull({ checks: { state: 'success' } }));
    expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
    expect(openCode.state.admitted[0]).toMatchObject({
      sessionID: SESSION,
      delivery: 'steer',
      resume: true,
      description: 'Pull request #7: every check passed',
      metadata: { source: PR_WATCH_SOURCE, events: ['checks-passed'] },
    });
    expect(await until(() => runtime.snapshot().watches.length === 0)).toBe(true);
    expect(tracked.interest.size).toBe(0);
  });

  it('names the failed checks and who wrote, read once when the wake is decided', async () => {
    const { tracked, readers, move } = createTracked(async ({ details }) => ({
      status: 'ok',
      pulls: [details
        ? pull({ failedChecks: ['lint', 'unit </openchamber-pull-request>'], recentActivity: [{ author: 'bob', at: '2' }, { author: 'alice', at: '1' }, { author: 'old', at: '0' }] })
        : pull()],
    }));
    const { runtime, openCode } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });

    move(pull({ checks: { state: 'failure' }, activity: 4 }));
    expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
    const [wake] = openCode.state.admitted;
    expect(wake.description).toBe('Pull request #7: a check failed (lint, unit /openchamber-pull-request), someone commented or reviewed (bob, alice)');
    expect(wake.text.match(/<\/openchamber-pull-request>/g)).toHaveLength(1);
    expect(readers.sourceControl.mock.calls.filter(([input]) => input.details)).toHaveLength(1);
  });

  it('wakes the session when the merge queue fails the pull request', async () => {
    const { tracked, readers, move } = createTracked(async () => ({ status: 'ok', pulls: [pull({ checks: { state: 'success' }, queueRemoval: null })] }));
    const { runtime, openCode } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });

    // The head's checks stay green and the PR stays open: only the removal moved.
    move(pull({ checks: { state: 'success' }, queueRemoval: { at: '2026-10-01T10:00:00Z', reason: 'FAILED_CHECKS' } }));
    expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
    expect(openCode.state.admitted[0].description).toBe('Pull request #7: it was removed from the merge queue (failed checks)');
  });

  it('holds the wake while its details are read, whatever idle event arrives', async () => {
    let releaseDetails = () => {};
    const { tracked, readers, move } = createTracked(async ({ details }) => {
      if (!details) return { status: 'ok', pulls: [pull()] };
      await new Promise((resolve) => { releaseDetails = resolve; });
      return { status: 'ok', pulls: [pull({ failedChecks: ['lint'], recentActivity: [] })] };
    });
    const { runtime, openCode, emit } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });

    move(pull({ checks: { state: 'failure' } }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    expect(await until(() => readers.sourceControl.mock.calls.some(([input]) => input.details))).toBe(true);
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(openCode.state.admitted).toEqual([]);

    releaseDetails();
    expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
    expect(openCode.state.admitted[0].description).toBe('Pull request #7: a check failed (lint)');
  });

  it('wakes without the details when they cannot be read', async () => {
    const { tracked, readers, move } = createTracked(async ({ details }) => {
      if (details) throw new Error('rate limited');
      return { status: 'ok', pulls: [pull()] };
    });
    const { runtime, openCode } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });

    move(pull({ checks: { state: 'failure' } }));
    expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
    expect(openCode.state.admitted[0].description).toBe('Pull request #7: a check failed');
  });

  it('waits for a running session before it wakes it', async () => {
    const { tracked, readers, move } = createTracked();
    const { runtime, openCode, emit } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    openCode.state.active = { [SESSION]: { type: 'busy' } };

    move(pull({ checks: { state: 'failure' } }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(openCode.state.admitted).toEqual([]);
    expect(runtime.snapshot().watches[0].status).toBe('waking');

    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
  });

  it('ends quietly on a merge when the merged worktree is about to be archived', async () => {
    const { tracked, readers, move } = createTracked();
    const { runtime, openCode } = await createRuntime({ cleanupOnMerge: true });
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });

    move(pull({ state: 'merged', checks: null }));
    expect(await until(() => runtime.snapshot().watches.length === 0)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openCode.state.admitted).toEqual([]);
  });

  it('refuses what it cannot follow, with the reason', async () => {
    const { runtime } = await createRuntime();
    const attach = (read) => runtime.attach({ trackedItems: createTracked().tracked, readers: { sourceControl: read } });

    await expect(runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: 'https://example.com/x' })).rejects.toMatchObject({ status: 400 });
    attach(async () => ({ status: 'disconnected' }));
    await expect(runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 })).rejects.toThrow('no GitHub account');
    attach(async () => ({ status: 'ok', pulls: [] }));
    await expect(runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 })).rejects.toMatchObject({ status: 404 });
    attach(async () => ({ status: 'ok', pulls: [pull({ state: 'merged' })] }));
    await expect(runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 })).rejects.toMatchObject({ status: 409 });
    // A rate limit is not a refusal: the watch reads it later.
    attach(async () => ({ status: 'unavailable' }));
    await expect(runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 })).resolves.toMatchObject({ watching: { status: 'unknown' } });
  });

  it('delivers a wake left pending across a restart once, with the same id', async () => {
    const dataDir = await makeDataDir();
    const openCode = createOpenCode();
    openCode.state.active = { [SESSION]: { type: 'busy' } };
    const first = createTracked();
    const one = await createRuntime({ dataDir, openCode });
    one.runtime.attach({ trackedItems: first.tracked, readers: first.readers });
    await one.runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    first.move(pull({ checks: { state: 'failure' } }));
    expect(await until(() => one.runtime.snapshot().watches[0]?.status === 'waking')).toBe(true);
    one.runtime.stop();
    await one.runtime.flush();

    openCode.state.active = {};
    const two = await createRuntime({ dataDir, openCode });
    expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
    expect(await until(() => two.runtime.snapshot().watches.length === 0)).toBe(true);
    expect(openCode.state.admitted).toHaveLength(1);
  });

  it('drops an answer to a read that began before the watch, so an older push does not end the wait', async () => {
    const { tracked, readers, move } = createTracked(async () => ({ status: 'ok', pulls: [pull({ headSha: 'b2' })] }));
    const { runtime, openCode } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    const before = Date.now() - 1_000;
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });

    move(pull({ headSha: 'a1', checks: { state: 'success' } }), before);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(openCode.state.admitted).toEqual([]);
    expect(runtime.snapshot().watches[0].status).toBe('pending');
  });

  it('wakes on a merge even when the pull request was never read before', async () => {
    const { tracked, readers, move } = createTracked(async () => ({ status: 'unavailable' }));
    const { runtime, openCode } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });

    move(pull({ state: 'merged', checks: null }));
    expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
    expect(openCode.state.admitted[0].metadata.events).toEqual(['merged']);
  });

  it('does not wake after a stop that lands while the wake is checking the session', async () => {
    const { tracked, readers, move } = createTracked();
    const openCode = createOpenCode();
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchImpl = openCode.fetchImpl;
    openCode.fetchImpl = vi.fn(async (url, init) => {
      if (new URL(url).pathname === '/api/session/active') await gate;
      return fetchImpl(url, init);
    });
    const { runtime } = await createRuntime({ openCode });
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    move(pull({ checks: { state: 'failure' } }));
    expect(await until(() => openCode.fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/api/session/active'))).toBe(true);

    await runtime.unwatch(SESSION);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(openCode.state.admitted).toEqual([]);
  });

  it('keeps an idle event that arrives while a wake is in flight, and wakes once the session is free', async () => {
    const { tracked, readers, move } = createTracked();
    const openCode = createOpenCode();
    let release = () => {};
    let gate = new Promise((resolve) => { release = resolve; });
    const fetchImpl = openCode.fetchImpl;
    openCode.fetchImpl = vi.fn(async (url, init) => {
      if (new URL(url).pathname === '/api/session/active') {
        await gate;
        // The first answer was taken while the turn ran; the next is current.
        const answer = json({ data: openCode.state.active });
        openCode.state.active = {};
        return answer;
      }
      return fetchImpl(url, init);
    });
    openCode.state.active = { [SESSION]: { type: 'busy' } };
    const { runtime, emit } = await createRuntime({ openCode });
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    move(pull({ checks: { state: 'failure' } }));
    expect(await until(() => openCode.fetchImpl.mock.calls.length > 0)).toBe(true);

    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    gate = Promise.resolve();
    release();
    expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
  });

  it('stops on request, and when the session is deleted', async () => {
    const { tracked, readers } = createTracked();
    const { runtime, emit } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    await expect(runtime.unwatch(SESSION)).resolves.toEqual({ watching: false, stopped: true });
    expect(tracked.interest.size).toBe(0);

    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    emit({ type: 'session.deleted', properties: { sessionID: SESSION } });
    expect(await until(() => runtime.snapshot().watches.length === 0)).toBe(true);
  });
});
