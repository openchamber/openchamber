import { z } from 'zod';

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
  font: string;
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

export type HostResultPayload =
  | GuestRequestResult
  | StartSessionResult
  | PromptResult
  | AgentStatusResult;

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

export type AttachIssueRequest = {
  providerId: string;
  id: string;
  title: string;
  url: string;
  text?: string;
  kind?: AttachThreadKind;
  author?: string;
  branches?: AttachBranches;
};

export type StartSessionRequest = AttachIssueRequest & {
  worktree?: boolean;
};

export const GUEST_CLIPBOARD_TEXT_MAX = 32_000;
export const GUEST_COMPOSE_TEXT_MAX = 16_000;
export const GUEST_ATTACH_ID_MAX = 128;
export const GUEST_ATTACH_TITLE_MAX = 200;
export const GUEST_ATTACH_URL_MAX = 2_000;
export const GUEST_ATTACH_TEXT_MAX = 16_000;
export const GUEST_ATTACH_AUTHOR_MAX = 80;
export const GUEST_ATTACH_BRANCH_MAX = 200;
export const GUEST_ACCOUNT_MAX = 200;
export const GUEST_SESSION_MODEL_MAX = 200;
export const GUEST_SESSION_AGENT_MAX = 80;
export const GUEST_SETTING_VALUE_MAX = 2_000;
export const GUEST_REQUEST_PATH_MAX = 2_000;
export const GUEST_REQUEST_BODY_MAX = 64_000;
export const GUEST_REQUEST_RESPONSE_MAX = 256_000;
export const GUEST_REQUEST_TIMEOUT_MS = 20_000;

export const HOST_REQUEST_ERROR_CODES = [
  'HOST_UNAVAILABLE',
  'HOST_TIMEOUT',
  'HOST_REJECTED',
  'DISCONNECTED',
  'BAD_PATH',
  'NO_INTEGRATION',
  'NO_AGENT',
  'AGENT_FAILED',
  'NO_SESSION',
  'SESSION_BUSY',
] as const;

export const AGENT_STATUS_VALUES = ['stopped', 'starting', 'ready', 'failed'] as const;

export type AgentStatus = (typeof AGENT_STATUS_VALUES)[number];

export type AgentStatusResult = {
  status: AgentStatus;
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

const ATTACH_PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
const SETTING_KEY = /^[a-z][a-z0-9-]*$/;

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

const envelope = {
  channel: z.literal(OPENCHAMBER_SDK_CHANNEL),
  v: z.literal(OPENCHAMBER_SDK_API_VERSION),
};

const themeTokensSchema = z.object({
  background: z.string().min(1),
  elevated: z.string().min(1),
  foreground: z.string().min(1),
  muted: z.string().min(1),
  subtle: z.string().min(1),
  border: z.string().min(1),
  hover: z.string().min(1),
  selection: z.string().min(1),
  focus: z.string().min(1),
  primary: z.string().min(1),
  font: z.string().min(1),
  radius: z.string().min(1),
});

const sessionSnapshotSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  busy: z.boolean().optional().default(false),
  model: z.string().min(1).max(GUEST_SESSION_MODEL_MAX).optional(),
  agent: z.string().min(1).max(GUEST_SESSION_AGENT_MAX).optional(),
}).nullable();

const guestConnectionSchema = z.object({
  connected: z.boolean(),
  account: z.string().max(GUEST_ACCOUNT_MAX),
});

const guestSettingsSchema = z.record(
  z.string().regex(SETTING_KEY),
  z.string().max(GUEST_SETTING_VALUE_MAX),
);

const requestResultPayloadSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: z.string().max(GUEST_REQUEST_RESPONSE_MAX),
});

const startSessionResultPayloadSchema = z.object({
  sessionId: z.string().min(1),
  sent: z.enum(START_SESSION_SENT),
});

const promptResultPayloadSchema = z.object({
  sent: z.enum(START_SESSION_SENT),
});

const agentStatusResultPayloadSchema = z.object({
  status: z.enum(AGENT_STATUS_VALUES),
});

export const isAgentStatusResult = (
  value: HostResultPayload | undefined,
): value is AgentStatusResult => agentStatusResultPayloadSchema.safeParse(value).success;

export const isGuestRequestResult = (
  value: HostResultPayload | undefined,
): value is GuestRequestResult => requestResultPayloadSchema.safeParse(value).success;

const hostResultPayloadSchema = z.union([
  startSessionResultPayloadSchema,
  requestResultPayloadSchema,
  promptResultPayloadSchema,
  agentStatusResultPayloadSchema,
]);

const readyPayloadSchema = z.object({
  theme: z.object({
    mode: z.enum(['light', 'dark']),
    tokens: themeTokensSchema,
  }),
  locale: z.string().min(1),
  directory: z.string().nullable(),
  session: sessionSnapshotSchema,
  surface: z.enum(['panel', 'dialog']),
  connection: guestConnectionSchema,
  settings: guestSettingsSchema,
});

const hostResultSchema = z.object({
  ...envelope,
  type: z.literal('result'),
  id: z.string().min(1),
  ok: z.boolean(),
  error: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  payload: hostResultPayloadSchema.optional(),
}).transform((message, ctx) => {
  if (message.ok) {
    if (message.payload) {
      return {
        channel: message.channel,
        v: message.v,
        type: 'result' as const,
        id: message.id,
        ok: true as const,
        payload: message.payload,
      };
    }
    return {
      channel: message.channel,
      v: message.v,
      type: 'result' as const,
      id: message.id,
      ok: true as const,
    };
  }
  if (!message.error) {
    ctx.addIssue({ code: 'custom', message: 'Failed result needs an error string.' });
    return z.NEVER;
  }
  return {
    channel: message.channel,
    v: message.v,
    type: 'result' as const,
    id: message.id,
    ok: false as const,
    error: message.error,
    code: resolveHostRequestErrorCode(message.code),
  };
});

export const hostMessageSchema = z.union([
  z.object({
    ...envelope,
    type: z.literal('ready'),
    payload: readyPayloadSchema,
  }),
  z.object({
    ...envelope,
    type: z.literal('directory'),
    payload: z.object({
      directory: z.string().nullable(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('session'),
    payload: z.object({
      session: sessionSnapshotSchema,
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('connection'),
    payload: z.object({
      connection: guestConnectionSchema,
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('settings'),
    payload: z.object({
      settings: guestSettingsSchema,
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('session-lifecycle'),
    payload: z.object({
      sessionId: z.string().min(1),
      phase: z.enum(SESSION_LIFECYCLE_PHASES),
    }),
  }),
  hostResultSchema,
]);

const attachPayloadSchema = z.object({
  providerId: z.string().trim().regex(ATTACH_PROVIDER_ID),
  id: z.string().trim().min(1).max(GUEST_ATTACH_ID_MAX),
  title: z.string().trim().min(1).max(GUEST_ATTACH_TITLE_MAX),
  url: z.string().trim().min(1).max(GUEST_ATTACH_URL_MAX),
  text: z.string().trim().min(1).max(GUEST_ATTACH_TEXT_MAX).optional(),
  kind: z.enum(['issue', 'pull']).optional(),
  author: z.string().trim().min(1).max(GUEST_ATTACH_AUTHOR_MAX).optional(),
  branches: z.object({
    head: z.string().trim().min(1).max(GUEST_ATTACH_BRANCH_MAX),
    base: z.string().trim().min(1).max(GUEST_ATTACH_BRANCH_MAX),
  }).optional(),
});

export const guestMessageSchema = z.discriminatedUnion('type', [
  z.object({
    ...envelope,
    type: z.literal('hello'),
  }),
  z.object({
    ...envelope,
    type: z.literal('toast'),
    id: z.string().min(1),
    payload: z.object({
      kind: z.enum(['info', 'success', 'error']),
      message: z.string().trim().min(1),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('open-url'),
    id: z.string().min(1),
    payload: z.object({
      url: z.string().trim().min(1),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('open-surface'),
    id: z.string().min(1),
    payload: z.object({
      surfaceId: z.string().trim().min(1),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('clipboard-write'),
    id: z.string().min(1),
    payload: z.object({
      text: z.string().min(1).max(GUEST_CLIPBOARD_TEXT_MAX),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('compose'),
    id: z.string().min(1),
    payload: z.object({
      text: z.string().trim().min(1).max(GUEST_COMPOSE_TEXT_MAX),
      mode: z.enum(['replace', 'append']).optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('attach'),
    id: z.string().min(1),
    payload: attachPayloadSchema,
  }),
  z.object({
    ...envelope,
    type: z.literal('start-session'),
    id: z.string().min(1),
    payload: attachPayloadSchema.extend({
      worktree: z.boolean().optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('prompt'),
    id: z.string().min(1),
    payload: z.object({
      text: z.string().trim().min(1).max(GUEST_COMPOSE_TEXT_MAX),
      send: z.boolean().optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('session-link'),
    id: z.string().min(1),
    payload: attachPayloadSchema,
  }),
  z.object({
    ...envelope,
    type: z.literal('close'),
    id: z.string().min(1),
  }),
  z.object({
    ...envelope,
    type: z.literal('oauth-start'),
    id: z.string().min(1),
  }),
  z.object({
    ...envelope,
    type: z.literal('oauth-disconnect'),
    id: z.string().min(1),
  }),
  z.object({
    ...envelope,
    type: z.literal('request'),
    id: z.string().min(1),
    payload: z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().trim().min(1).max(GUEST_REQUEST_PATH_MAX).refine(isGuestRequestPath),
      query: z.record(z.string().min(1).max(128), z.string().max(2_000)).optional(),
      body: z.string().max(GUEST_REQUEST_BODY_MAX).optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('agent-request'),
    id: z.string().min(1),
    payload: z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().trim().min(1).max(GUEST_REQUEST_PATH_MAX).refine(isGuestRequestPath),
      query: z.record(z.string().min(1).max(128), z.string().max(2_000)).optional(),
      body: z.string().max(GUEST_REQUEST_BODY_MAX).optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('agent-status'),
    id: z.string().min(1),
  }),
]);

export type HostMessage = z.infer<typeof hostMessageSchema>;
export type GuestMessage = z.infer<typeof guestMessageSchema>;
type HostWire = z.input<typeof hostMessageSchema>;
type GuestWire = z.input<typeof guestMessageSchema>;

export type GuestHelloMessage = Extract<GuestMessage, { type: 'hello' }>;
export type GuestToastMessage = Extract<GuestMessage, { type: 'toast' }>;
export type GuestOpenUrlMessage = Extract<GuestMessage, { type: 'open-url' }>;
export type GuestOpenSurfaceMessage = Extract<GuestMessage, { type: 'open-surface' }>;
export type GuestClipboardWriteMessage = Extract<GuestMessage, { type: 'clipboard-write' }>;
export type GuestComposeMessage = Extract<GuestMessage, { type: 'compose' }>;
export type GuestAttachMessage = Extract<GuestMessage, { type: 'attach' }>;
export type GuestStartSessionMessage = Extract<GuestMessage, { type: 'start-session' }>;
export type GuestPromptMessage = Extract<GuestMessage, { type: 'prompt' }>;
export type GuestSessionLinkMessage = Extract<GuestMessage, { type: 'session-link' }>;
export type GuestCloseMessage = Extract<GuestMessage, { type: 'close' }>;
export type GuestOauthStartMessage = Extract<GuestMessage, { type: 'oauth-start' }>;
export type GuestOauthDisconnectMessage = Extract<GuestMessage, { type: 'oauth-disconnect' }>;
export type GuestRequestMessage = Extract<GuestMessage, { type: 'request' }>;
export type GuestAgentRequestMessage = Extract<GuestMessage, { type: 'agent-request' }>;
export type GuestAgentStatusMessage = Extract<GuestMessage, { type: 'agent-status' }>;
export type HostReadyMessage = Extract<HostMessage, { type: 'ready' }>;
export type HostDirectoryMessage = Extract<HostMessage, { type: 'directory' }>;
export type HostSessionMessage = Extract<HostMessage, { type: 'session' }>;
export type HostSessionLifecycleMessage = Extract<HostMessage, { type: 'session-lifecycle' }>;
export type HostConnectionMessage = Extract<HostMessage, { type: 'connection' }>;
export type HostSettingsMessage = Extract<HostMessage, { type: 'settings' }>;
export type HostResultMessage = Extract<HostMessage, { type: 'result' }>;

export const parseHostMessage = (document: HostWire): HostMessage | null => {
  const parsed = hostMessageSchema.safeParse(document);
  return parsed.success ? parsed.data : null;
};

export const parseGuestMessage = (document: GuestWire): GuestMessage | null => {
  const parsed = guestMessageSchema.safeParse(document);
  return parsed.success ? parsed.data : null;
};
