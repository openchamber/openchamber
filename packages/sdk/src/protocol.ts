import { z } from 'zod';

import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import {
  SERVICE_STATUS_VALUES,
  ATTACH_PROVIDER_ID,
  GUEST_ACCOUNT_MAX,
  GUEST_ATTACH_AUTHOR_MAX,
  GUEST_BADGE_MAX,
  GUEST_ITEM_MESSAGE_TEXT_MAX,
  GUEST_ITEM_SESSION_MAX,
  GUEST_RESOLVE_ERROR_MAX,
  GUEST_ATTACH_BRANCH_MAX,
  GUEST_ATTACH_DATA_MAX,
  GUEST_ATTACH_ID_MAX,
  GUEST_ATTACH_TEXT_MAX,
  GUEST_ATTACH_TITLE_MAX,
  GUEST_ATTACH_URL_MAX,
  GUEST_CLIPBOARD_TEXT_MAX,
  GUEST_COMPOSE_TEXT_MAX,
  GUEST_FILE_CONTENT_MAX,
  GUEST_FILE_ENTRY_KINDS,
  GUEST_FILE_LIST_MAX,
  GUEST_FILE_PATH_MAX,
  GUEST_FILE_STAT_KINDS,
  GUEST_REQUEST_BODY_MAX,
  GUEST_REQUEST_PATH_MAX,
  GUEST_REQUEST_RESPONSE_MAX,
  GUEST_SESSION_AGENT_MAX,
  GUEST_SESSION_MODEL_MAX,
  GUEST_SETTING_VALUE_MAX,
  GUEST_TOAST_MAX,
  SESSION_LIFECYCLE_PHASES,
  SETTING_KEY,
  START_SESSION_SENT,
  isGuestFilePath,
  isGuestRequestPath,
  resolveHostRequestErrorCode,
  type GuestMessage,
  type HostMessage,
} from './contract.ts';

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
  mutedSurface: z.string().min(1),
  elevatedForeground: z.string().min(1),
  active: z.string().min(1),
  selectionForeground: z.string().min(1),
  primaryForeground: z.string().min(1),
  success: z.string().min(1),
  warning: z.string().min(1),
  error: z.string().min(1),
  info: z.string().min(1),
  font: z.string().min(1),
  mono: z.string().min(1),
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

const serviceStatusResultPayloadSchema = z.object({
  status: z.enum(SERVICE_STATUS_VALUES),
});

const fileReadResultPayloadSchema = z.object({
  content: z.string().max(GUEST_FILE_CONTENT_MAX),
});

const fileWriteResultPayloadSchema = z.object({
  written: z.literal(true),
});

const fileListResultPayloadSchema = z.object({
  entries: z.array(z.object({
    name: z.string().min(1),
    kind: z.enum(GUEST_FILE_ENTRY_KINDS),
  })).max(GUEST_FILE_LIST_MAX),
});

const fileStatResultPayloadSchema = z.object({
  kind: z.enum(GUEST_FILE_STAT_KINDS),
  size: z.number().int().min(0),
  mtime: z.number().int().min(0),
});

const hostResultPayloadSchema = z.union([
  startSessionResultPayloadSchema,
  requestResultPayloadSchema,
  promptResultPayloadSchema,
  serviceStatusResultPayloadSchema,
  fileReadResultPayloadSchema,
  fileWriteResultPayloadSchema,
  fileListResultPayloadSchema,
  fileStatResultPayloadSchema,
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
  data: z.json().refine((value) => JSON.stringify(value).length <= GUEST_ATTACH_DATA_MAX).optional(),
});

const guestItemRoleSchema = z.enum(['user', 'assistant']);

const messageItemSchema = z.object({
  kind: z.literal('message'),
  action: z.string().trim().min(1).max(64),
  sessionId: z.string().min(1),
  sessionTitle: z.string(),
  directory: z.string().nullable(),
  messageId: z.string().min(1),
  role: guestItemRoleSchema,
  text: z.string().max(GUEST_ITEM_MESSAGE_TEXT_MAX),
});

const sessionItemSchema = z.object({
  kind: z.literal('session'),
  action: z.string().trim().min(1).max(64),
  sessionId: z.string().min(1),
  sessionTitle: z.string(),
  directory: z.string().nullable(),
  messages: z.array(z.object({
    id: z.string().min(1),
    role: guestItemRoleSchema,
    text: z.string().max(GUEST_ITEM_MESSAGE_TEXT_MAX),
    createdAt: z.number().int().min(0),
  })).optional(),
  truncated: z.boolean().optional(),
}).refine((value) => JSON.stringify(value).length <= GUEST_ITEM_SESSION_MAX);

// Message and session items carry a literal `kind`; the chip's optional
// `kind` is `issue` / `pull`, so the three never overlap.
const guestItemSchema = z.union([messageItemSchema, sessionItemSchema, attachPayloadSchema]).nullable();

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
  item: guestItemSchema,
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
  z.object({
    ...envelope,
    type: z.literal('item'),
    payload: z.object({
      item: guestItemSchema,
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('resolve'),
    id: z.string().min(1),
    payload: z.object({
      command: z.string().min(1),
      args: z.string(),
    }),
  }),
  hostResultSchema,
]);

const filePathSchema = z.string().min(1).max(GUEST_FILE_PATH_MAX).refine(isGuestFilePath);

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
      message: z.string().trim().min(1).max(GUEST_TOAST_MAX),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('open-url'),
    id: z.string().min(1),
    payload: z.object({
      url: z.string().trim().min(1).max(GUEST_ATTACH_URL_MAX),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('open-surface'),
    id: z.string().min(1),
    payload: z.object({
      surfaceId: z.string().trim().min(1).max(64),
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
    type: z.literal('service-request'),
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
    type: z.literal('service-status'),
    id: z.string().min(1),
  }),
  z.object({
    ...envelope,
    type: z.literal('file-read'),
    id: z.string().min(1),
    payload: z.object({ path: filePathSchema }),
  }),
  z.object({
    ...envelope,
    type: z.literal('file-write'),
    id: z.string().min(1),
    payload: z.object({
      path: filePathSchema,
      content: z.string().max(GUEST_FILE_CONTENT_MAX),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('file-list'),
    id: z.string().min(1),
    payload: z.object({ path: filePathSchema }),
  }),
  z.object({
    ...envelope,
    type: z.literal('file-stat'),
    id: z.string().min(1),
    payload: z.object({ path: filePathSchema }),
  }),
  z.object({
    ...envelope,
    type: z.literal('badge'),
    id: z.string().min(1),
    payload: z.object({
      count: z.number().int().min(0).max(GUEST_BADGE_MAX).nullable(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('resolve-result'),
    id: z.string().min(1),
    payload: z.union([
      z.object({ item: attachPayloadSchema.nullable() }),
      z.object({ error: z.string().trim().min(1).max(GUEST_RESOLVE_ERROR_MAX) }),
    ]),
  }),
]);

type ParsedHostMessage = z.infer<typeof hostMessageSchema>;
type ParsedGuestMessage = z.infer<typeof guestMessageSchema>;
type HostWire = z.input<typeof hostMessageSchema>;
type GuestWire = z.input<typeof guestMessageSchema>;


// The hand-written contract types and the schemas must describe the same wire
// shapes; either drifting from the other fails this file's type-check.
const assertHostParsed: (value: ParsedHostMessage) => HostMessage = (value) => value;
const assertHostContract: (value: HostMessage) => ParsedHostMessage = (value) => value;
const assertGuestParsed: (value: ParsedGuestMessage) => GuestMessage = (value) => value;
const assertGuestContract: (value: GuestMessage) => ParsedGuestMessage = (value) => value;
void assertHostParsed; void assertHostContract; void assertGuestParsed; void assertGuestContract;

export const parseHostMessage = (document: HostWire): HostMessage | null => {
  const parsed = hostMessageSchema.safeParse(document);
  return parsed.success ? parsed.data : null;
};

export const parseGuestMessage = (document: GuestWire): GuestMessage | null => {
  const parsed = guestMessageSchema.safeParse(document);
  return parsed.success ? parsed.data : null;
};
