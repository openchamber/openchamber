/**
 * Session events for an extension's service (`contributes.sessionEvents`).
 *
 * OpenChamber posts each event a package subscribed to as one HTTP request to
 * the service at `SESSION_EVENTS_PATH`, from every project, whether or not a
 * window is open. Approving the package is the subscription: the request
 * carries identifiers only (`event`), and the `transcript` capability, asked
 * for with `content: true`, adds what the agent said or asked (`content`).
 * The service answers `{ ok: true }` once it has taken the event; OpenChamber
 * reads nothing else from the answer. Which projects an extension acts on is
 * its own business: filter on `event.project.directory`.
 */

/**
 * `turn-finished`: the session went idle with nothing waiting (no running
 * subagent, no open permission, question or page, no goal or auto-review
 * step still driving it). `turn-failed`: the turn ended in an error.
 * `permission-asked`: the agent asked for a permission the user has to
 * answer. `question-asked`: the agent asked the user a question through a
 * form or a page. A turn the user stopped emits nothing. `turn-started`: the
 * session began a turn. `session-created`, `session-archived` and
 * `session-deleted` name what they say; subagents' sessions are included, with
 * `session.parentId` set.
 */
export const GUEST_SESSION_EVENT_TYPES = [
  'turn-finished', 'turn-failed', 'permission-asked', 'question-asked',
  'turn-started', 'session-created', 'session-archived', 'session-deleted',
] as const;
export type GuestSessionEventType = (typeof GUEST_SESSION_EVENT_TYPES)[number];

/** Route on the service loopback OpenChamber posts every event to. */
export const SESSION_EVENTS_PATH = '/session-events';
/** The `v` of every request; a service answers a version it does not know with HTTP 400. */
export const SESSION_EVENTS_WIRE_VERSION = 1;
/** One delivery may take this long; a slower service drops that event. */
export const SESSION_EVENT_TIMEOUT_MS = 10_000;
/** No event for this long stops the service; the next event starts it again. */
export const SESSION_EVENTS_IDLE_MS = 10 * 60_000;
/** Characters of the agent's reply carried in `content`; a longer reply is cut and flagged. */
export const SESSION_EVENT_REPLY_MAX = 64_000;
/** Events kept while the service starts; newer ones past this are dropped. */
export const SESSION_EVENT_PENDING_MAX = 200;
/** Characters of `error` OpenChamber reads from a failed answer. */
export const SESSION_EVENT_ERROR_MAX = 2_000;

/**
 * `contributes.sessionEvents`: which events the service wants, and whether it
 * also wants their content. Needs `contributes.service`; the service needs no
 * panel or background entry for this alone.
 */
export type SessionEventsContribution = {
  /** 1 to 8 distinct types. */
  events: GuestSessionEventType[];
  /** Asks for the `transcript` capability: the reply, the question, the permission's detail. */
  content?: true;
};

/** What the catalog and the approval dialog show of the subscription. */
export type PublicSessionEvents = {
  events: GuestSessionEventType[];
  content: boolean;
};

/**
 * An item the user linked to the session (a tracker issue, a pull request,
 * an external link), as the session stores it: identifiers and the link,
 * never the item's title. `id` is the stored entry id (`owner/repo#12`,
 * `linear:OPE-367`, `link:<url>`); `kind` is the link's kind as stored
 * (`issue`, `pull`, `external`, or a tracker's own kind); `provider` names the
 * tracker when one owns the item and `identifier` is its key there (`OPE-367`).
 */
export type GuestSessionLinkedItem = {
  id: string;
  kind: string;
  url: string;
  provider?: string;
  identifier?: string;
  /** The change request or issue number on a Git host. */
  number?: number;
};

/** The agent's final answer of the turn, cut at `SESSION_EVENT_REPLY_MAX` when `replyTruncated`. */
export type GuestTurnFinishedContent = {
  type: 'turn-finished';
  sessionTitle: string | null;
  reply: string;
  replyTruncated: boolean;
};

export type GuestTurnFailedContent = {
  type: 'turn-failed';
  sessionTitle: string | null;
  error: { type: string; message: string };
};

/** What the agent wants to do: the permission's action, the resources it names, and its note. */
export type GuestPermissionAskedContent = {
  type: 'permission-asked';
  sessionTitle: string | null;
  action: string;
  resources: string[];
  message: string | null;
};

/**
 * One field of a form, enough to ask it elsewhere and answer it with
 * `sessions.answerForm`: the value goes under `key`. `options` are the
 * choices of a `string` or `multiselect` field (send their `value`);
 * `custom` says a multiselect also takes values of its own. `when` lists
 * conditions on earlier fields' answers; a field whose conditions do not all
 * hold is not asked, and a value sent for it is dropped. Fields left out of
 * the answer take their default. `external` is a link the user has to open
 * and cannot be answered from a service.
 */
export type GuestFormField = {
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external';
  title: string;
  description: string | null;
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  custom?: boolean;
  when?: Array<{ key: string; op: 'eq' | 'neq'; value: string | number | boolean }>;
};

/**
 * A `page` is the agent's own page waiting for a click; it cannot be answered
 * from a service. Sending to the session with `sessions.send` closes it as
 * if the user wrote in the chat, and so does it for an open form.
 */
export type GuestQuestionAskedContent = {
  type: 'question-asked';
  sessionTitle: string | null;
  ask:
    | { kind: 'form'; id: string; title: string; fields: GuestFormField[] }
    | { kind: 'page'; id: string; title: string };
};

export type GuestSessionTitleContent = {
  type: 'turn-started' | 'session-created' | 'session-archived' | 'session-deleted';
  sessionTitle: string | null;
};

export type GuestSessionEventContent =
  | GuestTurnFinishedContent
  | GuestTurnFailedContent
  | GuestPermissionAskedContent
  | GuestQuestionAskedContent
  | GuestSessionTitleContent;

/**
 * One event, as OpenChamber posts it. `event` is what every subscriber gets;
 * `content` comes only with the `transcript` grant, and only on the types
 * that have content. `project.directory` is the session's directory, `null`
 * when OpenChamber does not know it. `session.parentId` is set for a
 * subagent's session. `permission.requestId` names the request on a
 * `permission-asked` event, and `question` what a `question-asked` event
 * waits on; both are what `sessions.answerPermission` and
 * `sessions.answerForm` take.
 */
export type GuestSessionEventRequest = {
  v: typeof SESSION_EVENTS_WIRE_VERSION;
  requestId: string;
  event: {
    /** OpenCode's event id, or one OpenChamber made for an event it synthesized. */
    id: string;
    type: GuestSessionEventType;
    /** Epoch milliseconds. */
    at: number;
    session: { id: string; parentId: string | null };
    project: { directory: string | null };
    linked: GuestSessionLinkedItem[];
    permission?: { requestId: string };
    question?: { kind: 'form' | 'page'; id: string };
  };
  content?: GuestSessionEventContent;
};

/**
 * What the service answers. `ok: false` with an `error` is a delivery that
 * failed; OpenChamber logs the text and nothing else, so say what went wrong
 * on the service's side, never what the event contained.
 */
export type GuestSessionEventResult = { ok: true } | { ok: false; error: string };

const EVENT_TYPES: ReadonlySet<string> = new Set(GUEST_SESSION_EVENT_TYPES);

export const isGuestSessionEventType = (value: string): value is GuestSessionEventType => EVENT_TYPES.has(value);

type WireSession = { id?: unknown; parentId?: unknown };
type WireProject = { directory?: unknown };
type WirePermission = { requestId?: unknown };
type WireQuestion = { kind?: unknown; id?: unknown };
type WireContent = { type?: unknown };
type WireEvent = {
  id?: unknown; type?: unknown; at?: unknown; session?: WireSession; project?: WireProject; linked?: unknown;
  permission?: WirePermission; question?: WireQuestion;
};
type WireRequest = { v?: unknown; requestId?: unknown; event?: WireEvent; content?: WireContent };

/**
 * A service's read of the body OpenChamber posted to `SESSION_EVENTS_PATH`.
 * OpenChamber built the event, so this checks the envelope and the fields a
 * service branches on, not every content field, and the service bundle needs
 * no schema library. `null` is a body that is not a session event of this
 * wire version; answer it with HTTP 400.
 */
export const readSessionEventRequest = (body: string): GuestSessionEventRequest | null => {
  let wire: WireRequest;
  try {
    const parsed: WireRequest | null = JSON.parse(body);
    if (Object(parsed) !== parsed || parsed === null) return null;
    wire = parsed;
  } catch {
    return null;
  }
  const { v, requestId, event, content } = wire;
  if (v !== SESSION_EVENTS_WIRE_VERSION) return null;
  if (String(requestId) !== requestId || requestId.length === 0) return null;
  if (Object(event) !== event || event === undefined) return null;
  const { id, type, at, session, project, linked, permission, question } = event;
  if (String(id) !== id || id.length === 0) return null;
  if (String(type) !== type || !isGuestSessionEventType(type)) return null;
  if (!Number.isFinite(at)) return null;
  if (Object(session) !== session || session === undefined) return null;
  const sessionId = session.id;
  if (String(sessionId) !== sessionId || sessionId.length === 0) return null;
  const parentId = session.parentId;
  if (parentId !== null && (String(parentId) !== parentId || parentId.length === 0)) return null;
  if (Object(project) !== project || project === undefined) return null;
  const directory = project.directory;
  if (directory !== null && (String(directory) !== directory || directory.length === 0)) return null;
  if (!Array.isArray(linked)) return null;
  // SAFETY: OpenChamber built `linked` from the session's stored link entries;
  // a service reads each item under `GuestSessionLinkedItem`.
  const request: GuestSessionEventRequest = {
    v: SESSION_EVENTS_WIRE_VERSION,
    requestId,
    event: { id, type, at: Number(at), session: { id: sessionId, parentId }, project: { directory }, linked: linked as GuestSessionLinkedItem[] },
  };
  if (permission !== undefined) {
    if (Object(permission) !== permission) return null;
    const permissionRequestId = permission.requestId;
    if (String(permissionRequestId) !== permissionRequestId || permissionRequestId.length === 0) return null;
    request.event.permission = { requestId: permissionRequestId };
  }
  if (question !== undefined) {
    if (Object(question) !== question) return null;
    const { kind, id: questionId } = question;
    if (kind !== 'form' && kind !== 'page') return null;
    if (String(questionId) !== questionId || questionId.length === 0) return null;
    request.event.question = { kind, id: questionId };
  }
  if (content !== undefined) {
    if (Object(content) !== content || content.type !== type) return null;
    // SAFETY: the content's `type` equals the event's, and OpenChamber built
    // the rest of it for that type (`GuestSessionEventContent`).
    request.content = content as GuestSessionEventContent;
  }
  return request;
};
