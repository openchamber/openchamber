
export const GUEST_SESSION_EVENT_TYPES = [
  'turn-finished', 'turn-failed', 'permission-asked', 'question-asked',
  'turn-started', 'session-created', 'session-archived', 'session-deleted',
] as const;
export type GuestSessionEventType = (typeof GUEST_SESSION_EVENT_TYPES)[number];

export const SESSION_EVENTS_PATH = '/session-events';
export const SESSION_EVENTS_WIRE_VERSION = 1;
export const SESSION_EVENT_TIMEOUT_MS = 10_000;
export const SESSION_EVENTS_IDLE_MS = 10 * 60_000;
export const SESSION_EVENT_REPLY_MAX = 64_000;
export const SESSION_EVENT_PENDING_MAX = 200;
export const SESSION_EVENT_ERROR_MAX = 2_000;

export type SessionEventsContribution = {
  events: GuestSessionEventType[];
  content?: true;
};

export type PublicSessionEvents = {
  events: GuestSessionEventType[];
  content: boolean;
};

export type GuestSessionLinkedItem = {
  id: string;
  kind: string;
  url: string;
  provider?: string;
  identifier?: string;
  number?: number;
};

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

export type GuestPermissionAskedContent = {
  type: 'permission-asked';
  sessionTitle: string | null;
  action: string;
  resources: string[];
  message: string | null;
};

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

export type GuestSessionEventRequest = {
  v: typeof SESSION_EVENTS_WIRE_VERSION;
  requestId: string;
  event: {
    id: string;
    type: GuestSessionEventType;
    at: number;
    session: { id: string; parentId: string | null };
    project: { directory: string | null };
    linked: GuestSessionLinkedItem[];
    permission?: { requestId: string };
    question?: { kind: 'form' | 'page'; id: string };
  };
  content?: GuestSessionEventContent;
};

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
