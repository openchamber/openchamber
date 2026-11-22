import type { JsonValue } from './contract.ts';

export const WAITS_START_PATH = '/waits/start';
export const WAITS_CHECK_PATH = '/waits/check';
export const WAITS_WIRE_VERSION = 1;

export const GUEST_WAITS_MAX = 8;
export const GUEST_WAIT_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const GUEST_WAIT_TITLE_MAX = 40;
export const GUEST_WAIT_DESCRIPTION_MAX = 200;
export const GUEST_WAIT_PARAMS_MAX = 8;
export const GUEST_WAIT_PARAM_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
export const GUEST_WAIT_PARAM_DESCRIPTION_MAX = 200;
export const GUEST_WAIT_PARAM_TYPES = ['string', 'number', 'boolean'] as const;
export const GUEST_WAIT_ARG_STRING_MAX = 2_000;

export const WAIT_CHECK_INTERVAL_MIN = 10_000;
export const WAIT_CHECK_INTERVAL_MAX = 3_600_000;
export const WAIT_CHECK_INTERVAL_DEFAULT = 30_000;
export const WAIT_REQUEST_TIMEOUT_MS = 10_000;
export const WAITS_CHECK_BATCH_MAX = 50;
export const WAIT_STATE_MAX = 4_096;
export const WAIT_SUMMARY_MAX = 2_000;
export const WAIT_LABEL_MAX = 80;
export const WAIT_ERROR_MAX = 2_000;

export type GuestWaitParamType = (typeof GUEST_WAIT_PARAM_TYPES)[number];

export type GuestWaitParam = {
  type: GuestWaitParamType;
  description?: string;
  required?: true;
};

export type WaitContribution = {
  id: string;
  title: string;
  description: string;
  params?: Record<string, GuestWaitParam>;
  interval?: number;
};

export type PublicWait = {
  id: string;
  title: string;
  description: string;
  params: Record<string, GuestWaitParam>;
  interval: number;
};

export type GuestWaitArgs = Record<string, string | number | boolean>;

export type GuestWaitStartRequest = {
  v: typeof WAITS_WIRE_VERSION;
  requestId: string;
  wait: {
    id: string;
    type: string;
    args: GuestWaitArgs;
    session: { id: string; directory: string | null };
  };
};

export type GuestWaitStartResult =
  | { ok: true; state?: JsonValue; label?: string }
  | { ok: false; error: string };

export type GuestWaitCheckRequest = {
  v: typeof WAITS_WIRE_VERSION;
  requestId: string;
  waits: Array<{ id: string; type: string; args: GuestWaitArgs; state: JsonValue }>;
};

export type GuestWaitCheckOutcome =
  | { id: string; fired: false; state?: JsonValue }
  | { id: string; fired: true; summary: string };

export type GuestWaitCheckResult = { results: GuestWaitCheckOutcome[] };

export const resolveWaitInterval = (wait: Pick<WaitContribution, 'interval'>): number => wait.interval ?? WAIT_CHECK_INTERVAL_DEFAULT;

export const toPublicWaits = (waits: readonly WaitContribution[]): PublicWait[] => waits.map((wait) => ({
  id: wait.id,
  title: wait.title,
  description: wait.description,
  params: { ...(wait.params ?? {}) },
  interval: resolveWaitInterval(wait),
}));

type WireSession = { id?: unknown; directory?: unknown };
type WireStartWait = { id?: unknown; type?: unknown; args?: GuestWaitArgs; session?: WireSession };
type WireStartRequest = { v?: unknown; requestId?: unknown; wait?: WireStartWait };
type WireCheckWait = { id?: unknown; type?: unknown; args?: GuestWaitArgs; state?: JsonValue };
type WireCheckRequest = { v?: unknown; requestId?: unknown; waits?: WireCheckWait[] };

const parseBody = <T extends object>(body: string): T | null => {
  try {
    const parsed: T | null = JSON.parse(body);
    return Object(parsed) === parsed && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const argsOf = (wire: GuestWaitArgs | undefined): GuestWaitArgs | null => {
  if (Object(wire) !== wire || wire === undefined || Array.isArray(wire)) return null;
  const args: GuestWaitArgs = {};
  for (const [name, entry] of Object.entries(wire)) {
    if (String(entry) !== entry && !Number.isFinite(entry) && entry !== true && entry !== false) return null;
    args[name] = entry;
  }
  return args;
};

export const readWaitStartRequest = (body: string): GuestWaitStartRequest | null => {
  const wire = parseBody<WireStartRequest>(body);
  if (!wire || wire.v !== WAITS_WIRE_VERSION) return null;
  const { requestId, wait } = wire;
  if (String(requestId) !== requestId || requestId.length === 0) return null;
  if (Object(wait) !== wait || wait === undefined) return null;
  const { id, type, session } = wait;
  if (String(id) !== id || id.length === 0 || String(type) !== type || type.length === 0) return null;
  const args = argsOf(wait.args);
  if (!args) return null;
  if (Object(session) !== session || session === undefined) return null;
  const sessionId = session.id;
  if (String(sessionId) !== sessionId || sessionId.length === 0) return null;
  const directory = session.directory;
  if (directory !== null && (String(directory) !== directory || directory.length === 0)) return null;
  return { v: WAITS_WIRE_VERSION, requestId, wait: { id, type, args, session: { id: sessionId, directory } } };
};

export const readWaitCheckRequest = (body: string): GuestWaitCheckRequest | null => {
  const wire = parseBody<WireCheckRequest>(body);
  if (!wire || wire.v !== WAITS_WIRE_VERSION) return null;
  const { requestId } = wire;
  if (String(requestId) !== requestId || requestId.length === 0 || !Array.isArray(wire.waits)) return null;
  const waits: GuestWaitCheckRequest['waits'] = [];
  for (const entry of wire.waits) {
    if (Object(entry) !== entry || entry.state === undefined) return null;
    const { id, type, state } = entry;
    if (String(id) !== id || id.length === 0 || String(type) !== type || type.length === 0) return null;
    const args = argsOf(entry.args);
    if (!args) return null;
    waits.push({ id, type, args, state });
  }
  return { v: WAITS_WIRE_VERSION, requestId, waits };
};
