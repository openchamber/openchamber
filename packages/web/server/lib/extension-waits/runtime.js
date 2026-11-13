// Waits an extension's service offers agents (`contributes.waits`).
//
// The agent starts one with the `openchamber` tool's `wait.start`, naming a
// source (`<extension id>/<wait id>`) and its arguments, and ends its turn.
// This runtime keeps the wait, asks the service on the type's interval
// whether it fired, and wakes the session with one synthetic message when it
// did. One wake ends the wait. A wait whose extension can no longer wake
// anyone (paused, removed, approval withdrawn, the type dropped) ends with a
// wake that says so, so the agent never keeps waiting on nothing.
//
// One source is the host's own: `timer` takes `minutes` and fires on the
// clock, with no extension and no service behind it.
//
// Everything that lasts lives here: the waits, each one's opaque `state`,
// the cadence and the backoff. The service only answers start and check
// requests, so it may stop between checks.
//
// Delivery follows `../pr-watch`: the message waits until the session and its
// subagents are idle, its id is minted and saved before the first attempt,
// and OpenCode refusing a second admission of that id counts as delivered.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  WAITS_CHECK_BATCH_MAX,
  WAITS_CHECK_PATH,
  WAITS_START_PATH,
  WAITS_WIRE_VERSION,
  WAIT_REQUEST_TIMEOUT_MS,
  isGuestApproved,
  requestedGuestCapabilities,
  resolveWaitInterval,
} from '@openchamber/sdk';
import { waitArgsSchema, waitCheckOutcomeSchema, waitCheckResultSchema, waitStartResultSchema } from '@openchamber/sdk/schemas';

import { assertOpenCodeApiResponse } from '../opencode/prompt-response.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { createMessageId, escapeAttribute } from '../dispatch-results/runtime.js';

const FILE_NAME = 'extension-waits.json';
const FILE_VERSION = 1;
const MAX_WAITS = 200;
const MAX_WAITS_PER_SESSION = 20;
// Idle events arrive in bursts around a turn boundary.
const QUIET_MS = 500;
const SUBAGENT_RECHECK_MS = 5_000;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
// A wake that keeps failing is given up, so a broken session does not retry forever.
const MAX_DELIVERY_FAILURES = 8;
const FETCH_TIMEOUT_MS = 15_000;
// A type whose checks keep failing is asked again after its interval doubled per failure, up to this.
const CHECK_BACKOFF_MAX_MS = 10 * 60_000;
// A wait whose every check failed for this long ends: the service is broken, not down for a while.
const CHECK_FAILURE_LIMIT_MS = 6 * 60 * 60_000;
// The guest proxy stops a service after this long without a request.
const SERVICE_IDLE_STOP_MS = 10 * 60_000;
const RESPONSE_MAX = 256 * 1024;
export const EXTENSION_WAIT_SOURCE = 'openchamber-wait';

// The built-in source. Extension sources always hold a slash, so the bare name cannot collide.
const TIMER_SOURCE = 'timer';
const TIMER_MINUTES_MAX = 24 * 60;
const TIMER = {
  source: TIMER_SOURCE,
  extension: 'OpenChamber',
  title: 'Timer',
  description: 'Wakes the session once the given number of minutes has passed',
  params: { minutes: { type: 'number', description: `Whole minutes, 1 to ${TIMER_MINUTES_MAX}`, required: true } },
};

const ENDED_REASONS = {
  unavailable: 'the extension was paused or removed, or its approval to wake sessions was withdrawn',
  dropped: 'the extension no longer offers this wait',
  unreadable: 'the extension answered its check with something OpenChamber could not read',
  failing: 'every check of it failed for six hours',
};

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/);
const argsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const waitSchema = z.object({
  id: z.string().regex(/^wait_[A-Za-z0-9-]{8,64}$/),
  sessionID: sessionIdSchema,
  directory: z.string().min(1).nullable(),
  // null for the built-in timer.
  guestId: z.string().min(1).nullable(),
  // The extension's name when the wait started, for the composer row.
  extensionName: z.string().min(1).nullable().catch(null),
  type: z.string().min(1),
  title: z.string().min(1),
  label: z.string().min(1).nullable(),
  args: argsSchema,
  state: z.unknown(),
  startedAt: z.number().finite().nonnegative(),
  nextCheckAt: z.number().finite().nonnegative(),
  // When its checks started failing without a success since; null while they work.
  failingSince: z.number().finite().nonnegative().nullable().catch(null),
  wake: z.object({
    outcome: z.enum(['fired', 'ended']),
    summary: z.string().min(1),
    messageID: z.string().nullable(),
  }).nullable(),
});
const storedFileSchema = z.object({ revision: z.number().int().nonnegative().optional(), waits: z.array(z.unknown()) });
const errorCodeSchema = z.object({ code: z.string() });
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

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const httpError = (message, status) => Object.assign(new Error(message), { status });

const retryDelay = (failures) => Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

/** Whether a catalog row may wake sessions right now; asked again on every start, check and catalog change. */
export const isWaitProvider = (guest) => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return Boolean(guest)
    && guest.enabled !== false
    && Array.isArray(guest.waits)
    && guest.waits.length > 0
    && granted.includes('service')
    && granted.includes('wake')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted });
};

const isTimer = (wait) => wait.guestId === null;

const sourceOf = (wait) => (isTimer(wait) ? TIMER_SOURCE : `${wait.guestId}/${wait.type}`);

const minutesText = (minutes) => (minutes === 1 ? '1 minute' : `${minutes} minutes`);

/**
 * The extension's text goes into the agent's context: nothing in it may close
 * the envelope, and the envelope names who wrote it.
 */
const cleanText = (text) => text.replace(/[<>]/g, '').trim();

// The label is the service's text at start time, never shown at approval.
const subjectOf = (wait) => (wait.label ? `${cleanText(wait.title)} (${cleanText(wait.label)})` : cleanText(wait.title));

/** The synthetic message that wakes the agent. */
const buildWakeMessage = (wait) => {
  const subject = subjectOf(wait);
  const summary = cleanText(wait.wake.summary);
  const fired = wait.wake.outcome === 'fired';
  // The timer's summary is the host's own text; an extension's is quoted as its words.
  const report = isTimer(wait)
    ? [`${subject} fired: ${summary}`]
    : [`${subject} fired. What the extension "${wait.guestId}" reports, its own words and not the user's:`, summary];
  const lines = fired
    ? [...report, 'The wait is over. Act on it; call wait.start again when you need to wait once more.']
    : [
      `${subject} ended without firing: ${summary}.`,
      'Nothing will wake you for it any more. Go on without it, or start it again once the extension is back.',
    ];
  const firstLine = summary.split('\n')[0].slice(0, 160);
  return {
    text: `<openchamber-wait source="${escapeAttribute(sourceOf(wait))}" wait="${escapeAttribute(wait.id)}" outcome="${wait.wake.outcome}">\n${lines.join('\n')}\n</openchamber-wait>`,
    description: fired ? `${subject}: ${firstLine}` : `${subject} ended: ${firstLine}`,
    metadata: {
      source: EXTENSION_WAIT_SOURCE,
      waitId: wait.id,
      extension: wait.guestId,
      type: wait.type,
      title: wait.title,
      label: wait.label,
      outcome: wait.wake.outcome,
      // The chat row's title and body: the description holds only the summary's first line.
      subject,
      summary,
    },
  };
};

const toPublicWait = (wait) => ({
  waitId: wait.id,
  sessionID: wait.sessionID,
  directory: wait.directory,
  source: sourceOf(wait),
  extension: wait.extensionName ?? wait.guestId ?? TIMER.extension,
  title: wait.title,
  label: wait.label,
  args: { ...wait.args },
  startedAt: wait.startedAt,
  status: wait.wake ? 'waking' : 'waiting',
});

const toPublicSource = (guest, wait) => ({
  source: `${guest.id}/${wait.id}`,
  extension: guest.name || guest.id,
  title: wait.title,
  description: wait.description,
  params: { ...(wait.params ?? {}) },
});

/** Proxy failures that mean "not able to serve right now", never a broken answer. */
const UNAVAILABLE_CODES = new Set(['NO_SERVICE', 'DISABLED', 'CANCELLED']);

export function createExtensionWaitsRuntime({
  listGuests,
  proxyServiceRequest,
  persistPath,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  dataDir,
  // Publishes `openchamber:extension-waits.updated` on the control stream.
  broadcastUiEvent = null,
  isSessionArchived = () => false,
  // The server inside an isolated space runs no extensions.
  insideSpace = false,
  fetchImpl = fetch,
  now = Date.now,
  createId = () => randomUUID(),
  timers = { setTimeout, clearTimeout },
  quietMs = QUIET_MS,
  retryDelayMs = retryDelay,
  subagentRecheckMs = SUBAGENT_RECHECK_MS,
  warn = (...args) => console.warn(...args),
}) {
  const filePath = path.join(dataDir, FILE_NAME);
  /** wait id → wait */
  const waits = new Map();
  let revision = 0;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let stopped = false;
  const controller = new AbortController();
  // Checks: one timer for the earliest due wait, one request per type at a time.
  let checkTimer = null;
  const checking = new Set();
  /** `<guestId>/<type>` → consecutive failed checks */
  const checkFailures = new Map();
  // Delivery, per session: one wake at a time.
  const wakeTimers = new Map();
  const delivering = new Set();
  const deferred = new Set();
  /** wait id → failed delivery attempts */
  const deliveryFailures = new Map();
  // Starts between their cap check and their insertion, per session and in all.
  const reservations = new Map();
  let reservedTotal = 0;

  const waitsOf = (sessionID) => Array.from(waits.values()).filter((wait) => wait.sessionID === sessionID);
  const hasWake = (sessionID) => waitsOf(sessionID).some((wait) => wait.wake);
  const isCurrent = (wait) => !stopped && waits.get(wait.id) === wait;

  // --- persistence ---------------------------------------------------------

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (parse(errorCodeSchema, error)?.code === 'ENOENT') return { waits: [], revision: 0 };
      throw error;
    }
    const stored = parse(storedFileSchema, parseJson(raw));
    if (!stored) {
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      warn(`[extension-waits] file was unreadable and moved to ${backup}`);
      return { waits: [], revision: 0 };
    }
    // One unreadable wait is dropped alone.
    const restored = stored.waits.map((value) => parse(waitSchema, value)).filter(Boolean);
    return { waits: restored, revision: stored.revision ?? 0 };
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const wait of stored.waits) if (!waits.has(wait.id)) waits.set(wait.id, wait);
          // Clients drop anything older than what they applied, and the file
          // may be behind the last run (a failed write, a corrupt file moved
          // aside): starting from the clock keeps the revision rising across restarts.
          revision = Math.max(revision, stored.revision, now());
        })
        .catch((error) => {
          // A failed read must not pass for "no waits": writes wait for a load that succeeds.
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  // Writes run one at a time, each with the waits as they are when it runs.
  const writeWaits = async () => {
    const payload = JSON.stringify({ version: FILE_VERSION, revision, waits: Array.from(waits.values()) });
    await fs.promises.mkdir(dataDir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tmpPath, filePath);
  };

  const enqueue = (step) => {
    const run = writePromise.then(step);
    writePromise = run.then(() => undefined, (error) => {
      warn('[extension-waits] failed to persist waits:', error?.message ?? error);
    });
    return run;
  };

  const persist = () => enqueue(writeWaits);

  const broadcast = (sessionIDs) => {
    for (const sessionID of new Set(sessionIDs)) {
      broadcastUiEvent?.({
        type: 'openchamber:extension-waits.updated',
        properties: { revision, sessionID, waits: waitsOf(sessionID).map(toPublicWait) },
      });
    }
  };

  /**
   * A change to waits OpenChamber already follows (a fired check, an ended
   * wait): memory stays the truth when the write fails, and the next write
   * catches the file up.
   */
  const commit = async (...sessionIDs) => {
    revision += 1;
    try {
      await persist();
    } finally {
      broadcast(sessionIDs);
    }
  };

  /**
   * A change that only counts once it is on disk: starting a wait, removing
   * one, saving a wake's message id. `apply` changes memory and answers how to
   * undo it, or null when there is nothing to change. A failed write undoes
   * it, and clients hear the state they had, so memory, disk, what clients
   * were told and what a restart restores agree. Answers whether it changed anything.
   */
  const mutate = (apply, sessionIDs = []) => enqueue(async () => {
    const undo = apply();
    if (!undo) return false;
    revision += 1;
    try {
      await writeWaits();
    } catch (error) {
      undo();
      // A snapshot read meanwhile may have shown the change: this newer revision takes it back.
      revision += 1;
      broadcast(sessionIDs);
      throw error;
    }
    broadcast(sessionIDs);
    return true;
  });

  /** What the UI reads at mount and after a reconnect. */
  const snapshot = () => ({ revision, waits: Array.from(waits.values(), toPublicWait) });

  // --- the extension's service ---------------------------------------------

  const listProviders = async () => {
    const guests = await listGuests();
    return new Map((Array.isArray(guests) ? guests : []).filter(isWaitProvider).map((guest) => [guest.id, guest]));
  };

  /** Posts one request to the guest's service; answers the parsed JSON body, or throws with a status for the agent. */
  const ask = async (guest, requestPath, body) => {
    let answer;
    try {
      answer = await proxyServiceRequest({
        guestId: guest.id,
        guestName: guest.name,
        packageRoot: guest.packageRoot,
        service: guest.service,
        granted: guest.capabilityGrants,
        persistPath,
        method: 'POST',
        path: requestPath,
        body: JSON.stringify(body),
        timeoutMs: WAIT_REQUEST_TIMEOUT_MS,
        idleStopMs: SERVICE_IDLE_STOP_MS,
        signal: controller.signal,
        responseMax: RESPONSE_MAX,
      });
    } catch (error) {
      const unavailable = UNAVAILABLE_CODES.has(error?.code);
      throw Object.assign(httpError(`The extension's service could not be reached: ${error?.message ?? error}`, unavailable ? 503 : 502), { unavailable });
    }
    if (answer.status !== 200) throw httpError(`The extension's service answered HTTP ${answer.status}`, 502);
    return parseJson(answer.body);
  };

  // --- checks --------------------------------------------------------------

  const scheduleChecks = () => {
    if (checkTimer) timers.clearTimeout(checkTimer);
    checkTimer = null;
    if (stopped) return;
    let next = Infinity;
    // A wait being checked reschedules once its answer is in.
    for (const wait of waits.values()) {
      if (!wait.wake && !checking.has(wait.id) && wait.nextCheckAt < next) next = wait.nextCheckAt;
    }
    if (next === Infinity) return;
    checkTimer = timers.setTimeout(() => {
      checkTimer = null;
      runChecks().catch((error) => warn('[extension-waits] checks failed:', error?.message ?? error));
    }, Math.max(0, next - now()));
    checkTimer.unref?.();
  };

  /** Ends waits OpenChamber can no longer check, with a wake that says why. */
  const endWaits = (ending, reason) => {
    for (const wait of ending) {
      if (!isCurrent(wait) || wait.wake) continue;
      wait.wake = { outcome: 'ended', summary: reason, messageID: null };
    }
  };

  const checkType = async (guest, type, due) => {
    const key = `${guest.id}/${type.id}`;
    const interval = resolveWaitInterval(type);
    for (let start = 0; start < due.length; start += WAITS_CHECK_BATCH_MAX) {
      const batch = due.slice(start, start + WAITS_CHECK_BATCH_MAX).filter(isCurrent);
      if (batch.length === 0) continue;
      let parsed;
      try {
        const body = await ask(guest, WAITS_CHECK_PATH, {
          v: WAITS_WIRE_VERSION,
          requestId: createId(),
          waits: batch.map((wait) => ({ id: wait.id, type: wait.type, args: wait.args, state: wait.state ?? null })),
        });
        parsed = waitCheckResultSchema.safeParse(body);
        if (!parsed.success) throw httpError('The extension\'s service answered a check with an unexpected body', 502);
      } catch (error) {
        const failures = (checkFailures.get(key) ?? 0) + 1;
        checkFailures.set(key, failures);
        if (failures === 1) warn(`[extension-waits] ${key}: a check failed (${error?.message ?? error}); trying again later`);
        const delay = Math.min(interval * 2 ** failures, CHECK_BACKOFF_MAX_MS);
        for (const wait of batch) {
          if (!isCurrent(wait)) continue;
          wait.failingSince ??= now();
          if (now() - wait.failingSince >= CHECK_FAILURE_LIMIT_MS) endWaits([wait], ENDED_REASONS.failing);
          else wait.nextCheckAt = now() + delay;
        }
        continue;
      }
      checkFailures.delete(key);
      for (const wait of batch) wait.failingSince = null;
      const byId = new Map(batch.map((wait) => [wait.id, wait]));
      // Each entry is read on its own: a malformed one ends only its own wait,
      // and would otherwise fail the same way on every check after this one.
      for (const entry of parsed.data.results) {
        const wait = byId.get(entry !== null && typeof entry === 'object' ? entry.id : undefined);
        if (!wait || !isCurrent(wait) || wait.wake) continue;
        const outcome = waitCheckOutcomeSchema.safeParse(entry);
        if (!outcome.success) {
          endWaits([wait], ENDED_REASONS.unreadable);
        } else if (outcome.data.fired) {
          wait.wake = { outcome: 'fired', summary: outcome.data.summary, messageID: null };
        } else if (outcome.data.state !== undefined) {
          wait.state = outcome.data.state;
        }
      }
      for (const wait of batch) if (isCurrent(wait) && !wait.wake) wait.nextCheckAt = now() + interval;
    }
  };

  async function runChecks() {
    if (stopped) return;
    await load();
    const due = Array.from(waits.values()).filter((wait) => !wait.wake && wait.nextCheckAt <= now() && !checking.has(wait.id));
    // Claimed before the first await: a run a stop, a start or a wake schedules
    // meanwhile must not check them a second time.
    for (const wait of due) checking.add(wait.id);
    try {
      if (due.length > 0) await checkDue(due);
    } finally {
      for (const wait of due) checking.delete(wait.id);
    }
    if (stopped) return;
    if (due.length > 0) {
      // A wait that fired or ended reads as waking until its message lands.
      const waking = due.filter((wait) => isCurrent(wait) && wait.wake).map((wait) => wait.sessionID);
      await (waking.length > 0 ? commit(...waking) : persist()).catch(() => undefined);
      for (const sessionID of waking) arm(sessionID, 0);
    }
    scheduleChecks();
  }

  const checkDue = async (dueWaits) => {
    // A timer is due on the clock alone: marked before the catalog read, so a
    // failed read neither ends it nor postpones its check. Its wake still goes
    // out when this pass ends (`runChecks`), after the extension checks.
    for (const wait of dueWaits) {
      if (isTimer(wait)) wait.wake = { outcome: 'fired', summary: `${minutesText(wait.args.minutes)} passed.`, messageID: null };
    }
    const due = dueWaits.filter((wait) => !isTimer(wait));
    if (due.length === 0) return;
    let providers;
    try {
      providers = await listProviders();
    } catch (error) {
      // A catalog that cannot be read changes nothing: it is not an empty catalog.
      warn('[extension-waits] the extension catalog could not be read:', error?.message ?? error);
      for (const wait of due) wait.nextCheckAt = now() + 60_000;
      return;
    }
    /** `<guestId>/<type>` → { guest, type, waits } */
    const groups = new Map();
    const unavailable = [];
    const dropped = [];
    for (const wait of due) {
      const guest = providers.get(wait.guestId);
      const type = guest?.waits.find((entry) => entry.id === wait.type);
      if (!guest) unavailable.push(wait);
      else if (!type) dropped.push(wait);
      else {
        const key = sourceOf(wait);
        if (!groups.has(key)) groups.set(key, { guest, type, waits: [] });
        groups.get(key).waits.push(wait);
      }
    }
    endWaits(unavailable, ENDED_REASONS.unavailable);
    endWaits(dropped, ENDED_REASONS.dropped);
    await Promise.all(Array.from(groups.values(), ({ guest, type, waits: group }) => checkType(guest, type, group)));
  };

  // --- wake ----------------------------------------------------------------

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

  const clearWakeTimer = (sessionID) => {
    const timer = wakeTimers.get(sessionID);
    if (timer) timers.clearTimeout(timer);
    wakeTimers.delete(sessionID);
  };

  const arm = (sessionID, delayMs = quietMs) => {
    if (stopped || !hasWake(sessionID)) return;
    clearWakeTimer(sessionID);
    const timer = timers.setTimeout(() => {
      wakeTimers.delete(sessionID);
      deliver(sessionID).catch((error) => warn('[extension-waits] wake failed:', error?.message ?? error));
    }, Math.max(0, delayMs));
    timer.unref?.();
    wakeTimers.set(sessionID, timer);
  };

  /** Removes these waits of one session, and only them: newer ones stay. */
  // Rejects when the removal could not be saved; the waits then stay, in memory and on disk.
  const drop = async (...ending) => {
    if (ending.length === 0) return;
    const { sessionID } = ending[0];
    let removed;
    try {
      removed = await mutate(() => {
        const current = ending.filter(isCurrent);
        if (current.length === 0) return null;
        const before = Array.from(waits);
        for (const wait of current) waits.delete(wait.id);
        return () => {
          waits.clear();
          for (const [id, wait] of before) waits.set(id, wait);
        };
      }, [sessionID]);
    } catch (error) {
      // A check or a wake that came due while the write was pending saw these waits gone.
      scheduleChecks();
      if (hasWake(sessionID) && !wakeTimers.has(sessionID)) arm(sessionID);
      throw error;
    }
    if (!removed) return;
    for (const wait of ending) deliveryFailures.delete(wait.id);
    if (!hasWake(sessionID)) clearWakeTimer(sessionID);
    // Another wait's wake goes next, unless an attempt is already scheduled.
    else if (!wakeTimers.has(sessionID)) arm(sessionID);
    scheduleChecks();
  };

  const retry = (wait, reason) => {
    if (!isCurrent(wait)) return undefined;
    const count = (deliveryFailures.get(wait.id) ?? 0) + 1;
    deliveryFailures.set(wait.id, count);
    if (count >= MAX_DELIVERY_FAILURES) {
      warn(`[extension-waits] giving up waking ${wait.sessionID}: ${reason}`);
      return drop(wait);
    }
    arm(wait.sessionID, retryDelayMs(count));
    return undefined;
  };

  /** Removes waits a wake is done with; a removal that could not be saved is tried again like a failed delivery. */
  const settle = (wait, ...ending) => drop(...ending).catch((error) => retry(wait, `the wait could not be removed: ${error?.message ?? error}`));

  async function deliver(sessionID) {
    if (delivering.has(sessionID)) {
      // An idle event or another wait's wake while an attempt is in flight:
      // tried again once that attempt is over, never lost.
      deferred.add(sessionID);
      return;
    }
    const wait = waitsOf(sessionID).find((entry) => entry.wake);
    if (stopped || !wait) return;
    delivering.add(sessionID);
    try {
      await attemptWake(wait);
    } finally {
      delivering.delete(sessionID);
      // After the quiet delay: a wake just delivered must first show as a running turn.
      if (deferred.delete(sessionID)) arm(sessionID);
    }
  }

  async function attemptWake(wait) {
    const { sessionID } = wait;
    // Never into a running turn: the user may be talking to the agent.
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!isCurrent(wait)) return undefined;
    if (!statuses) return retry(wait, 'OpenCode could not be asked');
    if (statuses[sessionID]) return undefined; // its idle event arms the next attempt
    const subagents = await activityProbe.hasWorkingChildren(sessionID, statuses);
    if (!isCurrent(wait)) return undefined;
    if (subagents === null) return retry(wait, 'OpenCode could not be asked');
    if (subagents) return arm(sessionID, subagentRecheckMs);
    const archived = await Promise.resolve(isSessionArchived(sessionID)).catch(() => false) === true;
    if (!isCurrent(wait)) return undefined;
    if (archived) return settle(wait, ...waitsOf(sessionID));
    if (!wait.wake.messageID) {
      // No message goes out under an id a restart would not know: a second
      // attempt then mints another and OpenCode admits the wake twice.
      const messageID = createMessageId(now());
      try {
        await mutate(() => {
          const { wake } = wait;
          if (!isCurrent(wait) || !wake || wake.messageID) return null;
          wake.messageID = messageID;
          return () => {
            if (wake.messageID === messageID) wake.messageID = null;
          };
        });
      } catch (error) {
        return retry(wait, `the wake could not be saved: ${error?.message ?? error}`);
      }
      if (!isCurrent(wait) || !wait.wake.messageID) return undefined;
    }
    try {
      await openCodeRequest(`/api/session/${encodeURIComponent(sessionID)}/synthetic`, {
        method: 'POST',
        body: { id: wait.wake.messageID, ...buildWakeMessage(wait), delivery: 'steer', resume: true },
      });
    } catch (error) {
      // 409: an earlier attempt landed. 404: nobody is left to wake.
      if (error?.status !== 409 && error?.status !== 404) return retry(wait, error?.message ?? String(error));
    }
    return settle(wait, wait);
  }

  // --- public --------------------------------------------------------------

  const requireSession = (rawSessionID, action) => {
    const sessionID = parse(sessionIdSchema, rawSessionID);
    if (!sessionID) throw httpError(`${action} must be called from a session`, 400);
    return sessionID;
  };

  /** This session's waits, and every source it may start one on. */
  const listWaits = async (rawSessionID) => {
    const sessionID = requireSession(rawSessionID, 'wait.list');
    await load();
    let providers;
    try {
      providers = await listProviders();
    } catch (error) {
      throw httpError(`The extension catalog could not be read: ${error?.message ?? error}`, 503);
    }
    // The timer is refused inside a space with the rest, so it is not offered there either.
    const sources = insideSpace ? [] : [{ ...TIMER, params: { ...TIMER.params } }];
    for (const guest of providers.values()) for (const wait of guest.waits) sources.push(toPublicSource(guest, wait));
    return { waiting: waitsOf(sessionID).map(toPublicWait), sources };
  };

  /**
   * Starts a wait for `sessionID` on `source` with `args`. An extension's
   * service takes its wait before this answers, so a wait it cannot follow
   * fails now instead of never waking; a timer is kept once its minutes check
   * out.
   */
  const startWait = async ({ sessionID: rawSessionID, directory, source, args: rawArgs }) => {
    if (insideSpace) throw httpError('Waits are not available inside an isolated space', 400);
    const sessionID = requireSession(rawSessionID, 'wait.start');
    const name = typeof source === 'string' ? source.trim() : '';
    if (name === TIMER_SOURCE) return startTimer({ sessionID, directory, rawArgs });
    const match = /^([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/.exec(name);
    if (!match) throw httpError('source must be "timer", or "<extension>/<wait>" as wait.list names it', 400);
    const [, guestId, typeId] = match;
    await load();
    let providers;
    try {
      providers = await listProviders();
    } catch (error) {
      throw httpError(`The extension catalog could not be read: ${error?.message ?? error}`, 503);
    }
    const guest = providers.get(guestId);
    const type = guest?.waits.find((entry) => entry.id === typeId);
    if (!guest || !type) throw httpError(`No extension offers the wait "${source}" here; wait.list names the ones this session can start`, 404);
    const args = parseArgs(type.params, rawArgs);
    // Held until the wait is in or refused, so starts racing past the
    // service request cannot pass the caps together.
    const release = reserve(sessionID);
    try {
      return await admitWait({ sessionID, directory, guest, type, typeId, args, release });
    } finally {
      release();
    }
  };

  /** The agent's arguments checked against a source's params. */
  const parseArgs = (params, rawArgs) => {
    // Some models send a nested object as JSON text (#4591); anything else reaches the schema as sent.
    const given = typeof rawArgs === 'string' ? parseJson(rawArgs) ?? rawArgs : rawArgs;
    const args = waitArgsSchema(params).safeParse(given ?? {});
    if (!args.success) throw httpError(args.error.issues[0]?.message ?? 'args do not match the wait\'s params', 400);
    return args.data;
  };

  /** Starts the built-in timer: no service takes it, so it is kept as soon as its minutes check out. */
  const startTimer = async ({ sessionID, directory, rawArgs }) => {
    const args = parseArgs(TIMER.params, rawArgs);
    const { minutes } = args;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > TIMER_MINUTES_MAX) {
      throw httpError(`minutes must be a whole number from 1 to ${TIMER_MINUTES_MAX}`, 400);
    }
    await load();
    const release = reserve(sessionID);
    try {
      const startedAt = now();
      const record = {
        id: `wait_${createId()}`,
        sessionID,
        directory: directory || null,
        guestId: null,
        extensionName: null,
        type: TIMER_SOURCE,
        title: TIMER.title,
        label: `${minutes} min`,
        args,
        state: null,
        startedAt,
        // Its due time: the one check it gets fires it.
        nextCheckAt: startedAt + minutes * 60_000,
        failingSince: null,
        wake: null,
      };
      return await keepWait(record, release, `A message arrives in this session in ${minutesText(minutes)}. One wake ends the wait: call wait.start again to keep waiting. End your turn now if you have nothing else to do; never wait with a sleep loop.`);
    } finally {
      release();
    }
  };

  /** Counts a start in flight against both caps until it is in or refused; answers its release. */
  const reserve = (sessionID) => {
    const held = reservations.get(sessionID) ?? 0;
    if (waitsOf(sessionID).length + held >= MAX_WAITS_PER_SESSION) {
      throw httpError(`This session already waits on ${MAX_WAITS_PER_SESSION} things; stop one with wait.stop first`, 409);
    }
    // Refused, never evicted: an evicted wait would end without telling its agent.
    if (waits.size + reservedTotal >= MAX_WAITS) throw httpError(`OpenChamber already follows ${MAX_WAITS} waits; try again once some have ended`, 409);
    reservations.set(sessionID, held + 1);
    reservedTotal += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      reservedTotal -= 1;
      const left = (reservations.get(sessionID) ?? 1) - 1;
      if (left > 0) reservations.set(sessionID, left);
      else reservations.delete(sessionID);
    };
  };

  const admitWait = async ({ sessionID, directory, guest, type, typeId, args, release }) => {
    const id = `wait_${createId()}`;
    const body = await ask(guest, WAITS_START_PATH, {
      v: WAITS_WIRE_VERSION,
      requestId: createId(),
      wait: { id, type: typeId, args, session: { id: sessionID, directory: directory || null } },
    });
    const answer = waitStartResultSchema.safeParse(body);
    if (!answer.success) {
      const issue = answer.error.issues[0];
      const field = issue?.path?.length ? ` (${issue.path.join('.')}: ${issue.message})` : '';
      throw httpError(`The extension's service answered the wait with an unexpected body${field}`, 502);
    }
    if (!answer.data.ok) throw httpError(`The extension refused the wait: ${answer.data.error}`, 400);

    const record = {
      id,
      sessionID,
      directory: directory || null,
      guestId: guest.id,
      extensionName: guest.name || null,
      type: typeId,
      title: type.title,
      label: answer.data.label ?? null,
      args,
      state: answer.data.state ?? null,
      startedAt: now(),
      nextCheckAt: now() + resolveWaitInterval(type),
      failingSince: null,
      wake: null,
    };
    return keepWait(record, release, `A message arrives in this session when ${subjectOf(record)} fires: ${type.description}. One wake ends the wait. End your turn now if you have nothing else to do; never wait with a sleep loop.`);
  };

  /** Saves a new wait and answers the agent; a write that fails leaves no wait. */
  const keepWait = async (record, release, next) => {
    try {
      await mutate(() => {
        // The reservation turns into the wait itself.
        release();
        waits.set(record.id, record);
        return () => {
          waits.delete(record.id);
        };
      }, [record.sessionID]);
    } catch (error) {
      throw httpError(`OpenChamber could not save the wait, so it is not waiting: ${error?.message ?? error}`, 500);
    }
    scheduleChecks();
    return { waiting: toPublicWait(record), next };
  };

  /** Stops the wait `waitId`, or every wait of the session without it; nothing it stopped wakes the session. */
  const stopWaits = async (rawSessionID, waitId) => {
    const sessionID = requireSession(rawSessionID, 'wait.stop');
    await load();
    const every = waitId === undefined || waitId === null || waitId === '';
    const ending = waitsOf(sessionID).filter((wait) => every || wait.id === waitId);
    if (!every && ending.length === 0) throw httpError(`This session has no wait ${waitId}; wait.list names its waits`, 404);
    try {
      await drop(...ending);
    } catch (error) {
      throw httpError(`OpenChamber could not save the stop, so the wait goes on: ${error?.message ?? error}`, 500);
    }
    return { waiting: waitsOf(sessionID).map(toPublicWait), stopped: ending.length };
  };

  /**
   * The catalog changed (pause, removal, a withdrawn approval, an update):
   * waits whose extension can no longer wake anyone end now, with a wake.
   */
  const reconcile = async () => {
    if (stopped) return;
    await load();
    let providers;
    try {
      providers = await listProviders();
    } catch {
      return;
    }
    // A timer has no extension that could go away.
    const pending = Array.from(waits.values()).filter((wait) => !wait.wake && !isTimer(wait));
    const unavailable = pending.filter((wait) => !providers.has(wait.guestId));
    const dropped = pending.filter((wait) => providers.get(wait.guestId) && !providers.get(wait.guestId).waits.some((entry) => entry.id === wait.type));
    if (unavailable.length === 0 && dropped.length === 0) return;
    endWaits(unavailable, ENDED_REASONS.unavailable);
    endWaits(dropped, ENDED_REASONS.dropped);
    const sessions = [...unavailable, ...dropped].map((wait) => wait.sessionID);
    await commit(...sessions).catch(() => undefined);
    for (const sessionID of sessions) arm(sessionID, 0);
    scheduleChecks();
  };

  const processPayload = (payload) => {
    if (stopped) return;
    const deleted = parse(deletedEventSchema, payload);
    if (deleted) {
      void drop(...waitsOf(deleted.properties.sessionID)).catch(() => undefined);
      return;
    }
    const status = parse(statusEventSchema, payload);
    if (!status || status.properties.status.type !== 'idle') return;
    if (hasWake(status.properties.sessionID)) arm(status.properties.sessionID);
  };

  const start = (globalEventHub) => {
    const unsubscribeEvent = globalEventHub?.subscribeEvent((event) => {
      for (const payload of event?.translated?.() ?? []) processPayload(payload);
    });
    const unsubscribeStatus = globalEventHub?.subscribeStatus((hubStatus) => {
      if (hubStatus?.type !== 'connect') return;
      for (const wait of waits.values()) if (wait.wake) arm(wait.sessionID);
    });
    void load()
      .then(() => {
        scheduleChecks();
        for (const wait of waits.values()) if (wait.wake) arm(wait.sessionID);
      })
      .catch((error) => warn('[extension-waits] failed to load waits:', error?.message ?? error));
    return () => {
      unsubscribeEvent?.();
      unsubscribeStatus?.();
    };
  };

  const stop = () => {
    stopped = true;
    controller.abort();
    if (checkTimer) timers.clearTimeout(checkTimer);
    checkTimer = null;
    for (const timer of wakeTimers.values()) timers.clearTimeout(timer);
    wakeTimers.clear();
  };

  return {
    load,
    snapshot,
    listWaits,
    startWait,
    stopWaits,
    reconcile,
    processPayload,
    runChecks,
    start,
    stop,
    flush: () => writePromise,
  };
}

export function registerExtensionWaitsRoutes(app, runtime) {
  const respondError = (res, error, fallback) => {
    res.status(Number.isInteger(error?.status) ? error.status : 500).json({ error: error?.message ?? fallback });
  };

  app.get('/api/extension-waits', async (_req, res) => {
    try {
      await runtime.load();
      res.json(runtime.snapshot());
    } catch (error) {
      respondError(res, error, 'Failed to load waits');
    }
  });

  // The user's stop, of the wait at `?waitId=` or of every one: what it stops does not wake the session.
  app.delete('/api/extension-waits/sessions/:sessionID', async (req, res) => {
    try {
      const waitId = typeof req.query.waitId === 'string' ? req.query.waitId : undefined;
      res.json(await runtime.stopWaits(req.params.sessionID, waitId));
    } catch (error) {
      respondError(res, error, 'Failed to stop waiting');
    }
  });
}
