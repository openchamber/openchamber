import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { trackedItemKey } from '../tracked-items/items.js';
import { changesBetween, createPrWatchRuntime, parsePullRequestUrl, PR_WATCH_SOURCE, registerPrWatchRoutes } from './runtime.js';

const SESSION = 'ses_agent';
const DIRECTORY = '/repo';
const URL_7 = 'https://github.com/acme/app/pull/7';
const URL_8 = 'https://github.com/acme/app/pull/8';

const temporaryDirectories = [];
const runtimes = [];

const createSignal = () => {
  const listeners = new Set();
  return {
    notify() { for (const listener of listeners) listener(); },
    until(check) {
      if (check()) return Promise.resolve(true);
      return new Promise((resolve) => {
        const listener = () => {
          if (!check()) return;
          listeners.delete(listener);
          resolve(true);
        };
        listeners.add(listener);
      });
    },
  };
};

afterEach(async () => {
  const stopping = runtimes.splice(0);
  for (const runtime of stopping) runtime.stop();
  await Promise.all(stopping.map((runtime) => runtime.flush()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  vi.useRealTimers();
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
  const signal = createSignal();
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
    signal.notify();
    return json({ data: { id: body.id } });
  });
  return { state, fetchImpl, until: signal.until };
};

/** The tracked-items service as the runtime sees it: interest in, changes out. */
const createTracked = (read = async () => ({ status: 'ok', pulls: [pull()] })) => {
  let listener = () => {};
  const tracked = {
    interest: new Map(),
    setServerInterest(_owner, items) { tracked.interest = new Map(items); },
    subscribe(next) { listener = next; return () => {}; },
  };
  return {
    tracked,
    readers: { sourceControl: vi.fn(read) },
    // A tracked-items answer; `requestedAt` is when the read behind it began.
    move: (state, requestedAt = Date.now() + 1, url = URL_7) => listener([{ key: trackedItemKey(parsePullRequestUrl(url)), state, requestedAt }]),
  };
};

const createRuntime = async ({ dataDir, openCode = createOpenCode(), cleanupOnMerge = false, archived = false, isSessionArchived = async () => archived } = {}) => {
  let eventHandler = () => {};
  const broadcasts = [];
  const signal = createSignal();
  const runtime = createPrWatchRuntime({
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    broadcastUiEvent: (event) => { broadcasts.push(event); signal.notify(); },
    dataDir: dataDir ?? await makeDataDir(),
    readCleanupOnMerge: async () => cleanupOnMerge,
    isSessionArchived,
    fetchImpl: openCode.fetchImpl,
    quietMs: 0,
    retryDelayMs: () => 5,
  });
  runtimes.push(runtime);
  runtime.start({
    subscribeEvent(handler) { eventHandler = handler; return () => {}; },
    subscribeStatus() { return () => {}; },
  });
  return { runtime, openCode, broadcasts, until: signal.until, emit: (payload) => eventHandler({ translated: () => [payload] }) };
};

const until = async (check, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
};

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
});

describe('registerPrWatchRoutes', () => {
  const request = { params: { sessionID: SESSION }, query: {} };
  const createRoutes = (runtime) => {
    const handlers = new Map();
    registerPrWatchRoutes({
      get(route, handler) { handlers.set(`GET ${route}`, handler); },
      delete(route, handler) { handlers.set(`DELETE ${route}`, handler); },
    }, runtime);
    const response = { status: vi.fn(() => response), json: vi.fn() };
    return { handlers, response };
  };

  it.each([
    [Object.assign(new Error('unreadable'), { status: 503 }), 503, 'unreadable'],
    [{ status: 400, message: 7 }, 400, 7],
    [Object.assign(() => {}, { status: 409, message: 'conflict' }), 409, 'conflict'],
    [{ status: '404', message: 'failed' }, 500, 'failed'],
    [{ status: 400.5 }, 500, 'Failed to load pull request watches'],
    ['unavailable', 500, 'Failed to load pull request watches'],
  ])('preserves error status and message for %j', async (error, status, message) => {
    const { handlers, response } = createRoutes({ load: async () => { throw error; } });
    await handlers.get('GET /api/pr-watch')(request, response);
    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json).toHaveBeenCalledWith({ error: message });
  });

  it('passes the supplied query value through to unwatch', async () => {
    const result = { watching: [], stopped: true };
    const unwatch = vi.fn(async () => result);
    const { handlers, response } = createRoutes({ unwatch });
    await handlers.get('DELETE /api/pr-watch/sessions/:sessionID')({ ...request, query: { url: ['invalid'] } }, response);
    expect(unwatch).toHaveBeenCalledWith(SESSION, ['invalid']);
    expect(response.json).toHaveBeenCalledWith(result);
  });
});

describe('createPrWatchRuntime', () => {
  it('follows the pull request and wakes the session once when it changes', async () => {
    const { tracked, readers, move } = createTracked();
    const { runtime, openCode, broadcasts, until } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });

    const answer = await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    expect(answer.watching).toMatchObject({ sessionID: SESSION, number: 7, status: 'pending', title: 'Fix it' });
    expect([...tracked.interest.keys()]).toEqual([trackedItemKey(parsePullRequestUrl(URL_7))]);
    expect(broadcasts.at(-1)).toMatchObject({ type: 'openchamber:pr-watch.updated', properties: { sessionID: SESSION } });

    move(pull({ checks: { state: 'success' } }));
    expect(await openCode.until(() => openCode.state.admitted.length === 1)).toBe(true);
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
    expect(await openCode.until(() => openCode.state.admitted.length === 1)).toBe(true);
    const [wake] = openCode.state.admitted;
    expect(wake.description).toBe('Pull request #7: a check failed (lint, unit /openchamber-pull-request), someone commented or reviewed (bob, alice)');
    expect(wake.text.match(/<\/openchamber-pull-request>/g)).toHaveLength(1);
    expect(wake.metadata).toMatchObject({ failedChecks: ['lint', 'unit /openchamber-pull-request'], authors: ['bob', 'alice'] });
    expect(readers.sourceControl.mock.calls.filter(([input]) => input.details)).toHaveLength(1);
  });

  it('holds the wake while its details are read, whatever idle event arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const detailsStarted = Promise.withResolvers();
    let releaseDetails = () => {};
    const { tracked, readers, move } = createTracked(async ({ details }) => {
      if (!details) return { status: 'ok', pulls: [pull()] };
      detailsStarted.resolve();
      await new Promise((resolve) => { releaseDetails = resolve; });
      return { status: 'ok', pulls: [pull({ failedChecks: ['lint'], recentActivity: [] })] };
    });
    const { runtime, openCode, emit } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });

    move(pull({ checks: { state: 'failure' } }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await detailsStarted.promise;
    expect(readers.sourceControl.mock.calls.some(([input]) => input.details)).toBe(true);
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await vi.advanceTimersByTimeAsync(0);
    await runtime.flush();
    expect(openCode.state.admitted).toEqual([]);

    vi.useRealTimers();
    releaseDetails();
    expect(await openCode.until(() => openCode.state.admitted.length === 1)).toBe(true);
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
    expect(await openCode.until(() => openCode.state.admitted.length === 1)).toBe(true);
    expect(openCode.state.admitted[0].description).toBe('Pull request #7: a check failed');
  });

  it('wakes the session at once, also while its turn runs', async () => {
    const { tracked, readers, move } = createTracked();
    const { runtime, openCode } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    openCode.state.active = { [SESSION]: { type: 'busy' } };

    move(pull({ checks: { state: 'failure' } }));
    expect(await until(() => openCode.state.admitted.length === 1)).toBe(true);
    expect(openCode.state.admitted[0]).toMatchObject({ delivery: 'steer', resume: true });
  });

  it('ends quietly on a merge when the merged worktree is about to be archived', async () => {
    const { tracked, readers, move } = createTracked();
    const { runtime, openCode, until } = await createRuntime({ cleanupOnMerge: true });
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });

    move(pull({ state: 'merged', checks: null }));
    expect(await until(() => runtime.snapshot().watches.length === 0)).toBe(true);
    await runtime.flush();
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
    expect(await one.until(() => one.runtime.snapshot().watches[0]?.status === 'waking')).toBe(true);
    one.runtime.stop();
    await one.runtime.flush();

    openCode.state.active = {};
    const two = await createRuntime({ dataDir, openCode });
    expect(await openCode.until(() => openCode.state.admitted.length === 1)).toBe(true);
    expect(await two.until(() => two.runtime.snapshot().watches.length === 0)).toBe(true);
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
    expect(await openCode.until(() => openCode.state.admitted.length === 1)).toBe(true);
    expect(openCode.state.admitted[0].metadata.events).toEqual(['merged']);
  });

  it('does not wake after a stop that lands while the wake is checking the session', async () => {
    const { tracked, readers, move } = createTracked();
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const checking = Promise.withResolvers();
    const { runtime, openCode } = await createRuntime({
      isSessionArchived: async () => {
        checking.resolve();
        await gate;
        return false;
      },
    });
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    move(pull({ checks: { state: 'failure' } }));
    await checking.promise;

    await runtime.unwatch(SESSION);
    release();
    await runtime.flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(openCode.state.admitted).toEqual([]);
  });

  it('stops on request, and when the session is deleted', async () => {
    const { tracked, readers } = createTracked();
    const { runtime, emit, until } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    await expect(runtime.unwatch(SESSION)).resolves.toEqual({ watching: [], stopped: true });
    expect(tracked.interest.size).toBe(0);

    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    emit({ type: 'session.deleted', properties: { sessionID: SESSION } });
    expect(await until(() => runtime.snapshot().watches.length === 0)).toBe(true);
  });

  const readEach = async ({ pulls }) => ({ status: 'ok', pulls: pulls.map(({ number }) => pull({ number })) });

  it('waits on several pull requests of one session, and each wakes it on its own', async () => {
    const { tracked, readers, move } = createTracked(readEach);
    const openCode = createOpenCode();
    const admit = openCode.fetchImpl;
    openCode.fetchImpl = vi.fn(async (url, init) => {
      const response = await admit(url, init);
      // An admitted wake starts a turn.
      if (new URL(url).pathname.endsWith('/synthetic')) openCode.state.active = { [SESSION]: { type: 'busy' } };
      return response;
    });
    const { runtime, broadcasts, emit } = await createRuntime({ openCode });
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_8 });
    // Watching one again renews it alone.
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    expect(runtime.snapshot().watches.map((watch) => watch.number)).toEqual([8, 7]);
    expect(broadcasts.at(-1).properties.watches.map((watch) => watch.number)).toEqual([8, 7]);
    expect(tracked.interest.size).toBe(2);

    move(pull({ checks: { state: 'failure' } }));
    move(pull({ number: 8, checks: { state: 'success' } }), undefined, URL_8);
    // The second wake steers into the turn the first one started.
    expect(await until(() => openCode.state.admitted.length === 2)).toBe(true);
    expect(openCode.state.admitted.map((wake) => wake.metadata.url).sort()).toEqual([URL_7, URL_8]);
    expect(await until(() => runtime.snapshot().watches.length === 0)).toBe(true);
  });

  it('steers a second wake into the first one\'s turn when OpenCode reports it busy late, and loses neither', async () => {
    const { tracked, readers, move } = createTracked(readEach);
    // OpenCode never shows the turn the first wake started as running by the
    // time the second wake asks, so the second one is admitted right away.
    const { runtime, openCode, until } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_8 });

    move(pull({ checks: { state: 'failure' } }));
    expect(await openCode.until(() => openCode.state.admitted.length === 1)).toBe(true);
    move(pull({ number: 8, checks: { state: 'success' } }), undefined, URL_8);
    expect(await openCode.until(() => openCode.state.admitted.length === 2)).toBe(true);

    expect(openCode.state.admitted.map((wake) => wake.metadata.url)).toEqual([URL_7, URL_8]);
    expect(openCode.state.admitted.every((wake) => wake.delivery === 'steer' && wake.resume === true)).toBe(true);
    expect(new Set(openCode.state.admitted.map((wake) => wake.id)).size).toBe(2);
    expect(await until(() => runtime.snapshot().watches.length === 0)).toBe(true);
  });

  it('gives up one pull request\'s wake without stranding the next one of the session', async () => {
    const { tracked, readers, move } = createTracked(readEach);
    const openCode = createOpenCode();
    const admit = openCode.fetchImpl;
    openCode.fetchImpl = vi.fn(async (url, init) => {
      if (new URL(url).pathname.endsWith('/synthetic') && JSON.parse(init.body).metadata.url === URL_7) return json({ error: 'broken' }, 500);
      return admit(url, init);
    });
    const { runtime, until } = await createRuntime({ openCode });
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_8 });

    move(pull({ checks: { state: 'success' } }));
    move(pull({ number: 8, checks: { state: 'success' } }), undefined, URL_8);
    expect(await openCode.until(() => openCode.state.admitted.length === 1)).toBe(true);
    expect(openCode.state.admitted[0].metadata.url).toBe(URL_8);
    expect(await until(() => runtime.snapshot().watches.length === 0)).toBe(true);
  });

  it('stops one pull request of the session, or all of them', async () => {
    const { tracked, readers } = createTracked(readEach);
    const { runtime } = await createRuntime();
    runtime.attach({ trackedItems: tracked, readers });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_7 });
    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_8 });

    await expect(runtime.unwatch(SESSION, URL_8)).resolves.toMatchObject({ stopped: true, watching: [{ number: 7 }] });
    expect(tracked.interest.size).toBe(1);
    await expect(runtime.unwatch(SESSION, 'https://example.com/x')).rejects.toMatchObject({ status: 400 });

    await runtime.watch({ sessionID: SESSION, directory: DIRECTORY, url: URL_8 });
    await expect(runtime.unwatch(SESSION)).resolves.toEqual({ watching: [], stopped: true });
    expect(tracked.interest.size).toBe(0);
  });
});
