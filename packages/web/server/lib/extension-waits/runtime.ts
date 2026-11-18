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
import { createMessageId } from '../dispatch-results/runtime.js';
import { EXTENSION_WAIT_SOURCE, buildWakeMessage, subjectOf } from './wake-message.js';
import type { GuestWaitParam, WaitContribution } from '@openchamber/sdk';
import type { GuestRecord } from '../guests/contracts.js';
import type { proxyGuestServiceRequest } from '../guests/service.js';
import type { Application, Response } from '../shared/http-contracts.js';
import type { SessionActivityOptions } from '../opencode/session-activity.js';
import type { PrWatchEventHub } from '../pr-watch/runtime.js';
import type { WaitArgs, WakingWait } from './wake-message.js';

export { EXTENSION_WAIT_SOURCE };

const FILE_NAME = 'extension-waits.json';
const FILE_VERSION = 1;
const MAX_WAITS = 200;
const MAX_WAITS_PER_SESSION = 20;
const QUIET_MS = 500;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
const MAX_DELIVERY_FAILURES = 8;
const FETCH_TIMEOUT_MS = 15_000;
const CHECK_BACKOFF_MAX_MS = 10 * 60_000;
const CHECK_FAILURE_LIMIT_MS = 6 * 60 * 60_000;
const SERVICE_IDLE_STOP_MS = 10 * 60_000;
const RESPONSE_MAX = 256 * 1024;

const TIMER_SOURCE = 'timer';
const TIMER_MINUTES_MAX = 24 * 60;
const TIMER = {
  source: TIMER_SOURCE,
  extension: 'OpenChamber',
  title: 'Timer',
  description: 'Wakes the session once the given number of minutes has passed',
  params: { minutes: { type: 'number', description: `Whole minutes, 1 to ${TIMER_MINUTES_MAX}`, required: true } },
} satisfies PublicWaitSource;

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
  guestId: z.string().min(1).nullable(),
  extensionName: z.string().min(1).nullable().catch(null),
  type: z.string().min(1),
  title: z.string().min(1),
  label: z.string().min(1).nullable(),
  args: argsSchema,
  state: z.unknown(),
  startedAt: z.number().finite().nonnegative(),
  nextCheckAt: z.number().finite().nonnegative(),
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

type Wait = Omit<z.output<typeof waitSchema>, 'args'> & { args: WaitArgs };
type WaitProvider = GuestRecord & { waits: WaitContribution[] };
type WaitTimer = ReturnType<typeof setTimeout>;
type Release = () => void;
type ProxyRequest = Omit<Parameters<typeof proxyGuestServiceRequest>[0], 'service'> & { service: GuestRecord['service'] };
type WaitServiceBody = { v: number; requestId: string } & (
  { wait: { id: string; type: string; args: WaitArgs; session: { id: string; directory: string | null } } }
  | { waits: Pick<Wait, 'id' | 'type' | 'args' | 'state'>[] }
);
type OpenCodeRequestHeaders = { Accept: string; 'Content-Type'?: string };

export interface PublicWait {
  waitId: string;
  sessionID: string;
  directory: string | null;
  source: string;
  extension: string;
  title: string;
  label: string | null;
  args: WaitArgs;
  startedAt: number;
  status: 'waking' | 'waiting';
}

export interface PublicWaitSource {
  source: string;
  extension: string;
  title: string;
  description: string;
  params: Record<string, GuestWaitParam>;
}

export interface ExtensionWaitsSnapshot {
  revision: number;
  waits: PublicWait[];
}

export interface StartWaitInput {
  sessionID: unknown;
  directory: string | null | undefined;
  source: unknown;
  args: unknown;
}

export interface StopWaitInput {
  sessionID: unknown;
  waitId?: unknown;
}

export interface ExtensionWaitsOptions extends Pick<SessionActivityOptions, 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders'> {
  listGuests: () => Promise<GuestRecord[]>;
  proxyServiceRequest: (request: ProxyRequest) => ReturnType<typeof proxyGuestServiceRequest>;
  persistPath: string;
  dataDir: string;
  broadcastUiEvent?: ((event: {
    type: 'openchamber:extension-waits.updated';
    properties: ExtensionWaitsSnapshot & { sessionID: string };
  }) => void) | null;
  isSessionArchived?: (sessionID: string) => boolean | Promise<boolean>;
  insideSpace?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  createId?: () => string;
  timers?: { setTimeout: (callback: () => void, delay: number) => WaitTimer; clearTimeout: (timer: WaitTimer) => void };
  quietMs?: number;
  retryDelayMs?: (failures: number) => number;
  warn?: (...args: unknown[]) => void;
}

type Admission = {
  sessionID: string;
  directory: StartWaitInput['directory'];
  guest: WaitProvider;
  type: WaitContribution;
  typeId: string;
  args: WaitArgs;
  release: Release;
};

const isFailureObject = (value: unknown): value is object => value !== null
  && (typeof value === 'object' || typeof value === 'function');
const hasFailureMessage = (value: unknown): value is { message: unknown } => isFailureObject(value) && 'message' in value;
const hasFailureCode = (value: unknown): value is { code: string } => isFailureObject(value)
  && 'code' in value && typeof value.code === 'string';
const hasFailureStatus = (value: unknown): value is { status: unknown } => isFailureObject(value) && 'status' in value;
const failureMessage = (cause: unknown) => hasFailureMessage(cause) ? cause.message : undefined;
const failureCode = (cause: unknown) => hasFailureCode(cause) ? cause.code : undefined;
const failureStatus = (cause: unknown) => hasFailureStatus(cause) ? cause.status : undefined;
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const isTextInput = (value: unknown): value is string => typeof value === 'string';
const isWakingWait = (wait: Wait): wait is Wait & WakingWait => Boolean(wait.wake);
const hasCheckId = (value: unknown): value is { id: string } => value !== null
  && typeof value === 'object' && 'id' in value && typeof value.id === 'string';

const parse = <S extends z.ZodType>(schema: S, value: Parameters<S['safeParse']>[0]): z.output<S> | null => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const parseJson = (text: string) => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
};

const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });

const retryDelay = (failures: number) => Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

export const isWaitProvider = (guest: GuestRecord | null | undefined): guest is WaitProvider => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return !!guest
    && guest.enabled !== false
    && Array.isArray(guest.waits)
    && guest.waits.length > 0
    && granted.includes('service')
    && granted.includes('wake')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted });
};

const isTimer = (wait: Wait) => wait.guestId === null;

const sourceOf = (wait: Wait) => (isTimer(wait) ? TIMER_SOURCE : `${wait.guestId}/${wait.type}`);

const minutesText = (minutes: WaitArgs[string]) => (minutes === 1 ? '1 minute' : `${minutes} minutes`);

const toPublicWait = (wait: Wait): PublicWait => ({
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

const toPublicSource = (guest: WaitProvider, wait: WaitContribution): PublicWaitSource => ({
  source: `${guest.id}/${wait.id}`,
  extension: guest.name || guest.id,
  title: wait.title,
  description: wait.description,
  params: { ...(wait.params ?? {}) },
});

const UNAVAILABLE_CODES = new Set(['NO_SERVICE', 'DISABLED', 'CANCELLED']);

export function createExtensionWaitsRuntime({
  listGuests,
  proxyServiceRequest,
  persistPath,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  dataDir,
  broadcastUiEvent = null,
  isSessionArchived = () => false,
  insideSpace = false,
  fetchImpl = fetch,
  now = Date.now,
  createId = () => randomUUID(),
  timers = { setTimeout, clearTimeout },
  quietMs = QUIET_MS,
  retryDelayMs = retryDelay,
  warn = (...args) => console.warn(...args),
}: ExtensionWaitsOptions) {
  const filePath = path.join(dataDir, FILE_NAME);
  const waits = new Map<string, Wait>();
  let revision = 0;
  let loadPromise: Promise<void> | null = null;
  let writePromise = Promise.resolve();
  let stopped = false;
  const controller = new AbortController();
  let checkTimer: WaitTimer | null = null;
  const checking = new Set<string>();
  const checkFailures = new Map<string, number>();
  const wakeTimers = new Map<string, WaitTimer>();
  const delivering = new Set<string>();
  const deferred = new Set<string>();
  const deliveryFailures = new Map<string, number>();
  const reservations = new Map<string, number>();
  let reservedTotal = 0;

  const waitsOf = (sessionID: string) => Array.from(waits.values()).filter((wait) => wait.sessionID === sessionID);
  const hasWake = (sessionID: string) => waitsOf(sessionID).some((wait) => wait.wake);
  const isCurrent = (wait: Wait) => !stopped && waits.get(wait.id) === wait;


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
    const restored = stored.waits.map((value) => parse(waitSchema, value)).filter((wait) => wait !== null);
    return { waits: restored, revision: stored.revision ?? 0 };
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const wait of stored.waits) if (!waits.has(wait.id)) waits.set(wait.id, wait);
          revision = Math.max(revision, stored.revision, now());
        })
        .catch((error) => {
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const writeWaits = async () => {
    const payload = JSON.stringify({ version: FILE_VERSION, revision, waits: Array.from(waits.values()) });
    await fs.promises.mkdir(dataDir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tmpPath, filePath);
  };

  const enqueue = <T>(step: () => Promise<T>) => {
    const run = writePromise.then(step);
    writePromise = run.then(() => undefined, (error) => {
      warn('[extension-waits] failed to persist waits:', failureMessage(error) ?? error);
    });
    return run;
  };

  const persist = () => enqueue(writeWaits);

  const broadcast = (sessionIDs: string[]) => {
    for (const sessionID of new Set(sessionIDs)) {
      broadcastUiEvent?.({
        type: 'openchamber:extension-waits.updated',
        properties: { revision, sessionID, waits: waitsOf(sessionID).map(toPublicWait) },
      });
    }
  };

  const commit = async (...sessionIDs: string[]) => {
    revision += 1;
    try {
      await persist();
    } finally {
      broadcast(sessionIDs);
    }
  };

  const mutate = (apply: () => Release | null, sessionIDs: string[] = []) => enqueue(async () => {
    const undo = apply();
    if (!undo) return false;
    revision += 1;
    try {
      await writeWaits();
    } catch (error) {
      undo();
      revision += 1;
      broadcast(sessionIDs);
      throw error;
    }
    broadcast(sessionIDs);
    return true;
  });

  const snapshot = (): ExtensionWaitsSnapshot => ({ revision, waits: Array.from(waits.values(), toPublicWait) });


  const listProviders = async () => {
    const guests = await listGuests();
    return new Map((Array.isArray(guests) ? guests : []).filter(isWaitProvider).map((guest) => [guest.id, guest]));
  };

  const ask = async (guest: WaitProvider, requestPath: string, body: WaitServiceBody) => {
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
      const unavailable = UNAVAILABLE_CODES.has(failureCode(error) ?? '');
      throw Object.assign(httpError(`The extension's service could not be reached: ${failureMessage(error) ?? error}`, unavailable ? 503 : 502), { unavailable });
    }
    if (answer.status !== 200) throw httpError(`The extension's service answered HTTP ${answer.status}`, 502);
    return parseJson(answer.body);
  };


  const scheduleChecks = () => {
    if (checkTimer) timers.clearTimeout(checkTimer);
    checkTimer = null;
    if (stopped) return;
    let next = Infinity;
    for (const wait of waits.values()) {
      if (!wait.wake && !checking.has(wait.id) && wait.nextCheckAt < next) next = wait.nextCheckAt;
    }
    if (next === Infinity) return;
    checkTimer = timers.setTimeout(() => {
      checkTimer = null;
      runChecks().catch((error) => warn('[extension-waits] checks failed:', failureMessage(error) ?? error));
    }, Math.max(0, next - now()));
    checkTimer.unref?.();
  };

  const endWaits = (ending: Wait[], reason: string) => {
    for (const wait of ending) {
      if (!isCurrent(wait) || wait.wake) continue;
      wait.wake = { outcome: 'ended', summary: reason, messageID: null };
    }
  };

  const checkType = async (guest: WaitProvider, type: WaitContribution, due: Wait[]) => {
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
        if (failures === 1) warn(`[extension-waits] ${key}: a check failed (${failureMessage(error) ?? error}); trying again later`);
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
      for (const entry of parsed.data.results) {
        const wait = hasCheckId(entry) ? byId.get(entry.id) : undefined;
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
    for (const wait of due) checking.add(wait.id);
    try {
      if (due.length > 0) await checkDue(due);
    } finally {
      for (const wait of due) checking.delete(wait.id);
    }
    if (stopped) return;
    if (due.length > 0) {
      const waking = due.filter((wait) => isCurrent(wait) && wait.wake).map((wait) => wait.sessionID);
      await (waking.length > 0 ? commit(...waking) : persist()).catch(() => undefined);
      for (const sessionID of waking) arm(sessionID, 0);
    }
    scheduleChecks();
  }

  const checkDue = async (dueWaits: Wait[]) => {
    for (const wait of dueWaits) {
      if (isTimer(wait)) wait.wake = { outcome: 'fired', summary: `${minutesText(wait.args.minutes)} passed.`, messageID: null };
    }
    const due = dueWaits.filter((wait) => !isTimer(wait));
    if (due.length === 0) return;
    let providers;
    try {
      providers = await listProviders();
    } catch (error) {
      warn('[extension-waits] the extension catalog could not be read:', failureMessage(error) ?? error);
      for (const wait of due) wait.nextCheckAt = now() + 60_000;
      return;
    }
    const groups = new Map<string, { guest: WaitProvider; type: WaitContribution; waits: Wait[] }>();
    const unavailable: Wait[] = [];
    const dropped: Wait[] = [];
    for (const wait of due) {
      const guest = wait.guestId === null ? undefined : providers.get(wait.guestId);
      const type = guest?.waits.find((entry) => entry.id === wait.type);
      if (!guest) unavailable.push(wait);
      else if (!type) dropped.push(wait);
      else {
        const key = sourceOf(wait);
        let group = groups.get(key);
        if (!group) {
          group = { guest, type, waits: [] };
          groups.set(key, group);
        }
        group.waits.push(wait);
      }
    }
    endWaits(unavailable, ENDED_REASONS.unavailable);
    endWaits(dropped, ENDED_REASONS.dropped);
    await Promise.all(Array.from(groups.values(), ({ guest, type, waits: group }) => checkType(guest, type, group)));
  };


  const openCodeRequest = async (fetchPath: string, { method = 'GET', body }: {
    method?: string;
    body?: ReturnType<typeof buildWakeMessage> & { id: string; delivery: 'steer'; resume: true };
  } = {}) => {
    const headers: OpenCodeRequestHeaders = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
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

  const clearWakeTimer = (sessionID: string) => {
    const timer = wakeTimers.get(sessionID);
    if (timer) timers.clearTimeout(timer);
    wakeTimers.delete(sessionID);
  };

  const arm = (sessionID: string, delayMs = quietMs) => {
    if (stopped || !hasWake(sessionID)) return;
    clearWakeTimer(sessionID);
    const timer = timers.setTimeout(() => {
      wakeTimers.delete(sessionID);
      deliver(sessionID).catch((error) => warn('[extension-waits] wake failed:', failureMessage(error) ?? error));
    }, Math.max(0, delayMs));
    timer.unref?.();
    wakeTimers.set(sessionID, timer);
  };

  const drop = async (...ending: Wait[]) => {
    const [first] = ending;
    if (!first) return;
    const { sessionID } = first;
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
      scheduleChecks();
      if (hasWake(sessionID) && !wakeTimers.has(sessionID)) arm(sessionID);
      throw error;
    }
    if (!removed) return;
    for (const wait of ending) deliveryFailures.delete(wait.id);
    if (!hasWake(sessionID)) clearWakeTimer(sessionID);
    else if (!wakeTimers.has(sessionID)) arm(sessionID);
    scheduleChecks();
  };

  const retry = (wait: Wait, cause: unknown): Promise<void> | undefined => {
    if (!isCurrent(wait)) return undefined;
    const count = (deliveryFailures.get(wait.id) ?? 0) + 1;
    deliveryFailures.set(wait.id, count);
    if (count >= MAX_DELIVERY_FAILURES) {
      warn(`[extension-waits] giving up waking ${wait.sessionID}: ${cause}`);
      return drop(wait);
    }
    arm(wait.sessionID, retryDelayMs(count));
    return undefined;
  };

  const settle = (wait: Wait, ...ending: Wait[]) => drop(...ending).catch((error) => retry(wait, `the wait could not be removed: ${failureMessage(error) ?? error}`));

  async function deliver(sessionID: string) {
    if (delivering.has(sessionID)) {
      deferred.add(sessionID);
      return;
    }
    const wait = waitsOf(sessionID).find(isWakingWait);
    if (stopped || !wait) return;
    delivering.add(sessionID);
    try {
      await attemptWake(wait);
    } finally {
      delivering.delete(sessionID);
      if (deferred.delete(sessionID)) arm(sessionID);
    }
  }

  async function attemptWake(wait: Wait & WakingWait) {
    const { sessionID } = wait;
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!isCurrent(wait)) return undefined;
    if (!statuses) return retry(wait, 'OpenCode could not be asked');
    if (statuses[sessionID]) return undefined;
    const archived = await Promise.resolve(isSessionArchived(sessionID)).catch(() => false) === true;
    if (!isCurrent(wait)) return undefined;
    if (archived) return settle(wait, ...waitsOf(sessionID));
    if (!wait.wake.messageID) {
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
        return retry(wait, `the wake could not be saved: ${failureMessage(error) ?? error}`);
      }
      if (!isCurrent(wait) || !wait.wake.messageID) return undefined;
    }
    try {
      await openCodeRequest(`/api/session/${encodeURIComponent(sessionID)}/synthetic`, {
        method: 'POST',
        body: { id: wait.wake.messageID, ...buildWakeMessage(wait, sourceOf(wait), isTimer(wait)), delivery: 'steer', resume: true },
      });
    } catch (error) {
      if (failureStatus(error) !== 409 && failureStatus(error) !== 404) return retry(wait, failureMessage(error) ?? String(error));
    }
    return settle(wait, wait);
  }


  const requireSession = (rawSessionID: StartWaitInput['sessionID'], action: string) => {
    const sessionID = parse(sessionIdSchema, rawSessionID);
    if (!sessionID) throw httpError(`${action} must be called from a session`, 400);
    return sessionID;
  };

  const listWaits = async (rawSessionID: StartWaitInput['sessionID']) => {
    const sessionID = requireSession(rawSessionID, 'wait.list');
    await load();
    let providers;
    try {
      providers = await listProviders();
    } catch (error) {
      throw httpError(`The extension catalog could not be read: ${failureMessage(error) ?? error}`, 503);
    }
    const sources: PublicWaitSource[] = insideSpace ? [] : [{ ...TIMER, params: { ...TIMER.params } }];
    for (const guest of providers.values()) for (const wait of guest.waits) sources.push(toPublicSource(guest, wait));
    return { waiting: waitsOf(sessionID).map(toPublicWait), sources };
  };

  const startWait = async ({ sessionID: rawSessionID, directory, source, args: rawArgs }: StartWaitInput) => {
    if (insideSpace) throw httpError('Waits are not available inside an isolated space', 400);
    const sessionID = requireSession(rawSessionID, 'wait.start');
    const name = isTextInput(source) ? source.trim() : '';
    if (name === TIMER_SOURCE) return startTimer({ sessionID, directory, rawArgs });
    const match = /^([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/.exec(name);
    if (!match) throw httpError('source must be "timer", or "<extension>/<wait>" as wait.list names it', 400);
    const guestId = match[1] ?? '';
    const typeId = match[2] ?? '';
    await load();
    let providers;
    try {
      providers = await listProviders();
    } catch (error) {
      throw httpError(`The extension catalog could not be read: ${failureMessage(error) ?? error}`, 503);
    }
    const guest = providers.get(guestId);
    const type = guest?.waits.find((entry) => entry.id === typeId);
    if (!guest || !type) throw httpError(`No extension offers the wait "${source}" here; wait.list names the ones this session can start`, 404);
    const args = parseArgs(type.params, rawArgs);
    const release = reserve(sessionID);
    try {
      return await admitWait({ sessionID, directory, guest, type, typeId, args, release });
    } finally {
      release();
    }
  };

  const parseArgs = (params: Record<string, GuestWaitParam> | undefined, rawArgs: StartWaitInput['args']) => {
    const given = isTextInput(rawArgs) ? parseJson(rawArgs) ?? rawArgs : rawArgs;
    const args = waitArgsSchema(params).safeParse(given ?? {});
    if (!args.success) throw httpError(args.error.issues[0]?.message ?? 'args do not match the wait\'s params', 400);
    return args.data;
  };

  const startTimer = async ({ sessionID, directory, rawArgs }: { sessionID: string; directory: StartWaitInput['directory']; rawArgs: unknown }) => {
    const args = parseArgs(TIMER.params, rawArgs);
    const { minutes } = args;
    if (!isInteger(minutes) || minutes < 1 || minutes > TIMER_MINUTES_MAX) {
      throw httpError(`minutes must be a whole number from 1 to ${TIMER_MINUTES_MAX}`, 400);
    }
    await load();
    const release = reserve(sessionID);
    try {
      const startedAt = now();
      const record: Wait = {
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
        nextCheckAt: startedAt + minutes * 60_000,
        failingSince: null,
        wake: null,
      };
      return await keepWait(record, release, `A message arrives in this session in ${minutesText(minutes)}. One wake ends the wait: call wait.start again to keep waiting. End your turn now if you have nothing else to do; never wait with a sleep loop.`);
    } finally {
      release();
    }
  };

  const reserve = (sessionID: string) => {
    const held = reservations.get(sessionID) ?? 0;
    if (waitsOf(sessionID).length + held >= MAX_WAITS_PER_SESSION) {
      throw httpError(`This session already waits on ${MAX_WAITS_PER_SESSION} things; stop one with wait.stop first`, 409);
    }
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

  const admitWait = async ({ sessionID, directory, guest, type, typeId, args, release }: Admission) => {
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

    const record: Wait = {
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

  const keepWait = async (record: Wait, release: Release, next: string) => {
    try {
      await mutate(() => {
        release();
        waits.set(record.id, record);
        return () => {
          waits.delete(record.id);
        };
      }, [record.sessionID]);
    } catch (error) {
      throw httpError(`OpenChamber could not save the wait, so it is not waiting: ${failureMessage(error) ?? error}`, 500);
    }
    scheduleChecks();
    return { waiting: toPublicWait(record), next };
  };

  const stopWaits = async (rawSessionID: StopWaitInput['sessionID'], waitId?: StopWaitInput['waitId']) => {
    const sessionID = requireSession(rawSessionID, 'wait.stop');
    await load();
    const every = waitId === undefined || waitId === null || waitId === '';
    const ending = waitsOf(sessionID).filter((wait) => every || wait.id === waitId);
    if (!every && ending.length === 0) throw httpError(`This session has no wait ${waitId}; wait.list names its waits`, 404);
    try {
      await drop(...ending);
    } catch (error) {
      throw httpError(`OpenChamber could not save the stop, so the wait goes on: ${failureMessage(error) ?? error}`, 500);
    }
    return { waiting: waitsOf(sessionID).map(toPublicWait), stopped: ending.length };
  };

  const reconcile = async () => {
    if (stopped) return;
    await load();
    let providers;
    try {
      providers = await listProviders();
    } catch {
      return;
    }
    const pending = Array.from(waits.values()).filter((wait) => !wait.wake && !isTimer(wait));
    const unavailable = pending.filter((wait) => wait.guestId === null || !providers.has(wait.guestId));
    const dropped = pending.filter((wait) => {
      const guest = wait.guestId === null ? undefined : providers.get(wait.guestId);
      return guest && !guest.waits.some((entry) => entry.id === wait.type);
    });
    if (unavailable.length === 0 && dropped.length === 0) return;
    endWaits(unavailable, ENDED_REASONS.unavailable);
    endWaits(dropped, ENDED_REASONS.dropped);
    const sessions = [...unavailable, ...dropped].map((wait) => wait.sessionID);
    await commit(...sessions).catch(() => undefined);
    for (const sessionID of sessions) arm(sessionID, 0);
    scheduleChecks();
  };

  const processPayload = (payload: Parameters<typeof statusEventSchema.safeParse>[0]) => {
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

  const start = (globalEventHub?: PrWatchEventHub | null) => {
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
      .catch((error) => warn('[extension-waits] failed to load waits:', failureMessage(error) ?? error));
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

export function registerExtensionWaitsRoutes(app: Application, runtime: ReturnType<typeof createExtensionWaitsRuntime>) {
  const respondError = (res: Response, cause: unknown, fallback: string) => {
    const status = failureStatus(cause);
    res.status(isInteger(status) ? status : 500).json({ error: failureMessage(cause) ?? fallback });
  };

  app.get('/api/extension-waits', async (_req, res) => {
    try {
      await runtime.load();
      res.json(runtime.snapshot());
    } catch (error) {
      respondError(res, error, 'Failed to load waits');
    }
  });

  app.delete('/api/extension-waits/sessions/:sessionID', async (req, res) => {
    try {
      const waitId = isTextInput(req.query.waitId) ? req.query.waitId : undefined;
      res.json(await runtime.stopWaits(req.params.sessionID, waitId));
    } catch (error) {
      respondError(res, error, 'Failed to stop waiting');
    }
  });
}
