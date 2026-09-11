
import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';

export type HostThemeMode = 'light' | 'dark';

export type HostThemeTokens = {
  background: string;
  elevated: string;
  foreground: string;
  muted: string;
  subtle: string;
  border: string;
  hover: string;
  selection: string;
  focus: string;
  primary: string;
  /** Secondary surface (sidebars, muted rows). */
  mutedSurface: string;
  /** Text on `elevated`. */
  elevatedForeground: string;
  /** Pressed state of a clickable. */
  active: string;
  /** Text on `selection`. */
  selectionForeground: string;
  /** Text on `primary`. */
  primaryForeground: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  font: string;
  /** Monospace stack for code and identifiers. */
  mono: string;
  radius: string;
};

export type HostTheme = {
  mode: HostThemeMode;
  tokens: HostThemeTokens;
};

export const START_SESSION_SENT = ['sent', 'no-model', 'skipped', 'failed'] as const;

export type StartSessionSent = (typeof START_SESSION_SENT)[number];

export type SessionSnapshot = {
  id: string;
  title: string;
  busy: boolean;
  model?: string;
  agent?: string;
};

/** Which host chrome mounted this iframe. Not `openSurface`. */
export type GuestHostSurface = 'panel' | 'dialog';

export type GuestConnection = {
  connected: boolean;
  account: string;
};

export type GuestSettings = Record<string, string>;

export type GuestRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type GuestRequest = {
  method: GuestRequestMethod;
  path: string;
  query?: Record<string, string>;
  body?: string;
};

export type GuestRequestResult = {
  status: number;
  body: string;
};

export type StartSessionResult = {
  sessionId: string;
  sent: StartSessionSent;
};

export type PromptRequest = {
  text: string;
  send?: boolean;
};

export type PromptResult = {
  sent: StartSessionSent;
};

export const SESSION_LIFECYCLE_PHASES = ['started', 'completed', 'failure'] as const;

export type SessionLifecyclePhase = (typeof SESSION_LIFECYCLE_PHASES)[number];

export type SessionLifecycleEvent = {
  sessionId: string;
  phase: SessionLifecyclePhase;
};

export const GUEST_FILE_ENTRY_KINDS = ['file', 'directory', 'other'] as const;

/** What a directory entry or an existing path is. */
export type GuestFileEntryKind = (typeof GUEST_FILE_ENTRY_KINDS)[number];

export const GUEST_FILE_STAT_KINDS = ['file', 'directory', 'other', 'missing'] as const;

/** `stat` answer: an entry kind, or `missing` when nothing is at that path. */
export type GuestFileStatKind = (typeof GUEST_FILE_STAT_KINDS)[number];

/**
 * Where a guest file path points. A relative path is inside the open project
 * (capability `files`). A path starting with `/` or `~/` is outside it and
 * must match one of the manifest's `contributes.filesystem` patterns
 * (capability `filesystem`).
 */
export type GuestFileScope = 'project' | 'filesystem';

export type FileReadRequest = { path: string };
export type FileWriteRequest = { path: string; content: string };
export type FileListRequest = { path: string };
export type FileStatRequest = { path: string };

export type FileReadResult = { content: string };
export type FileWriteResult = { written: true };
export type FileListEntry = { name: string; kind: GuestFileEntryKind };
export type FileListResult = { entries: FileListEntry[] };
export type FileStatResult = { kind: GuestFileStatKind; size: number; mtime: number };

export type HostResultPayload =
  | GuestRequestResult
  | StartSessionResult
  | PromptResult
  | ServiceStatusResult
  | FileReadResult
  | FileWriteResult
  | FileListResult
  | FileStatResult;

export const isStartSessionResult = (
  value: HostResultPayload | undefined,
): value is StartSessionResult => Boolean(value && 'sessionId' in value);

export const isPromptResult = (
  value: HostResultPayload | undefined,
): value is PromptResult => Boolean(value && 'sent' in value && !('sessionId' in value));

export const EMPTY_GUEST_CONNECTION: GuestConnection = {
  connected: false,
  account: '',
};

export type HostReadyContext = {
  theme: HostTheme;
  locale: string;
  directory: string | null;
  session: SessionSnapshot | null;
  surface: GuestHostSurface;
  connection: GuestConnection;
  settings: GuestSettings;
  /**
   * The item this surface was opened for: the chip the user clicked on the
   * composer (`AttachIssueRequest`), or the message / session a declared
   * action ran on (`GuestMessageItem` / `GuestSessionItem`). `null` when
   * opened from the rail icon or the composer + menu.
   */
  item: GuestItem | null;
};

export type GuestItemRole = 'user' | 'assistant';

/** A `contributes.actions` entry with `where: "message"` ran on this message. */
export type GuestMessageItem = {
  kind: 'message';
  /** The action id from the manifest. */
  action: string;
  sessionId: string;
  sessionTitle: string;
  /** The session's project directory, or `null` for a session without one. */
  directory: string | null;
  messageId: string;
  role: GuestItemRole;
  /** Message text as the Markdown export renders it, capped at `GUEST_ITEM_MESSAGE_TEXT_MAX`. */
  text: string;
};

export type GuestSessionItemMessage = {
  id: string;
  role: GuestItemRole;
  text: string;
  createdAt: number;
};

/** A `contributes.actions` entry with `where: "session"` ran on this session. */
export type GuestSessionItem = {
  kind: 'session';
  /** The action id from the manifest. */
  action: string;
  sessionId: string;
  sessionTitle: string;
  /** The session's project directory, or `null` for a session without one. */
  directory: string | null;
  /** Present only when the action declared `payload: ["messages"]` and the user granted `conversation`. Oldest first. */
  messages?: GuestSessionItemMessage[];
  /** Set when the oldest messages were dropped to stay within `GUEST_ITEM_SESSION_MAX`. */
  truncated?: boolean;
};

export type GuestItem = AttachIssueRequest | GuestMessageItem | GuestSessionItem;

export const isGuestMessageItem = (item: GuestItem | null): item is GuestMessageItem => (
  item !== null && item.kind === 'message'
);

export const isGuestSessionItem = (item: GuestItem | null): item is GuestSessionItem => (
  item !== null && item.kind === 'session'
);

/** The composer chip: what the guest handed to `attach`, with `text` filled from the chip. */
export const isGuestAttachItem = (item: GuestItem | null): item is AttachIssueRequest => (
  item !== null && item.kind !== 'message' && item.kind !== 'session'
);

/** What the host asks a guest that declared `contributes.commands` when the user submits `/name args`. */
export type ResolveRequest = {
  command: string;
  args: string;
};

/** The guest's answer to `resolve`: the chip to attach, `null` for nothing, or why it failed. */
export type ResolveResultPayload =
  | { item: AttachIssueRequest | null }
  | { error: string };

export type BadgeRequest = {
  /** 0 to `GUEST_BADGE_MAX`; `null` clears the badge. */
  count: number | null;
};

export type ToastKind = 'info' | 'success' | 'error';

export type ToastRequest = {
  kind: ToastKind;
  message: string;
};

export type ComposeRequest = {
  text: string;
  mode?: 'replace' | 'append';
};

export type AttachThreadKind = 'issue' | 'pull';

export type AttachBranches = {
  head: string;
  base: string;
};

/** Plain JSON: what survives `JSON.stringify` / `JSON.parse` unchanged. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type AttachIssueRequest = {
  providerId: string;
  id: string;
  title: string;
  url: string;
  text?: string;
  kind?: AttachThreadKind;
  author?: string;
  branches?: AttachBranches;
  /**
   * Opaque payload the guest chose. The host stores it with the chip and the
   * session snapshot and hands it back unchanged as `ready.item.data`; it
   * never reaches the model or the chip text. Serialized size is capped at
   * `GUEST_ATTACH_DATA_MAX`; `clampAttachRequest` drops a larger value.
   */
  data?: JsonValue;
};

export type StartSessionRequest = AttachIssueRequest & {
  worktree?: boolean;
};

export const GUEST_TOAST_MAX = 500;
export const GUEST_CLIPBOARD_TEXT_MAX = 32_000;
export const GUEST_COMPOSE_TEXT_MAX = 16_000;
export const GUEST_ATTACH_ID_MAX = 128;
export const GUEST_ATTACH_TITLE_MAX = 200;
export const GUEST_ATTACH_URL_MAX = 2_000;
export const GUEST_ATTACH_TEXT_MAX = 16_000;
export const GUEST_ATTACH_AUTHOR_MAX = 80;
export const GUEST_ATTACH_BRANCH_MAX = 200;
/** `JSON.stringify(data).length` ceiling for `AttachIssueRequest.data`. */
export const GUEST_ATTACH_DATA_MAX = 16_000;
export const GUEST_ACCOUNT_MAX = 200;
export const GUEST_SESSION_MODEL_MAX = 200;
export const GUEST_SESSION_AGENT_MAX = 80;
export const GUEST_SETTING_VALUE_MAX = 2_000;
export const GUEST_REQUEST_PATH_MAX = 2_000;
export const GUEST_REQUEST_BODY_MAX = 64_000;
export const GUEST_REQUEST_RESPONSE_MAX = 256_000;
export const GUEST_REQUEST_TIMEOUT_MS = 20_000;
/** Guest file path, in characters. */
export const GUEST_FILE_PATH_MAX = 1_024;
/** File content in characters, read and write alike. */
export const GUEST_FILE_CONTENT_MAX = 2_000_000;
/** Entries a `listDir` answer carries; longer directories are truncated. */
export const GUEST_FILE_LIST_MAX = 2_000;
/** Characters of one message's text on a `GuestMessageItem` or a `GuestSessionItem` message. */
export const GUEST_ITEM_MESSAGE_TEXT_MAX = 200_000;
/** `JSON.stringify` length ceiling for a `GuestSessionItem`; the host drops the oldest messages to stay under it. */
export const GUEST_ITEM_SESSION_MAX = 2_000_000;
/** Largest count a rail badge shows. */
export const GUEST_BADGE_MAX = 999;
/** Characters in a `resolve-result` error string. */
export const GUEST_RESOLVE_ERROR_MAX = 500;

export const HOST_REQUEST_ERROR_CODES = [
  'HOST_UNAVAILABLE',
  'HOST_TIMEOUT',
  'HOST_REJECTED',
  'DISCONNECTED',
  'DISABLED',
  'BAD_PATH',
  'NO_INTEGRATION',
  'NO_SERVICE',
  'SERVICE_FAILED',
  'NO_SESSION',
  'SESSION_BUSY',
  'NOT_GRANTED',
  'NO_DIRECTORY',
  'NOT_FOUND',
  'FILE_TOO_LARGE',
  'DENIED',
] as const;

export const SERVICE_STATUS_VALUES = ['stopped', 'starting', 'ready', 'failed'] as const;

export type ServiceStatus = (typeof SERVICE_STATUS_VALUES)[number];

export type ServiceStatusResult = {
  status: ServiceStatus;
};

export type HostRequestErrorCode = (typeof HOST_REQUEST_ERROR_CODES)[number];

const hostRequestErrorCodeSet: ReadonlySet<string> = new Set(HOST_REQUEST_ERROR_CODES);

export const isHostRequestErrorCode = (value: string): value is HostRequestErrorCode => (
  hostRequestErrorCodeSet.has(value)
);

/** Unknown or omitted wire codes become HOST_REJECTED. */
export const resolveHostRequestErrorCode = (value: string | undefined): HostRequestErrorCode => (
  value && isHostRequestErrorCode(value) ? value : 'HOST_REJECTED'
);

export const isJsonValue = (value: JsonValue | undefined): value is JsonValue => {
  if (value === undefined) return false;
  if (value === null || value === true || value === false) return true;
  if (String(value) === value) return true;
  if (Number(value) === value) return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (Object(value) === value) return Object.values(value).every(isJsonValue);
  return false;
};

/** Whether `data` is plain JSON that serializes within `GUEST_ATTACH_DATA_MAX`. */
export const isAttachData = (value: JsonValue | undefined): value is JsonValue => (
  isJsonValue(value) && JSON.stringify(value).length <= GUEST_ATTACH_DATA_MAX
);

const clampBranch = (value: string | undefined): string => (
  value?.trim().slice(0, GUEST_ATTACH_BRANCH_MAX) ?? ''
);

/** Guest attach is dropped by the host schema if these limits overflow. */
export const clampAttachRequest = (request: AttachIssueRequest): AttachIssueRequest => {
  const id = request.id.trim().slice(0, GUEST_ATTACH_ID_MAX);
  const title = request.title.trim().slice(0, GUEST_ATTACH_TITLE_MAX);
  const url = request.url.trim().slice(0, GUEST_ATTACH_URL_MAX);
  const text = request.text?.trim().slice(0, GUEST_ATTACH_TEXT_MAX);
  const author = request.author?.trim().slice(0, GUEST_ATTACH_AUTHOR_MAX);
  const kind: AttachThreadKind = request.kind === 'pull' ? 'pull' : 'issue';
  const next: AttachIssueRequest = {
    providerId: request.providerId.trim(),
    id,
    title: title || id,
    url,
    kind,
  };
  if (text) {
    next.text = text;
  }
  if (author) {
    next.author = author;
  }
  if (kind === 'pull') {
    const head = clampBranch(request.branches?.head);
    const base = clampBranch(request.branches?.base);
    if (head && base) {
      next.branches = { head, base };
    }
  }
  if (isAttachData(request.data)) {
    next.data = request.data;
  }
  return next;
};

/** Same attach clamp. `worktree` stays only when the guest asked for one. */
export const clampStartSessionRequest = (request: StartSessionRequest): StartSessionRequest => {
  const next: StartSessionRequest = clampAttachRequest(request);
  if (request.worktree) {
    next.worktree = true;
  }
  return next;
};

/** Prompt text uses the compose limit. `send` stays only when the guest asked. */
export const clampPromptRequest = (request: PromptRequest): PromptRequest => {
  const next: PromptRequest = {
    text: request.text.trim().slice(0, GUEST_COMPOSE_TEXT_MAX),
  };
  if (request.send) {
    next.send = true;
  }
  return next;
};

/** Badge counts are whole numbers from 0 to `GUEST_BADGE_MAX`; anything else clears. */
export const clampBadgeCount = (count: number | null): number | null => {
  if (count === null || !Number.isFinite(count)) return null;
  return Math.min(GUEST_BADGE_MAX, Math.max(0, Math.round(count)));
};

/**
 * Which grant a file path needs. `/…` and `~/…` are outside the project and
 * go through the declared `filesystem` patterns; anything else is joined to
 * the open project directory.
 */
export const guestFileScope = (path: string): GuestFileScope => (
  path.startsWith('/') || path === '~' || path.startsWith('~/') ? 'filesystem' : 'project'
);

/**
 * What the host schema accepts as a file path. Semantics (`..`, symlinks,
 * declared patterns) are the server's call and come back as `BAD_PATH`; this
 * only keeps a message from being dropped unanswered.
 */
export const isGuestFilePath = (value: string): boolean => (
  value.length > 0
  && value.length <= GUEST_FILE_PATH_MAX
  && !value.includes('\0')
  && !value.includes('\\')
);

export const ATTACH_PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
export const SETTING_KEY = /^[a-z][a-z0-9-]*$/;

export const isGuestRequestPath = (value: string): boolean => {
  if (!value.startsWith('/') || value.includes('\0') || value.includes('\\') || value.includes('://')) {
    return false;
  }
  if (value.length > GUEST_REQUEST_PATH_MAX) {
    return false;
  }
  const segments = value.split('/');
  return !segments.some((segment) => segment === '.' || segment === '..');
};

// Wire messages. The zod schemas in `protocol.ts` are the host's parse of an
// untrusted guest; these types are the shared contract and protocol.ts asserts
// the two agree at compile time.

type Envelope = {
  channel: typeof OPENCHAMBER_SDK_CHANNEL;
  v: typeof OPENCHAMBER_SDK_API_VERSION;
};

export type HostReadyMessage = Envelope & { type: 'ready'; payload: HostReadyContext };
export type HostDirectoryMessage = Envelope & { type: 'directory'; payload: { directory: string | null } };
export type HostSessionMessage = Envelope & { type: 'session'; payload: { session: SessionSnapshot | null } };
export type HostConnectionMessage = Envelope & { type: 'connection'; payload: { connection: GuestConnection } };
export type HostSettingsMessage = Envelope & { type: 'settings'; payload: { settings: GuestSettings } };
export type HostSessionLifecycleMessage = Envelope & { type: 'session-lifecycle'; payload: SessionLifecycleEvent };
export type HostItemMessage = Envelope & { type: 'item'; payload: { item: GuestItem | null } };
/** Host → guest request. The guest answers with `resolve-result` carrying the same `id`. */
export type HostResolveMessage = Envelope & { type: 'resolve'; id: string; payload: ResolveRequest };
export type HostResultMessage = Envelope & { type: 'result'; id: string } & (
  | { ok: true; payload?: HostResultPayload }
  | { ok: false; error: string; code: HostRequestErrorCode }
);

export type HostMessage =
  | HostReadyMessage
  | HostDirectoryMessage
  | HostSessionMessage
  | HostConnectionMessage
  | HostSettingsMessage
  | HostSessionLifecycleMessage
  | HostItemMessage
  | HostResolveMessage
  | HostResultMessage;

type GuestCall<Type extends string, Payload = never> = Envelope & { type: Type; id: string } & (
  [Payload] extends [never] ? object : { payload: Payload }
);

export type GuestHelloMessage = Envelope & { type: 'hello' };
export type GuestToastMessage = GuestCall<'toast', ToastRequest>;
export type GuestOpenUrlMessage = GuestCall<'open-url', { url: string }>;
export type GuestOpenSurfaceMessage = GuestCall<'open-surface', { surfaceId: string }>;
export type GuestClipboardWriteMessage = GuestCall<'clipboard-write', { text: string }>;
export type GuestComposeMessage = GuestCall<'compose', ComposeRequest>;
export type GuestAttachMessage = GuestCall<'attach', AttachIssueRequest>;
export type GuestStartSessionMessage = GuestCall<'start-session', StartSessionRequest>;
export type GuestPromptMessage = GuestCall<'prompt', PromptRequest>;
export type GuestSessionLinkMessage = GuestCall<'session-link', AttachIssueRequest>;
export type GuestCloseMessage = GuestCall<'close'>;
export type GuestOauthStartMessage = GuestCall<'oauth-start'>;
export type GuestOauthDisconnectMessage = GuestCall<'oauth-disconnect'>;
export type GuestRequestMessage = GuestCall<'request', GuestRequest>;
export type GuestServiceRequestMessage = GuestCall<'service-request', GuestRequest>;
export type GuestServiceStatusMessage = GuestCall<'service-status'>;
export type GuestFileReadMessage = GuestCall<'file-read', FileReadRequest>;
export type GuestFileWriteMessage = GuestCall<'file-write', FileWriteRequest>;
export type GuestFileListMessage = GuestCall<'file-list', FileListRequest>;
export type GuestFileStatMessage = GuestCall<'file-stat', FileStatRequest>;
export type GuestBadgeMessage = GuestCall<'badge', BadgeRequest>;
/** Answers a host `resolve` by `id`. The host sends no `result` back for it. */
export type GuestResolveResultMessage = Envelope & { type: 'resolve-result'; id: string; payload: ResolveResultPayload };

export type GuestMessage =
  | GuestHelloMessage
  | GuestToastMessage
  | GuestOpenUrlMessage
  | GuestOpenSurfaceMessage
  | GuestClipboardWriteMessage
  | GuestComposeMessage
  | GuestAttachMessage
  | GuestStartSessionMessage
  | GuestPromptMessage
  | GuestSessionLinkMessage
  | GuestCloseMessage
  | GuestOauthStartMessage
  | GuestOauthDisconnectMessage
  | GuestRequestMessage
  | GuestServiceRequestMessage
  | GuestServiceStatusMessage
  | GuestFileReadMessage
  | GuestFileWriteMessage
  | GuestFileListMessage
  | GuestFileStatMessage
  | GuestBadgeMessage
  | GuestResolveResultMessage;

const serviceStatusSet: ReadonlySet<string> = new Set(SERVICE_STATUS_VALUES);

export const isServiceStatusResult = (
  value: HostResultPayload | undefined,
): value is ServiceStatusResult => Boolean(value && 'status' in value && serviceStatusSet.has(String(value.status)) && !('body' in value));

export const isGuestRequestResult = (
  value: HostResultPayload | undefined,
): value is GuestRequestResult => Boolean(value && 'status' in value && 'body' in value && Number.isInteger(value.status));

export const isFileReadResult = (
  value: HostResultPayload | undefined,
): value is FileReadResult => Boolean(value && 'content' in value && String(value.content) === value.content);

export const isFileWriteResult = (
  value: HostResultPayload | undefined,
): value is FileWriteResult => Boolean(value && 'written' in value && value.written === true);

export const isFileListResult = (
  value: HostResultPayload | undefined,
): value is FileListResult => Boolean(value && 'entries' in value && Array.isArray(value.entries));

const fileStatKindSet: ReadonlySet<string> = new Set(GUEST_FILE_STAT_KINDS);

export const isFileStatResult = (
  value: HostResultPayload | undefined,
): value is FileStatResult => Boolean(
  value && 'kind' in value && 'size' in value && fileStatKindSet.has(String(value.kind)) && Number.isFinite(value.size),
);

const HOST_PUSH_TYPES: ReadonlySet<string> = new Set([
  'ready', 'directory', 'session', 'connection', 'settings', 'session-lifecycle', 'item', 'resolve',
]);

/** What a postMessage payload may carry before it is read as a host message. */
type WireRecord = {
  channel?: unknown;
  v?: unknown;
  type?: unknown;
  id?: unknown;
  ok?: unknown;
  error?: unknown;
  code?: unknown;
  payload?: unknown;
};

const asWireRecord = (data: MessageEvent['data']): WireRecord | null => (
  Object(data) === data ? data : null
);

const isNonEmptyString = (value: WireRecord[keyof WireRecord]): value is string => (
  String(value) === value && value.length > 0
);

const readResultMessage = (wire: WireRecord): HostResultMessage | null => {
  if (!isNonEmptyString(wire.id)) return null;
  if (wire.ok === true) {
    const message: HostResultMessage = {
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'result',
      id: wire.id,
      ok: true,
    };
    if (Object(wire.payload) === wire.payload) {
      // SAFETY: a trusted host answered an id this client issued; the per-call
      // guards in host.ts (isStartSessionResult and friends) narrow the payload
      // before it reaches a caller.
      message.payload = wire.payload as HostResultPayload;
    }
    return message;
  }
  if (wire.ok === false && isNonEmptyString(wire.error)) {
    return {
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'result',
      id: wire.id,
      ok: false,
      error: wire.error,
      code: resolveHostRequestErrorCode(isNonEmptyString(wire.code) ? wire.code : undefined),
    };
  }
  return null;
};

/**
 * The guest's read of a host message. The host is the trusted parent frame
 * (the client only listens to `event.source === parent`), so this checks the
 * envelope and the discriminant rather than every field, and the guest bundle
 * carries no schema library for it. The host side parses guest input with
 * `guestMessageSchema` in `@openchamber/sdk/schemas`.
 */
export const readHostMessage = (data: MessageEvent['data']): HostMessage | null => {
  const wire = asWireRecord(data);
  if (!wire || wire.channel !== OPENCHAMBER_SDK_CHANNEL || wire.v !== OPENCHAMBER_SDK_API_VERSION) return null;
  if (wire.type === 'result') return readResultMessage(wire);
  if (!HOST_PUSH_TYPES.has(String(wire.type)) || Object(wire.payload) !== wire.payload) return null;
  // SAFETY: envelope and discriminant verified above and the sender is the
  // trusted parent frame; protocol.ts asserts these push shapes against the
  // host's own schema at compile time.
  return wire as HostMessage;
};
