/**
 * How a service calls OpenChamber on its own: the service side of the callback
 * listener. Zod-free, so a service bundle stays small; the host parses what it
 * receives with `serviceHostCallSchema` (`service-host-schemas.ts`).
 *
 * Every call carries `OPENCHAMBER_SERVICE_TOKEN` as its bearer, which names the
 * service. The host decides each call from the catalog at that moment: a paused
 * extension or a withdrawn approval is refused, whatever the running process
 * still holds.
 */

import type { JsonValue } from './contract.ts';

/** Callback route of every service call. */
export const SERVICE_HOST_PATH = '/service/call';
/** Environment variable with the callback listener's address. */
export const OPENCHAMBER_HOST_CALLBACK_URL_ENV = 'OPENCHAMBER_HOST_CALLBACK_URL';

/** Characters of a prompt a service sends. */
export const SERVICE_PROMPT_MAX = 64_000;
/** Characters of the text a service adds to a session's instructions. */
export const SERVICE_INSTRUCTIONS_MAX = 4_096;
/** Characters of a panel event's topic. */
export const SERVICE_EVENT_TOPIC_MAX = 64;
/** Serialized characters of a panel event's data. */
export const SERVICE_EVENT_DATA_MAX = 64_000;
/** Events per second one service may send its panels; the rest are refused. */
export const SERVICE_EVENT_RATE_MAX = 30;
/** Characters of the message on the extension's card. */
export const SERVICE_STATUS_MESSAGE_MAX = 200;
/** How long a service call may take. */
export const SERVICE_HOST_TIMEOUT_MS = 30_000;

/** Route on the service loopback OpenChamber posts each scheduled run to. */
export const SERVICE_SCHEDULE_PATH = '/schedule';
/** The `v` of every scheduled run; a service answers a version it does not know with HTTP 400. */
export const SERVICE_SCHEDULE_WIRE_VERSION = 1;
/** One scheduled run may take this long to be taken. */
export const SERVICE_SCHEDULE_TIMEOUT_MS = 10_000;
/** No scheduled run for this long stops a service nothing else keeps up. */
export const SERVICE_SCHEDULE_IDLE_MS = 10 * 60_000;
/** How many `service.schedule` entries a package may declare. */
export const SERVICE_SCHEDULE_MAX = 8;
/** Characters of a schedule's cron expression. */
export const SERVICE_SCHEDULE_CRON_MAX = 64;
/** Characters of a schedule's timezone. */
export const SERVICE_SCHEDULE_TIMEZONE_MAX = 64;

/** One `service.schedule` entry: five cron fields, in `timezone` or the host's own. */
export type ServiceScheduleEntry = {
  id: string;
  cron: string;
  timezone?: string;
};

/** What OpenChamber posts to `SERVICE_SCHEDULE_PATH` when an entry comes due. */
export type ServiceScheduleRequest = {
  v: typeof SERVICE_SCHEDULE_WIRE_VERSION;
  requestId: string;
  id: string;
  /** The minute this run was due, epoch milliseconds. */
  at: number;
};

/** A cron expression of five fields, minute first, as a manifest may write it. */
export const isServiceScheduleCron = (value: string): boolean => (
  value.length <= SERVICE_SCHEDULE_CRON_MAX && /^[A-Za-z0-9*/,\-?]+(?: +[A-Za-z0-9*/,\-?]+){4}$/.test(value)
);

export const readServiceScheduleRequest = (body: string): ServiceScheduleRequest | null => {
  let wire: { v?: unknown; requestId?: unknown; id?: unknown; at?: unknown } | null;
  try {
    wire = JSON.parse(body);
  } catch {
    return null;
  }
  if (Object(wire) !== wire || wire === null) return null;
  const { v, requestId, id, at } = wire;
  if (v !== SERVICE_SCHEDULE_WIRE_VERSION) return null;
  if (String(requestId) !== requestId || requestId.length === 0) return null;
  if (String(id) !== id || id.length === 0) return null;
  if (!Number.isFinite(at)) return null;
  return { v: SERVICE_SCHEDULE_WIRE_VERSION, requestId, id, at: Number(at) };
};

/** Route on the service loopback the composer's `@` menu searches. */
export const MENTIONS_SEARCH_PATH = '/mentions/search';
/** Route on the service loopback a picked row is read from when the message goes out. */
export const MENTIONS_RESOLVE_PATH = '/mentions/resolve';
/** A search may take this long; a slower service adds nothing to the menu. */
export const MENTIONS_SEARCH_TIMEOUT_MS = 2_000;
/** Reading a picked row may take this long; past it the send stops and says so. */
export const MENTIONS_RESOLVE_TIMEOUT_MS = 10_000;
/** No mention call for this long stops a service nothing else keeps up. */
export const MENTIONS_IDLE_MS = 10 * 60_000;
/** Rows one service adds to the menu. */
export const MENTIONS_ITEMS_MAX = 20;
/** Characters of a row's title, subtitle, and id. */
export const MENTION_TITLE_MAX = 120;
export const MENTION_ID_MAX = 256;
/** Characters of the context a picked row gives the agent. */
export const MENTION_TEXT_MAX = 16_000;

/** What OpenChamber posts to `MENTIONS_SEARCH_PATH`. `directory` is the composer's project. */
export type MentionsSearchRequest = { query: string; directory: string | null };
/** `url` is what the chip opens; without one the chip reopens the extension. */
export type MentionsItem = { id: string; title: string; subtitle?: string; url?: string };
export type MentionsSearchResult = { items: MentionsItem[] };
/** What OpenChamber posts to `MENTIONS_RESOLVE_PATH`. */
export type MentionsResolveRequest = { id: string };
/** The text the agent reads with the message; the user sees only the chip. */
export type MentionsResolveResult = { text: string };

/** Starts a session and sends it `prompt`. `projectId` and `directory` name one scope; give at most one. */
export type ServiceSessionStart = {
  prompt: string;
  projectId?: string;
  directory?: string;
  title?: string;
  /** `provider/model`; the user's default without it. */
  model?: string;
  variant?: string;
  agent?: string;
};

export type ServiceSessionStarted = { sessionId: string; directory: string | null };
export type ServiceSessionSent = { sent: true };
/** `waiting` is a session only the user can move on. */
export type ServiceSessionStatus = { status: 'idle' | 'busy' | 'waiting' };
/** The agent's last answer, `null` before it gave one. */
export type ServiceSessionReply = { reply: string | null };

export type ServiceHostCalls = {
  'sessions.start': { input: ServiceSessionStart; result: ServiceSessionStarted };
  'sessions.send': { input: { sessionId: string; prompt: string }; result: ServiceSessionSent };
  'sessions.retry': { input: { sessionId: string }; result: ServiceSessionSent };
  'sessions.status': { input: { sessionId: string }; result: ServiceSessionStatus };
  'sessions.lastReply': { input: { sessionId: string }; result: ServiceSessionReply };
  'instructions.set': { input: { directory: string | null; text: string }; result: { saved: true } };
  'panels.emit': { input: { topic: string; data?: JsonValue }; result: { delivered: true } };
  'settings.read': { input: Record<string, never>; result: { settings: Record<string, string> } };
  'status.set': { input: { needsConfiguration: string | null }; result: { saved: true } };
};

export type ServiceHostMethod = keyof ServiceHostCalls;

export const SERVICE_HOST_METHODS = [
  'sessions.start', 'sessions.send', 'sessions.retry', 'sessions.status', 'sessions.lastReply',
  'instructions.set', 'panels.emit', 'settings.read', 'status.set',
] as const satisfies readonly ServiceHostMethod[];

/** A refused call: `code` says why, `message` what to do about it. */
export class ServiceHostError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ServiceHostError';
    this.code = code;
    this.status = status;
  }
}

type ServiceHostEnv = Record<string, string | undefined>;

export type ServiceHost = {
  sessions: {
    start: (input: ServiceSessionStart) => Promise<ServiceSessionStarted>;
    send: (sessionId: string, prompt: string) => Promise<ServiceSessionSent>;
    /** Sends the session's last message again, for a turn that failed. */
    retry: (sessionId: string) => Promise<ServiceSessionSent>;
    status: (sessionId: string) => Promise<ServiceSessionStatus>;
    /** Needs `sessionControl.content`. */
    lastReply: (sessionId: string) => Promise<ServiceSessionReply>;
  };
  /** Text the agent reads in every session under `directory`, or everywhere with `null`. Empty text removes it. */
  setInstructions: (directory: string | null, text: string) => Promise<{ saved: true }>;
  /** Sends `data` to the extension's open frames, which hear it through `host.onServiceEvent`. */
  emit: (topic: string, data?: JsonValue) => Promise<{ delivered: true }>;
  /** The fields of `contributes.integration.settings`, the `secret` ones included. */
  readSettings: () => Promise<Record<string, string>>;
  /** Shows `message` on the extension's card until cleared with `null`. */
  needsConfiguration: (message: string | null) => Promise<{ saved: true }>;
};

/**
 * The service's way back into OpenChamber. Throws `ServiceHostError` on a
 * refusal; `HOST_UNAVAILABLE` when there was no usable answer.
 */
export const createServiceHost = ({ env }: { env: ServiceHostEnv }): ServiceHost => {
  const call = async <M extends ServiceHostMethod>(method: M, input: ServiceHostCalls[M]['input']): Promise<ServiceHostCalls[M]['result']> => {
    const base = env[OPENCHAMBER_HOST_CALLBACK_URL_ENV];
    const token = env.OPENCHAMBER_SERVICE_TOKEN;
    if (!base || !token) throw new ServiceHostError('This service was not started by OpenChamber.', 'HOST_UNAVAILABLE', 0);
    let response: Response;
    try {
      response = await fetch(`${base.replace(/\/+$/, '')}${SERVICE_HOST_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, input }),
        signal: AbortSignal.timeout(SERVICE_HOST_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceHostError('OpenChamber did not answer.', 'HOST_UNAVAILABLE', 0);
    }
    const body: { result?: ServiceHostCalls[M]['result']; error?: { message?: string; code?: string } } | null = await response.json().catch(() => null);
    if (response.ok && body?.result !== undefined) return body.result;
    throw new ServiceHostError(
      body?.error?.message ?? `OpenChamber answered HTTP ${response.status}.`,
      body?.error?.code ?? 'HOST_UNAVAILABLE',
      response.status,
    );
  };
  return {
    sessions: {
      start: (input) => call('sessions.start', input),
      send: (sessionId, prompt) => call('sessions.send', { sessionId, prompt }),
      retry: (sessionId) => call('sessions.retry', { sessionId }),
      status: (sessionId) => call('sessions.status', { sessionId }),
      lastReply: (sessionId) => call('sessions.lastReply', { sessionId }),
    },
    setInstructions: (directory, text) => call('instructions.set', { directory, text }),
    emit: (topic, data) => call('panels.emit', { topic, data }),
    readSettings: () => call('settings.read', {}).then(({ settings }) => settings),
    needsConfiguration: (message) => call('status.set', { needsConfiguration: message }),
  };
};
