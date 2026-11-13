// An agent waiting on its pull request.
//
// The agent opens a pull request (or a merge request), asks to watch it with
// the `openchamber` tool's `pr.watch`, and goes on with whatever it does,
// ending its turn when it has nothing else. From then on this runtime follows
// the pull request through the tracked-items service, whether or not any
// window is open, and wakes the session with one synthetic message
// when something the agent has to act on happens: a check failed, every check
// passed, the merge queue removed it, someone commented or reviewed, it
// conflicts with or fell behind its base, it was merged or closed. A wake ends the watch; the agent watches
// again when it needs to wait once more.
//
// Delivery follows `../dispatch-results`: the message waits until the session
// is not running, its id is minted and saved before the first attempt, and
// OpenCode refusing a second admission of that id counts as delivered.

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { assertOpenCodeApiResponse } from '../opencode/prompt-response.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { createMessageId, escapeAttribute } from '../dispatch-results/runtime.js';
import { parseTrackedItem, threadInstance, trackedItemKey } from '../tracked-items/items.js';
import { pullRequestKey, sessionKey } from '../session-automation/runtime.js';

const FILE_NAME = 'pr-watch.json';
const FILE_VERSION = 1;
const INTEREST_OWNER = 'pr-watch';
const MAX_WATCHES = 200;
// Idle events arrive in bursts around a turn boundary.
const QUIET_MS = 500;
const SUBAGENT_RECHECK_MS = 5_000;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
// A wake that keeps failing is given up, so a broken session does not retry forever.
const MAX_DELIVERY_FAILURES = 8;
const FETCH_TIMEOUT_MS = 15_000;
export const PR_WATCH_SOURCE = 'openchamber-pr-watch';

/** What the agent is told, in the order it reads best. */
const EVENT_TEXT = {
  merged: 'it was merged',
  closed: 'it was closed without merging',
  'checks-failed': 'a check failed',
  'checks-passed': 'every check passed',
  dequeued: 'it was removed from the merge queue',
  conflict: 'it conflicts with its base branch',
  behind: 'its branch is behind the base branch',
  activity: 'someone commented or reviewed',
};
const EVENTS = Object.keys(EVENT_TEXT);

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/);
const queueRemovalSchema = z.object({ at: z.string(), reason: z.string().nullable() });
const snapshotSchema = z.object({
  state: z.enum(['open', 'closed', 'merged']),
  headSha: z.string().nullable(),
  checks: z.enum(['success', 'failure', 'pending', 'unknown']).nullable(),
  merge: z.string().nullable(),
  activity: z.number().int().nonnegative().nullable(),
  title: z.string(),
  // Missing in a file written before it was followed: no baseline, so no event.
  queueRemoval: queueRemovalSchema.nullable().optional(),
});
const watchSchema = z.object({
  sessionID: sessionIdSchema,
  directory: z.string().min(1),
  url: z.string().min(1),
  item: z.unknown(),
  startedAt: z.number().finite().nonnegative(),
  // When the watch's own read began: a tracked-items answer to a read that
  // began earlier is older than the baseline and is dropped.
  baselineAt: z.number().finite().nonnegative().catch(0),
  last: snapshotSchema.nullable(),
  wake: z.object({
    events: z.array(z.enum(EVENTS)).min(1),
    messageID: z.string().nullable(),
    // Read when the wake was decided; a file from before them has none.
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
  queueRemoval: queueRemovalSchema.nullable().optional(),
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

/**
 * The tracked item a pull or merge request address names, or null. A GitHub
 * address on another host is GitHub Enterprise; a GitLab address is read on
 * its own origin. Other providers are not followed.
 */
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

/** The parts of a pull request's live state a wake depends on, or null while it is unknown. */
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
    queueRemoval: state.queueRemoval ?? null,
  };
};

/**
 * What happened between two states, in `EVENTS` terms. The first known state
 * is only a baseline. Checks count again after a push: the same outcome on a
 * new head is news.
 */
export const changesBetween = (previous, next) => {
  if (!next) return [];
  // An end is news even with no baseline: nothing reads a merged pull request again.
  if (next.state === 'merged') return ['merged'];
  if (next.state === 'closed') return ['closed'];
  if (!previous) return [];
  const events = [];
  const newHead = Boolean(previous.headSha && next.headSha && previous.headSha !== next.headSha);
  if (next.checks === 'failure' && (previous.checks !== 'failure' || newHead)) events.push('checks-failed');
  if (next.checks === 'success' && (previous.checks !== 'success' || newHead)) events.push('checks-passed');
  // A removal after the baseline's, for any reason but the merge itself.
  const removal = next.queueRemoval;
  if (removal && previous.queueRemoval !== undefined && removal.at !== previous.queueRemoval?.at && removal.reason !== 'MERGED') {
    events.push('dequeued');
  }
  if (next.merge === 'dirty' && previous.merge !== 'dirty') events.push('conflict');
  if (next.merge === 'behind' && previous.merge !== 'behind') events.push('behind');
  if (next.activity !== null && previous.activity !== null && next.activity > previous.activity) events.push('activity');
  return events;
};

const numberOf = (watch) => parse(z.object({ number: z.number().int().positive() }), watch.item)?.number ?? 0;

const MAX_NAMES = 8;

/**
 * Names for the message: check names come from whoever wrote the workflow,
 * so nothing in them may close the message's tag or break its line.
 */
const nameList = (names) => {
  const clean = Array.from(new Set(names.map((name) => name.replace(/[<>\s]+/g, ' ').trim().slice(0, 80)).filter(Boolean)));
  if (clean.length === 0) return '';
  const shown = clean.slice(0, MAX_NAMES).join(', ');
  return clean.length > MAX_NAMES ? `${shown} and ${clean.length - MAX_NAMES} more` : shown;
};

const describeEvent = (event, wake, reason) => {
  const names = {
    'checks-failed': () => nameList(wake.failedChecks),
    activity: () => nameList(wake.authors),
    // FAILED_CHECKS reads as "failed checks".
    dequeued: () => nameList([(reason ?? '').toLowerCase().replace(/_/g, ' ')]),
  }[event]?.() ?? '';
  return names ? `${EVENT_TEXT[event]} (${names})` : EVENT_TEXT[event];
};

/** The synthetic message that wakes the agent. */
const buildWakeMessage = (watch) => {
  const number = numberOf(watch);
  const changes = watch.wake.events.map((event) => describeEvent(event, watch.wake, watch.last?.queueRemoval?.reason));
  const finished = watch.wake.events.some((event) => event === 'merged' || event === 'closed');
  const next = finished
    ? 'There is nothing more to wait for.'
    : 'You are no longer watching it. Read what changed and act on it; call pr.watch again when you need to wait for it once more.';
  return {
    text: `<openchamber-pull-request url="${escapeAttribute(watch.url)}" number="${number}">\nPull request #${number}: ${changes.join('; ')}.\n${next}\n</openchamber-pull-request>`,
    description: `Pull request #${number}: ${changes.join(', ')}`,
    metadata: { source: PR_WATCH_SOURCE, url: watch.url, events: watch.wake.events },
  };
};

/** What the composer row shows while the agent waits. */
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

export function createPrWatchRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastUiEvent,
  dataDir,
  // Whether "Archive a worktree after its PR is merged" is on: then a merge
  // ends the watch without waking a session that is about to be archived.
  readCleanupOnMerge = async () => false,
  isSessionArchived = () => false,
  // The server inside an isolated space has no accounts to read a pull request with.
  insideSpace = false,
  automation = null,
  fetchImpl = fetch,
  now = Date.now,
  quietMs = QUIET_MS,
  retryDelayMs = retryDelay,
  subagentRecheckMs = SUBAGENT_RECHECK_MS,
}) {
  const filePath = path.join(dataDir, FILE_NAME);
  /** sessionID → watch */
  const watches = new Map();
  let revision = 0;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let stopped = false;
  let trackedItems = null;
  let readers = null;
  let unsubscribeTracked = null;
  const timers = new Map();
  const failures = new Map();
  const delivering = new Set();
  // An attempt asked for while another one for the session was in flight.
  const deferred = new Set();
  // sessionID → the watch whose wake is still reading its details; it is armed once they are in.
  const enriching = new Map();
  const ownershipHeld = new Set();

  // --- persistence ---------------------------------------------------------

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
    // One unreadable watch is dropped alone.
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
          for (const watch of stored.watches) if (!watches.has(watch.sessionID)) watches.set(watch.sessionID, watch);
          revision = Math.max(revision, stored.revision);
        })
        .catch((error) => {
          // A failed read must not pass for "no watches": writes wait for a load that succeeds.
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

  /** Every change a client can see: bump, persist, broadcast. */
  const commit = (sessionID) => {
    revision += 1;
    const watch = watches.get(sessionID) ?? null;
    broadcastUiEvent?.({
      type: 'openchamber:pr-watch.updated',
      properties: { revision, sessionID, watch: watch ? toPublicWatch(watch) : null },
    });
    return persist();
  };

  const snapshot = () => ({ revision, watches: Array.from(watches.values(), toPublicWatch) });

  /** The pull requests still waited on, handed to the tracked-items service. */
  const syncInterest = () => {
    if (!trackedItems) return;
    const items = new Map();
    for (const watch of watches.values()) {
      if (!watch.wake) items.set(trackedItemKey(watch.item), watch.item);
    }
    trackedItems.setServerInterest(INTEREST_OWNER, items);
  };

  // --- OpenCode ------------------------------------------------------------

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

  // --- wake ----------------------------------------------------------------

  const clearTimer = (sessionID) => {
    const timer = timers.get(sessionID);
    if (timer) clearTimeout(timer);
    timers.delete(sessionID);
  };

  const arm = (sessionID, delayMs = quietMs) => {
    if (stopped || !watches.get(sessionID)?.wake) return;
    clearTimer(sessionID);
    const timer = setTimeout(() => {
      timers.delete(sessionID);
      deliver(sessionID).catch((error) => console.warn('[pr-watch] wake failed:', error?.message ?? error));
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(sessionID, timer);
  };

  /** Whether `watch` is still the session's watch: a stop or a new watch replaces it mid-await. */
  const isCurrent = (watch) => !stopped && watches.get(watch.sessionID) === watch;

  /** Ends `watch`, and only it: a newer watch of the same session stays. */
  const drop = async (watch) => {
    if (!isCurrent(watch)) return;
    watches.delete(watch.sessionID);
    clearTimer(watch.sessionID);
    failures.delete(watch.sessionID);
    ownershipHeld.delete(watch.sessionID);
    syncInterest();
    await commit(watch.sessionID);
  };

  const retry = (watch, reason) => {
    if (!isCurrent(watch)) return undefined;
    const count = (failures.get(watch.sessionID) ?? 0) + 1;
    failures.set(watch.sessionID, count);
    if (count >= MAX_DELIVERY_FAILURES) {
      console.warn(`[pr-watch] giving up waking ${watch.sessionID}: ${reason}`);
      return drop(watch);
    }
    arm(watch.sessionID, retryDelayMs(count));
    return undefined;
  };

  async function deliver(sessionID) {
    if (delivering.has(sessionID)) {
      // An idle event or a new watch's wake while an attempt is in flight:
      // tried again once that attempt is over, never lost.
      deferred.add(sessionID);
      return;
    }
    const watch = watches.get(sessionID);
    if (stopped || !watch?.wake || enriching.get(sessionID) === watch) return;
    delivering.add(sessionID);
    try {
      await attemptWake(watch);
    } finally {
      delivering.delete(sessionID);
      if (deferred.delete(sessionID)) arm(sessionID, 0);
    }
  }

  async function attemptWake(watch) {
    const { sessionID } = watch;
    await automation?.ready();
    if (!isCurrent(watch)) return;
    // Never into a running turn: the user may be talking to the agent.
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!isCurrent(watch)) return undefined;
    if (!statuses) return retry(watch, 'OpenCode could not be asked');
    if (statuses[sessionID]) return undefined; // its idle event arms the next attempt
    const subagents = await activityProbe.hasWorkingChildren(sessionID, statuses);
    if (!isCurrent(watch)) return undefined;
    if (subagents === null) return retry(watch, 'OpenCode could not be asked');
    if (subagents) return arm(sessionID, subagentRecheckMs);
    let archived;
    try { archived = await isSessionArchived(sessionID); } catch { return retry(watch, 'Archive state could not be read'); }
    if (!isCurrent(watch)) return undefined;
    if (archived) return drop(watch);
    if (!watch.wake.messageID) {
      watch.wake.messageID = createMessageId(now());
      await persist();
      if (!isCurrent(watch)) return undefined;
    }
    const releaseSend = automation?.trySend(null, [sessionKey(sessionID), pullRequestKey(watch.item)]);
    if (automation && !releaseSend) { ownershipHeld.add(sessionID); return; }
    ownershipHeld.delete(sessionID);
    try {
      if (!isCurrent(watch)) return;
      await openCodeRequest(`/api/session/${encodeURIComponent(sessionID)}/synthetic`, {
        method: 'POST',
        body: { id: watch.wake.messageID, ...buildWakeMessage(watch), delivery: 'steer', resume: true },
      });
    } catch (error) {
      // 409: an earlier attempt landed. 404: nobody is left to wake.
      if (error?.status !== 409 && error?.status !== 404) return retry(watch, error?.message ?? String(error));
    } finally {
      releaseSend?.();
    }
    return drop(watch);
  }

  /**
   * Which checks failed and who wrote, so the agent knows where to start
   * without a read of its own. One read when the wake is decided; a failed
   * read sends the wake without them. `newActivity` is how many comments and
   * reviews are new: the authors are theirs, newest first.
   */
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
    // In memory either way; a failed write only loses the names on a restart.
    await persist().catch(() => undefined);
  }

  /** Tracked-items changes: a moved pull request may wake its sessions. */
  const onStatesChanged = (states) => {
    void (async () => {
      for (const { key, state, requestedAt = 0 } of states) {
        const next = snapshotOf(state);
        if (!next) continue;
        for (const watch of Array.from(watches.values())) {
          if (watch.wake || trackedItemKey(watch.item) !== key || !isCurrent(watch)) continue;
          // A read that began before the watch's own is older than its
          // baseline: an earlier head's checks must not end the wait.
          if (requestedAt < watch.baselineAt) {
            trackedItems.refresh([watch.item]);
            continue;
          }
          if (JSON.stringify(watch.last) === JSON.stringify(next)) continue;
          const events = changesBetween(watch.last, next);
          const newActivity = (next.activity ?? 0) - (watch.last?.activity ?? 0);
          watch.last = next;
          if (events.length === 0) {
            await commit(watch.sessionID);
            continue;
          }
          // The worktree is about to be archived with its sessions: waking
          // one now would start a turn in a session on its way out.
          if (events.includes('merged')) {
            const cleanup = await readCleanupOnMerge().catch(() => false) === true;
            if (!isCurrent(watch)) continue;
            if (cleanup) {
              await drop(watch);
              continue;
            }
          }
          watch.wake = { events, messageID: null, failedChecks: [], authors: [] };
          // Held from here on: an idle event during the write below must not
          // deliver the wake before its details are in.
          const withDetails = events.includes('checks-failed') || events.includes('activity');
          if (withDetails) enriching.set(watch.sessionID, watch);
          try {
            syncInterest();
            await commit(watch.sessionID);
            if (withDetails) await addDetails(watch, newActivity);
          } finally {
            if (enriching.get(watch.sessionID) === watch) enriching.delete(watch.sessionID);
          }
          arm(watch.sessionID, 0);
        }
      }
    })().catch((error) => console.warn('[pr-watch] could not apply a change:', error?.message ?? error));
  };

  // --- public --------------------------------------------------------------

  /**
   * Starts waiting on the pull request at `url` for `sessionID`, replacing
   * what the session waited on before. Reads it first, so an address the
   * server cannot follow fails now instead of never waking.
   */
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
      // Unavailable for now (a rate limit, an outage): the watch reads it later.
    }
    if (last?.state === 'merged' || last?.state === 'closed') {
      throw httpError(`The pull request is already ${last.state}: there is nothing to wait for`, 409);
    }

    const record = { sessionID, directory, url: String(url).trim(), item, startedAt: now(), baselineAt, last, wake: null };
    watches.delete(sessionID);
    clearTimer(sessionID);
    failures.delete(sessionID);
    ownershipHeld.delete(sessionID);
    watches.set(sessionID, record);
    if (watches.size > MAX_WATCHES) {
      const oldest = Array.from(watches.values()).sort((left, right) => left.startedAt - right.startedAt)[0];
      if (oldest && oldest !== record) watches.delete(oldest.sessionID);
    }
    syncInterest();
    await commit(sessionID);
    return {
      watching: toPublicWatch(record),
      next: 'A message arrives in this session when a check fails, every check passes, the merge queue removes it, someone comments or reviews, the branch conflicts or falls behind, or the pull request is merged or closed.',
    };
  };

  /** Stops waiting; the session is not woken. */
  const unwatch = async (rawSessionID) => {
    const sessionID = parse(sessionIdSchema, rawSessionID);
    if (!sessionID) throw httpError('sessionID is invalid', 400);
    await load();
    const current = watches.get(sessionID);
    if (current) await drop(current);
    return { watching: false, stopped: Boolean(current) };
  };

  const processPayload = (payload) => {
    if (stopped) return;
    const deleted = parse(deletedEventSchema, payload);
    if (deleted) {
      const current = watches.get(deleted.properties.sessionID);
      if (current) void drop(current).catch(() => undefined);
      return;
    }
    const status = parse(statusEventSchema, payload);
    if (!status || status.properties.status.type !== 'idle') return;
    if (watches.get(status.properties.sessionID)?.wake) arm(status.properties.sessionID);
  };

  /** Connects to the tracked-items service once the routes created it. */
  const attach = ({ trackedItems: service, readers: itemReaders }) => {
    trackedItems = service;
    readers = itemReaders;
    unsubscribeTracked?.();
    unsubscribeTracked = service.subscribeRefresh((states) => onStatesChanged(states.filter((state) => state.status === 'ok')));
    void load().then(syncInterest).catch(() => undefined);
  };

  const start = (globalEventHub) => {
    const unsubscribeEvent = globalEventHub?.subscribeEvent((event) => {
      for (const payload of event?.translated?.() ?? []) processPayload(payload);
    });
    const unsubscribeStatus = globalEventHub?.subscribeStatus((hubStatus) => {
      if (hubStatus?.type !== 'connect') return;
      for (const [sessionID, entry] of watches) if (entry.wake) arm(sessionID);
    });
    void load()
      .then(() => {
        syncInterest();
        for (const [sessionID, entry] of watches) if (entry.wake) arm(sessionID);
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
    trackedItems?.setServerInterest(INTEREST_OWNER, new Map());
  };

  return {
    load,
    snapshot,
    watch,
    unwatch,
    attach,
    processPayload,
    start,
    release: (keys) => {
      const released = new Set(keys);
      for (const sessionID of ownershipHeld) {
        const watch = watches.get(sessionID);
        if (watch?.wake && (released.has(sessionKey(sessionID)) || released.has(pullRequestKey(watch.item)))) {
          ownershipHeld.delete(sessionID);
          arm(sessionID);
        }
      }
    },
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
      res.json(await runtime.unwatch(req.params.sessionID));
    } catch (error) {
      respondError(res, error, 'Failed to stop watching the pull request');
    }
  });
}
