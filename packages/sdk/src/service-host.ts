
import type { JsonValue } from './contract.ts';
import type { GuestTone } from './manifest.ts';

export const SERVICE_HOST_PATH = '/service/call';
export const OPENCHAMBER_HOST_CALLBACK_URL_ENV = 'OPENCHAMBER_HOST_CALLBACK_URL';

export const SERVICE_PROMPT_MAX = 64_000;
export const SERVICE_INSTRUCTIONS_MAX = 4_096;
export const SERVICE_EVENT_TOPIC_MAX = 64;
export const SERVICE_EVENT_DATA_MAX = 64_000;
export const SERVICE_EVENT_RATE_MAX = 30;
export const SERVICE_STATUS_MESSAGE_MAX = 200;
export const SERVICE_MARK_TEXT_MAX = 200;
export const SERVICE_MARK_URL_MAX = 2_048;
export const SERVICE_MARKS_MAX = 200;
export const SERVICE_MARK_RATE_MAX = 60;
export const SERVICE_HOST_TIMEOUT_MS = 30_000;

export const SERVICE_SCHEDULE_PATH = '/schedule';
export const SERVICE_SCHEDULE_WIRE_VERSION = 1;
export const SERVICE_SCHEDULE_TIMEOUT_MS = 10_000;
export const SERVICE_SCHEDULE_IDLE_MS = 10 * 60_000;
export const SERVICE_SCHEDULE_MAX = 8;
export const SERVICE_SCHEDULE_CRON_MAX = 64;
export const SERVICE_SCHEDULE_TIMEZONE_MAX = 64;

export type ServiceScheduleEntry = {
  id: string;
  cron: string;
  timezone?: string;
};

export type ServiceScheduleRequest = {
  v: typeof SERVICE_SCHEDULE_WIRE_VERSION;
  requestId: string;
  id: string;
  at: number;
};

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

export const MENTIONS_SEARCH_PATH = '/mentions/search';
export const MENTIONS_RESOLVE_PATH = '/mentions/resolve';
export const MENTIONS_SEARCH_TIMEOUT_MS = 2_000;
export const MENTIONS_RESOLVE_TIMEOUT_MS = 10_000;
export const MENTIONS_IDLE_MS = 10 * 60_000;
export const MENTIONS_ITEMS_MAX = 20;
export const MENTION_TITLE_MAX = 120;
export const MENTION_ID_MAX = 256;
export const MENTION_TEXT_MAX = 16_000;

export type MentionsSearchRequest = { query: string; directory: string | null };
export type MentionsItem = { id: string; title: string; subtitle?: string; url?: string };
export type MentionsSearchResult = { items: MentionsItem[] };
export type MentionsResolveRequest = { id: string };
export type MentionsResolveResult = { text: string };

export type ServiceSessionStart = {
  prompt: string;
  projectId?: string;
  directory?: string;
  title?: string;
  model?: string;
  variant?: string;
  agent?: string;
};

export type ServiceSessionStarted = { sessionId: string; directory: string | null };
export type ServiceSessionSent = { sent: true };
export type ServiceSessionStatus = { status: 'idle' | 'busy' | 'waiting' };
export type ServiceSessionReply = { reply: string | null };
export type ServiceSessionStopped = { stopped: boolean };
export type ServicePermissionAnswer = { decision: 'allow' | 'deny'; message?: string };
export type ServiceFormValues = Record<string, string | number | boolean | string[]>;
export type ServiceAnswered = { answered: true };

export type ServiceMarkTarget = { sessionId: string } | { directory: string; branch?: string };

export type ServiceMark = {
  icon: string;
  tone: GuestTone;
  text: string;
  url?: string;
};

export const SERVICE_ANSWER_MESSAGE_MAX = 2_000;

export type ServiceHostCalls = {
  'sessions.start': { input: ServiceSessionStart; result: ServiceSessionStarted };
  'sessions.send': { input: { sessionId: string; prompt: string }; result: ServiceSessionSent };
  'sessions.retry': { input: { sessionId: string }; result: ServiceSessionSent };
  'sessions.status': { input: { sessionId: string }; result: ServiceSessionStatus };
  'sessions.lastReply': { input: { sessionId: string }; result: ServiceSessionReply };
  'sessions.stop': { input: { sessionId: string }; result: ServiceSessionStopped };
  'sessions.answerPermission': { input: { sessionId: string; requestId: string } & ServicePermissionAnswer; result: ServiceAnswered };
  'sessions.answerForm': { input: { sessionId: string; formId: string; values: ServiceFormValues | null; message?: string }; result: ServiceAnswered };
  'instructions.set': { input: { directory: string | null; text: string }; result: { saved: true } };
  'panels.emit': { input: { topic: string; data?: JsonValue }; result: { delivered: true } };
  'settings.read': { input: Record<string, never>; result: { settings: Record<string, string> } };
  'status.set': { input: { needsConfiguration: string | null }; result: { saved: true } };
  'marks.set': { input: { target: ServiceMarkTarget; mark: ServiceMark | null }; result: { saved: true } };
};

export type ServiceHostMethod = keyof ServiceHostCalls;

export const SERVICE_HOST_METHODS = [
  'sessions.start', 'sessions.send', 'sessions.retry', 'sessions.status', 'sessions.lastReply',
  'sessions.stop', 'sessions.answerPermission', 'sessions.answerForm',
  'instructions.set', 'panels.emit', 'settings.read', 'status.set', 'marks.set',
] as const satisfies readonly ServiceHostMethod[];

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
    retry: (sessionId: string) => Promise<ServiceSessionSent>;
    status: (sessionId: string) => Promise<ServiceSessionStatus>;
    lastReply: (sessionId: string) => Promise<ServiceSessionReply>;
    stop: (sessionId: string) => Promise<ServiceSessionStopped>;
    answerPermission: (sessionId: string, requestId: string, answer: ServicePermissionAnswer) => Promise<ServiceAnswered>;
    answerForm: (sessionId: string, formId: string, values: ServiceFormValues | null, message?: string) => Promise<ServiceAnswered>;
  };
  setInstructions: (directory: string | null, text: string) => Promise<{ saved: true }>;
  emit: (topic: string, data?: JsonValue) => Promise<{ delivered: true }>;
  readSettings: () => Promise<Record<string, string>>;
  needsConfiguration: (message: string | null) => Promise<{ saved: true }>;
  setMark: (target: ServiceMarkTarget, mark: ServiceMark | null) => Promise<{ saved: true }>;
};

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
      stop: (sessionId) => call('sessions.stop', { sessionId }),
      answerPermission: (sessionId, requestId, answer) => call('sessions.answerPermission', { sessionId, requestId, ...answer }),
      answerForm: (sessionId, formId, values, message) => call('sessions.answerForm', { sessionId, formId, values, ...(message === undefined ? {} : { message }) }),
    },
    setInstructions: (directory, text) => call('instructions.set', { directory, text }),
    emit: (topic, data) => call('panels.emit', { topic, data }),
    readSettings: () => call('settings.read', {}).then(({ settings }) => settings),
    needsConfiguration: (message) => call('status.set', { needsConfiguration: message }),
    setMark: (target, mark) => call('marks.set', { target, mark }),
  };
};
