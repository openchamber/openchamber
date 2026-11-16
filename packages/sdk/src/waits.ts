/**
 * Waits an extension's service offers agents (`contributes.waits`).
 *
 * An agent calls the `openchamber` tool's `wait.start` with a source
 * (`<extension id>/<wait id>`) and arguments, then ends its turn. OpenChamber
 * keeps the wait, asks the service at `WAITS_CHECK_PATH` on the declared
 * interval whether it fired, and wakes the agent's session with one message
 * carrying the service's `summary` when it did. One wake ends the wait.
 *
 * OpenChamber owns everything that lasts: the list of waits, each one's
 * `state` (whatever JSON the service hands back, given back on every check),
 * the cadence, retries and delivery. The service keeps nothing, so it may
 * stop between checks and start again from a check alone.
 */
import type { JsonValue } from './contract.ts';

/** Route OpenChamber posts a new wait to, before the agent's call answers. */
export const WAITS_START_PATH = '/waits/start';
/** Route OpenChamber posts the due waits of one type to, on the type's interval. */
export const WAITS_CHECK_PATH = '/waits/check';
/** The `v` of every request; a service answers a version it does not know with HTTP 400. */
export const WAITS_WIRE_VERSION = 1;

/** How many wait types a package may declare. */
export const GUEST_WAITS_MAX = 8;
/** A wait type's `id`: kebab-case, starting with a letter. */
export const GUEST_WAIT_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const GUEST_WAIT_TITLE_MAX = 40;
export const GUEST_WAIT_DESCRIPTION_MAX = 200;
/** How many arguments one wait type may declare. */
export const GUEST_WAIT_PARAMS_MAX = 8;
/** An argument's name. */
export const GUEST_WAIT_PARAM_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
export const GUEST_WAIT_PARAM_DESCRIPTION_MAX = 200;
export const GUEST_WAIT_PARAM_TYPES = ['string', 'number', 'boolean'] as const;
/** Characters of one string argument. */
export const GUEST_WAIT_ARG_STRING_MAX = 2_000;

/** Bounds and default of a type's `interval`: how long OpenChamber waits between two checks, in ms. */
export const WAIT_CHECK_INTERVAL_MIN = 10_000;
// One hour, as a literal: an expression would stay in every example bundle.
export const WAIT_CHECK_INTERVAL_MAX = 3_600_000;
export const WAIT_CHECK_INTERVAL_DEFAULT = 30_000;
/** One start or check request may take this long. */
export const WAIT_REQUEST_TIMEOUT_MS = 10_000;
/** Most waits one check request carries; more of one type go in later requests. */
export const WAITS_CHECK_BATCH_MAX = 50;
/** Characters of a wait's `state` as JSON. */
export const WAIT_STATE_MAX = 4_096;
/** Characters of the `summary` the agent is woken with. */
export const WAIT_SUMMARY_MAX = 2_000;
/** Characters of the `label` a started wait is shown under. */
export const WAIT_LABEL_MAX = 80;
/** Characters of `error` OpenChamber reads from a refused start. */
export const WAIT_ERROR_MAX = 2_000;

export type GuestWaitParamType = (typeof GUEST_WAIT_PARAM_TYPES)[number];

export type GuestWaitParam = {
  type: GuestWaitParamType;
  /** What the agent should pass; shown to it by `wait.list`. */
  description?: string;
  required?: true;
};

/**
 * One entry of `contributes.waits`. Needs `contributes.service`; the service
 * needs no panel or background entry for this alone. Declaring any asks for
 * the `wake` capability, approved for exactly the declared ids.
 */
export type WaitContribution = {
  id: string;
  /** What the user and the agent see the wait as. */
  title: string;
  /** When the wait fires, written for the agent that picks it. */
  description: string;
  params?: Record<string, GuestWaitParam>;
  /** Milliseconds between two checks, `WAIT_CHECK_INTERVAL_MIN`..`MAX`; default `WAIT_CHECK_INTERVAL_DEFAULT`. */
  interval?: number;
};

/** What the catalog and the approval dialog show of one wait type. */
export type PublicWait = {
  id: string;
  title: string;
  description: string;
  params: Record<string, GuestWaitParam>;
  interval: number;
};

export type GuestWaitArgs = Record<string, string | number | boolean>;

/**
 * A new wait. `wait.id` is OpenChamber's id for it, the same on every check;
 * `session` is the session the wake goes to, `directory` `null` when unknown.
 * Answer `GuestWaitStartResult`.
 */
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

/**
 * `ok: true` takes the wait, with the `state` the first check gets back
 * (`null` when the service needs none) and an optional `label` it is shown
 * under (the deploy, the URL). `ok: false` refuses it: the agent's call fails
 * with `error`, so say what the agent should change.
 */
export type GuestWaitStartResult =
  | { ok: true; state?: JsonValue; label?: string }
  | { ok: false; error: string };

/** The due waits of one type, each with the `state` the last answer gave it. Answer `GuestWaitCheckResult`. */
export type GuestWaitCheckRequest = {
  v: typeof WAITS_WIRE_VERSION;
  requestId: string;
  waits: Array<{ id: string; type: string; args: GuestWaitArgs; state: JsonValue }>;
};

/**
 * One entry per wait the service has news of. `fired: false` keeps waiting,
 * with a new `state` or the old one when it is left out; `fired: true` ends
 * the wait and wakes the session with `summary`. A wait left out of
 * `results` keeps waiting unchanged.
 */
export type GuestWaitCheckOutcome =
  | { id: string; fired: false; state?: JsonValue }
  | { id: string; fired: true; summary: string };

export type GuestWaitCheckResult = { results: GuestWaitCheckOutcome[] };

/** The interval a wait type is checked on. */
export const resolveWaitInterval = (wait: Pick<WaitContribution, 'interval'>): number => wait.interval ?? WAIT_CHECK_INTERVAL_DEFAULT;

/** What the catalog and the approval dialog show of `contributes.waits`. */
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

/** The arguments as the wire claims them, kept only when they are one flat object of strings, numbers and booleans. */
const argsOf = (wire: GuestWaitArgs | undefined): GuestWaitArgs | null => {
  if (Object(wire) !== wire || wire === undefined || Array.isArray(wire)) return null;
  const args: GuestWaitArgs = {};
  for (const [name, entry] of Object.entries(wire)) {
    if (String(entry) !== entry && !Number.isFinite(entry) && entry !== true && entry !== false) return null;
    args[name] = entry;
  }
  return args;
};

/**
 * A service's read of the body OpenChamber posted to `WAITS_START_PATH`.
 * Checks the envelope and the fields a service branches on; OpenChamber
 * checked the arguments against the declared params already. `null` is a
 * body that is not a start request of this wire version; answer it with
 * HTTP 400.
 */
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

/** A service's read of the body OpenChamber posted to `WAITS_CHECK_PATH`; `null` as for `readWaitStartRequest`. */
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
    // `state` is the JSON the service handed back, posted unchanged.
    waits.push({ id, type, args, state });
  }
  return { v: WAITS_WIRE_VERSION, requestId, waits };
};
