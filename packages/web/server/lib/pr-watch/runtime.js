import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { assertOpenCodeApiResponse } from '../opencode/prompt-response.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { createMessageId, escapeAttribute } from '../dispatch-results/runtime.js';
import { parseTrackedItem, threadInstance, trackedItemKey } from '../tracked-items/items.js';

const FILE_NAME = 'pr-watch.json';
const FILE_VERSION = 1;
const INTEREST_OWNER = 'pr-watch';
const MAX_WATCHES = 200;
const QUIET_MS = 500;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
const MAX_DELIVERY_FAILURES = 8;
const FETCH_TIMEOUT_MS = 15_000;
export const PR_WATCH_SOURCE = 'openchamber-pr-watch';

const EVENT_TEXT = {
  merged: 'it was merged',
  closed: 'it was closed without merging',
  'checks-failed': 'a check failed',
  'checks-passed': 'every check passed',
  conflict: 'it conflicts with its base branch',
  behind: 'its branch is behind the base branch',
  activity: 'someone commented or reviewed',
};
const EVENTS = Object.keys(EVENT_TEXT);

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/);
const snapshotSchema = z.object({
  state: z.enum(['open', 'closed', 'merged']),
  headSha: z.string().nullable(),
  checks: z.enum(['success', 'failure', 'pending', 'unknown']).nullable(),
  merge: z.string().nullable(),
  activity: z.number().int().nonnegative().nullable(),
  title: z.string(),
});
const watchSchema = z.object({
  sessionID: sessionIdSchema,
  directory: z.string().min(1),
  url: z.string().min(1),
  item: z.unknown(),
  startedAt: z.number().finite().nonnegative(),
  baselineAt: z.number().finite().nonnegative().catch(0),
  last: snapshotSchema.nullable(),
  wake: z.object({
    events: z.array(z.enum(EVENTS)).min(1),
    messageID: z.string().nullable(),
    failedChecks: z.array(z.string()).catch([]),
    authors: z.array(z.string()).catch([]),
  }).nullable(),
});
const detailsSchema = z.object({
  failedChecks: z.array(z.string()).catch([]),
  recentActivity: z.array(z.object({ author: z.string() })).catch([]),
});
const storedFileSchema = z.object({ revision: z.number().int().nonnegative().optional(), watches: z.array(z.unknown()) });
const errorCodeSchema = z.object({ code: z.string() });
const pullStateSchema = z.object({
  state: z.enum(['open', 'closed', 'merged']),
  title: z.string().optional(),
  headSha: z.string().optional(),
  mergeableState: z.string().nullable().optional(),
  checks: z.object({ state: z.enum(['success', 'failure', 'pending', 'unknown']) }).nullable().optional(),
  activity: z.number().int().nonnegative().optional(),
});
const statusEventSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string().min(1), status: z.object({ type: z.string().min(1) }) }),
});
const deletedEventSchema = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({ sessionID: z.string().min(1) }),
});

const parse = (schema, value) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const httpError = (message, status) => Object.assign(new Error(message), { status });

const retryDelay = (failures) => Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

const GITHUB_PULL = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;
const GITLAB_MERGE_REQUEST = /^\/(.+)\/([^/]+)\/-\/merge_requests\/(\d+)(?:\/|$)/;

export const parsePullRequestUrl = (value) => {
  const address = parse(z.string().trim().min(1), value);
  if (!address || !URL.canParse(address)) return null;
  const url = new URL(address);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const github = GITHUB_PULL.exec(url.pathname);
  if (github) {
    const [, owner, repo, number] = github;
    return parseTrackedItem({ provider: 'github', instance: host === 'github.com' ? undefined : host, kind: 'pull', owner, repo, number: Number(number) });
  }
  const gitlab = GITLAB_MERGE_REQUEST.exec(url.pathname);
  if (gitlab) {
    const [, owner, repo, number] = gitlab;
    return parseTrackedItem({ provider: 'gitlab', instance: url.origin, kind: 'pull', owner, repo, number: Number(number) });
  }
  return null;
};

const snapshotOf = (value) => {
  const state = parse(pullStateSchema, value);
  if (!state) return null;
  return {
    state: state.state,
    headSha: state.headSha ?? null,
    checks: state.checks?.state ?? null,
    merge: state.mergeableState ?? null,
    activity: state.activity ?? null,
    title: state.title ?? '',
  };
};

export const changesBetween = (previous, next) => {
  if (!next) return [];
  if (next.state === 'merged') return ['merged'];
  if (next.state === 'closed') return ['closed'];
  if (!previous) return [];
  const events = [];
  const newHead = Boolean(previous.headSha && next.headSha && previous.headSha !== next.headSha);
  if (next.checks === 'failure' && (previous.checks !== 'failure' || newHead)) events.push('checks-failed');
  if (next.checks === 'success' && (previous.checks !== 'success' || newHead)) events.push('checks-passed');
  if (next.merge === 'dirty' && previous.merge !== 'dirty') events.push('conflict');
  if (next.merge === 'behind' && previous.merge !== 'behind') events.push('behind');
  if (next.activity !== null && previous.activity !== null && next.activity > previous.activity) events.push('activity');
  return events;
};

const numberOf = (watch) => parse(z.object({ number: z.number().int().positive() }), watch.item)?.number ?? 0;

const MAX_NAMES = 8;

const cleanNames = (names) => Array.from(new Set(names.map((name) => name.replace(/[<>\s]+/g, ' ').trim().slice(0, 80)).filter(Boolean)));

const nameList = (names) => {
  const clean = cleanNames(names);
  if (clean.length === 0) return '';
  const shown = clean.slice(0, MAX_NAMES).join(', ');
  return clean.length > MAX_NAMES ? `${shown} and ${clean.length - MAX_NAMES} more` : shown;
};

const describeEvent = (event, wake) => {
  const names = event === 'checks-failed' ? nameList(wake.failedChecks) : event === 'activity' ? nameList(wake.authors) : '';
  return names ? `${EVENT_TEXT[event]} (${names})` : EVENT_TEXT[event];
};

const buildWakeMessage = (watch) => {
  const number = numberOf(watch);
  const changes = watch.wake.events.map((event) => describeEvent(event, watch.wake));
  const finished = watch.wake.events.some((event) => event === 'merged' || event === 'closed');
  const next = finished
    ? 'There is nothing more to wait for.'
    : 'You are no longer watching it. Read what changed and act on it; call wait.start with source "pr" again when you need to wait for it once more.';
  return {
    text: `<openchamber-pull-request url="${escapeAttribute(watch.url)}" number="${number}">\nPull request #${number}: ${changes.join('; ')}.\n${next}\n</openchamber-pull-request>`,
    description: `Pull request #${number}: ${changes.join(', ')}`,
    metadata: {
      source: PR_WATCH_SOURCE,
      url: watch.url,
      events: watch.wake.events,
      failedChecks: cleanNames(watch.wake.failedChecks),
      authors: cleanNames(watch.wake.authors),
    },
  };
};

const statusOf = (watch) => {
  if (watch.wake) return 'waking';
  if (!watch.last) return 'unknown';
  if (watch.last.checks === 'pending') return 'pending';
  if (watch.last.checks === 'success') return 'passed';
  if (watch.last.checks === 'failure') return 'failed';
  return 'open';
};

const toPublicWatch = (watch) => ({
  sessionID: watch.sessionID,
  directory: watch.directory,
  url: watch.url,
  number: numberOf(watch),
  title: watch.last?.title ?? '',
  status: statusOf(watch),
  startedAt: watch.startedAt,
});

const PR_WAIT_SOURCE = 'pr';
const PR_WAIT = {
  source: PR_WAIT_SOURCE,
  extension: 'OpenChamber',
  title: 'Pull request',
  description: 'Wakes the session when a check fails or every check passes, someone comments or reviews, the branch conflicts or falls behind, or it is merged or closed. Each pull request is its own wait; starting one again starts it over',
  params: { url: { type: 'string', description: 'Address of a GitHub pull request or GitLab merge request', required: true } },
};

const toPublicWait = (watch) => ({
  waitId: watch.url,
  sessionID: watch.sessionID,
  directory: watch.directory,
  source: PR_WAIT_SOURCE,
  extension: PR_WAIT.extension,
  title: [`#${numberOf(watch)}`, watch.last?.title].filter(Boolean).join(' '),
  label: statusOf(watch),
  args: { url: watch.url },
  startedAt: watch.startedAt,
  status: watch.wake ? 'waking' : 'waiting',
});

const keyOf = (watch) => `${watch.sessionID} ${trackedItemKey(watch.item)}`;

export function createPrWatchRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastUiEvent,
  dataDir,
  readCleanupOnMerge = async () => false,
  isSessionArchived = () => false,
  insideSpace = false,
  fetchImpl = fetch,
  now = Date.now,
  quietMs = QUIET_MS,
  retryDelayMs = retryDelay,
}) {
  const filePath = path.join(dataDir, FILE_NAME);
  const watches = new Map();
  let revision = 0;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let stopped = false;
  let trackedItems = null;
  let readers = null;
  let unsubscribeTracked = null;
  const timers = new Map();
  const delivering = new Set();
  const deferred = new Set();
  const failures = new Map();
  const enriching = new Set();

  const watchesOf = (sessionID) => Array.from(watches.values()).filter((watch) => watch.sessionID === sessionID);
  const hasWake = (sessionID) => watchesOf(sessionID).some((watch) => watch.wake);

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (parse(errorCodeSchema, error)?.code === 'ENOENT') return { watches: [], revision: 0 };
      throw error;
    }
    let stored = null;
    try {
      stored = parse(storedFileSchema, JSON.parse(raw));
    } catch {
      stored = null;
    }
    if (!stored) {
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[pr-watch] file was unreadable and moved to ${backup}`);
      return { watches: [], revision: 0 };
    }
    const restored = [];
    for (const value of stored.watches) {
      const watch = parse(watchSchema, value);
      const item = watch ? parseTrackedItem(watch.item) : null;
      if (watch && item?.kind === 'pull') restored.push({ ...watch, item });
    }
    return { watches: restored, revision: stored.revision ?? 0 };
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const watch of stored.watches) if (!watches.has(keyOf(watch))) watches.set(keyOf(watch), watch);
          revision = Math.max(revision, stored.revision);
        })
        .catch((error) => {
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify({ version: FILE_VERSION, revision, watches: Array.from(watches.values()) });
    const write = writePromise.then(async () => {
      await fs.promises.mkdir(dataDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmpPath, filePath);
    });
    writePromise = write.catch((error) => {
      console.warn('[pr-watch] failed to persist watches:', error?.message ?? error);
    });
    return write;
  };

  const commit = (sessionID) => {
    revision += 1;
    const current = watchesOf(sessionID).map(toPublicWatch);
    broadcastUiEvent?.({
      type: 'openchamber:pr-watch.updated',
      properties: { revision, sessionID, watches: current, watch: current.at(-1) ?? null },
    });
    return persist();
  };

  const snapshot = () => ({ revision, watches: Array.from(watches.values(), toPublicWatch) });

  const syncInterest = () => {
    if (!trackedItems) return;
    const items = new Map();
    for (const watch of watches.values()) {
      if (!watch.wake) items.set(trackedItemKey(watch.item), watch.item);
    }
    trackedItems.setServerInterest(INTEREST_OWNER, items);
  };

  const openCodeRequest = async (fetchPath, { method = 'GET', body } = {}) => {
    const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    const init = { method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(buildOpenCodeUrl(fetchPath, ''), init);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw httpError(`OpenCode ${method} ${fetchPath} failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
    }
    assertOpenCodeApiResponse(response, `OpenCode ${method} ${fetchPath}`);
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs: FETCH_TIMEOUT_MS, fetchImpl });

  const clearTimer = (sessionID) => {
    const timer = timers.get(sessionID);
    if (timer) clearTimeout(timer);
    timers.delete(sessionID);
  };

  const arm = (sessionID, delayMs = quietMs) => {
    if (stopped || !hasWake(sessionID)) return;
    clearTimer(sessionID);
    const timer = setTimeout(() => {
      timers.delete(sessionID);
      deliver(sessionID).catch((error) => console.warn('[pr-watch] wake failed:', error?.message ?? error));
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(sessionID, timer);
  };

  const isCurrent = (watch) => !stopped && watches.get(keyOf(watch)) === watch;

  const drop = async (...ending) => {
    const current = ending.filter(isCurrent);
    if (current.length === 0) return;
    const { sessionID } = current[0];
    for (const watch of current) {
      watches.delete(keyOf(watch));
      failures.delete(keyOf(watch));
    }
    if (!hasWake(sessionID)) clearTimer(sessionID);
    else if (!timers.has(sessionID)) arm(sessionID);
    syncInterest();
    await commit(sessionID);
  };

  const retry = (watch, reason) => {
    if (!isCurrent(watch)) return undefined;
    const count = (failures.get(keyOf(watch)) ?? 0) + 1;
    failures.set(keyOf(watch), count);
    if (count >= MAX_DELIVERY_FAILURES) {
      console.warn(`[pr-watch] giving up waking ${watch.sessionID}: ${reason}`);
      return drop(watch);
    }
    arm(watch.sessionID, retryDelayMs(count));
    return undefined;
  };

  async function deliver(sessionID) {
    if (delivering.has(sessionID)) {
      deferred.add(sessionID);
      return;
    }
    const watch = watchesOf(sessionID).find((entry) => entry.wake && !enriching.has(entry));
    if (stopped || !watch) return;
    delivering.add(sessionID);
    try {
      await attemptWake(watch);
    } finally {
      delivering.delete(sessionID);
      if (deferred.delete(sessionID)) arm(sessionID);
    }
  }

  async function attemptWake(watch) {
    const { sessionID } = watch;
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!isCurrent(watch)) return undefined;
    if (!statuses) return retry(watch, 'OpenCode could not be asked');
    if (statuses[sessionID]) return undefined;
    const archived = await Promise.resolve(isSessionArchived(sessionID)).catch(() => false) === true;
    if (!isCurrent(watch)) return undefined;
    if (archived) return drop(...watchesOf(sessionID));
    if (!watch.wake.messageID) {
      watch.wake.messageID = createMessageId(now());
      await persist();
      if (!isCurrent(watch)) return undefined;
    }
    try {
      await openCodeRequest(`/api/session/${encodeURIComponent(sessionID)}/synthetic`, {
        method: 'POST',
        body: { id: watch.wake.messageID, ...buildWakeMessage(watch), delivery: 'steer', resume: true },
      });
    } catch (error) {
      if (error?.status !== 409 && error?.status !== 404) return retry(watch, error?.message ?? String(error));
    }
    return drop(watch);
  }

  async function addDetails(watch, newActivity) {
    const { item } = watch;
    const result = await readers.sourceControl({
      provider: item.provider,
      instance: threadInstance(item),
      accountId: null,
      pulls: [{ owner: item.owner, repo: item.repo, number: item.number }],
      issues: [],
      details: true,
    }).catch(() => null);
    const summary = result?.status === 'ok' ? (result.pulls ?? []).find((pull) => pull?.number === item.number) : null;
    const details = parse(detailsSchema, summary);
    if (!details || !isCurrent(watch) || !watch.wake || watch.wake.messageID) return;
    if (watch.wake.events.includes('checks-failed')) watch.wake.failedChecks = details.failedChecks;
    if (watch.wake.events.includes('activity')) {
      watch.wake.authors = details.recentActivity.slice(0, Math.max(1, newActivity)).map((entry) => entry.author);
    }
    await persist().catch(() => undefined);
  }

  const onStatesChanged = (states) => {
    void (async () => {
      for (const { key, state, requestedAt = 0 } of states) {
        const next = snapshotOf(state);
        if (!next) continue;
        for (const watch of Array.from(watches.values())) {
          if (watch.wake || trackedItemKey(watch.item) !== key || !isCurrent(watch)) continue;
          if (requestedAt < watch.baselineAt) continue;
          const events = changesBetween(watch.last, next);
          const newActivity = (next.activity ?? 0) - (watch.last?.activity ?? 0);
          watch.last = next;
          if (events.length === 0) {
            await commit(watch.sessionID);
            continue;
          }
          if (events.includes('merged')) {
            const cleanup = await readCleanupOnMerge().catch(() => false) === true;
            if (!isCurrent(watch)) continue;
            if (cleanup) {
              await drop(watch);
              continue;
            }
          }
          watch.wake = { events, messageID: null, failedChecks: [], authors: [] };
          const withDetails = events.includes('checks-failed') || events.includes('activity');
          if (withDetails) enriching.add(watch);
          try {
            syncInterest();
            await commit(watch.sessionID);
            if (withDetails) await addDetails(watch, newActivity);
          } finally {
            enriching.delete(watch);
          }
          arm(watch.sessionID, 0);
        }
      }
    })().catch((error) => console.warn('[pr-watch] could not apply a change:', error?.message ?? error));
  };

  const watch = async ({ sessionID: rawSessionID, directory, url }) => {
    if (insideSpace) throw httpError('Watching a pull request is not available inside an isolated space', 400);
    const sessionID = parse(sessionIdSchema, rawSessionID);
    if (!sessionID) throw httpError('pr.watch must be called from a session', 400);
    if (!directory) throw httpError('The session\'s directory is unknown', 400);
    const item = parsePullRequestUrl(url);
    if (!item) throw httpError('url must be the address of a GitHub pull request or a GitLab merge request', 400);
    if (!trackedItems || !readers) throw httpError('Pull request status is not available on this server yet', 503);
    await load();

    let last = null;
    const baselineAt = now();
    try {
      const result = await readers.sourceControl({
        provider: item.provider,
        instance: threadInstance(item),
        accountId: null,
        pulls: [{ owner: item.owner, repo: item.repo, number: item.number }],
        issues: [],
      });
      if (result?.status === 'disconnected') {
        throw httpError(`OpenChamber has no ${item.provider === 'gitlab' ? 'GitLab' : 'GitHub'} account connected for ${threadInstance(item)}, so it cannot follow this pull request`, 400);
      }
      if (result?.status === 'ok') {
        const summary = (result.pulls ?? []).find((pull) => pull?.number === item.number);
        if (!summary) throw httpError('The pull request could not be read: it does not exist, or the connected account cannot see it', 404);
        last = snapshotOf(summary);
      }
    } catch (error) {
      if (Number.isInteger(error?.status)) throw error;
    }
    if (last?.state === 'merged' || last?.state === 'closed') {
      throw httpError(`The pull request is already ${last.state}: there is nothing to wait for`, 409);
    }

    const record = { sessionID, directory, url: String(url).trim(), item, startedAt: now(), baselineAt, last, wake: null };
    watches.delete(keyOf(record));
    failures.delete(keyOf(record));
    watches.set(keyOf(record), record);
    if (!hasWake(sessionID)) clearTimer(sessionID);
    if (watches.size > MAX_WATCHES) {
      const oldest = Array.from(watches.values()).sort((left, right) => left.startedAt - right.startedAt)[0];
      if (oldest && oldest !== record) watches.delete(keyOf(oldest));
    }
    syncInterest();
    await commit(sessionID);
    return {
      watching: toPublicWatch(record),
      next: 'A message arrives in this session when a check fails, every check passes, someone comments or reviews, the branch conflicts or falls behind, or the pull request is merged or closed.',
    };
  };

  const unwatch = async (rawSessionID, url) => {
    const sessionID = parse(sessionIdSchema, rawSessionID);
    if (!sessionID) throw httpError('sessionID is invalid', 400);
    const every = url === undefined;
    const item = every ? null : parsePullRequestUrl(url);
    if (!every && !item) throw httpError('url must be the address of a GitHub pull request or a GitLab merge request', 400);
    await load();
    const ending = watchesOf(sessionID).filter((watch) => every || trackedItemKey(watch.item) === trackedItemKey(item));
    await drop(...ending);
    return { watching: watchesOf(sessionID).map(toPublicWatch), stopped: ending.length > 0 };
  };

  const waitSource = () => (insideSpace ? null : { ...PR_WAIT, params: { ...PR_WAIT.params } });
  const listWaits = async (sessionID) => {
    await load();
    return watchesOf(sessionID).map(toPublicWait);
  };

  const processPayload = (payload) => {
    if (stopped) return;
    const deleted = parse(deletedEventSchema, payload);
    if (deleted) {
      void drop(...watchesOf(deleted.properties.sessionID)).catch(() => undefined);
      return;
    }
    const status = parse(statusEventSchema, payload);
    if (!status || status.properties.status.type !== 'idle') return;
    if (hasWake(status.properties.sessionID)) arm(status.properties.sessionID);
  };

  const attach = ({ trackedItems: service, readers: itemReaders }) => {
    trackedItems = service;
    readers = itemReaders;
    unsubscribeTracked?.();
    unsubscribeTracked = service.subscribe(onStatesChanged);
    void load().then(syncInterest).catch(() => undefined);
  };

  const start = (globalEventHub) => {
    const unsubscribeEvent = globalEventHub?.subscribeEvent((event) => {
      for (const payload of event?.translated?.() ?? []) processPayload(payload);
    });
    const unsubscribeStatus = globalEventHub?.subscribeStatus((hubStatus) => {
      if (hubStatus?.type !== 'connect') return;
      for (const entry of watches.values()) if (entry.wake) arm(entry.sessionID);
    });
    void load()
      .then(() => {
        syncInterest();
        for (const entry of watches.values()) if (entry.wake) arm(entry.sessionID);
      })
      .catch((error) => console.warn('[pr-watch] failed to load watches:', error?.message ?? error));
    return () => {
      unsubscribeEvent?.();
      unsubscribeStatus?.();
    };
  };

  const stop = () => {
    stopped = true;
    unsubscribeTracked?.();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  return {
    load,
    snapshot,
    watch,
    unwatch,
    waitSource,
    listWaits,
    attach,
    processPayload,
    start,
    stop,
    flush: () => writePromise,
  };
}

export function registerPrWatchRoutes(app, runtime) {
  const respondError = (res, error, fallback) => {
    res.status(Number.isInteger(error?.status) ? error.status : 500).json({ error: error?.message ?? fallback });
  };

  app.get('/api/pr-watch', async (_req, res) => {
    try {
      await runtime.load();
      res.json(runtime.snapshot());
    } catch (error) {
      respondError(res, error, 'Failed to load pull request watches');
    }
  });

  app.delete('/api/pr-watch/sessions/:sessionID', async (req, res) => {
    try {
      res.json(await runtime.unwatch(req.params.sessionID, req.query.url));
    } catch (error) {
      respondError(res, error, 'Failed to stop watching the pull request');
    }
  });
}
