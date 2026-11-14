import {
  GUEST_ACTIONS_MAX,
  GUEST_BLOCKS_MAX,
  GUEST_BLOCK_ARGS_MAX,
  GUEST_BLOCK_ARG_NAME,
  GUEST_BLOCK_NAME,
  GUEST_CAPABILITIES,
  GUEST_COMMANDS_MAX,
  GUEST_COMMAND_NAME,
  GUEST_FILE_EDITORS_MAX,
  GUEST_FILE_EDITOR_PATTERNS_MAX,
  GUEST_FILE_EDITOR_TITLE_MAX,
  GUEST_LINK_ACTIONS,
  GUEST_LINK_KEY,
  GUEST_LINK_KEYS_MAX,
  GUEST_SERVICE_PROVIDES,
  GUEST_SESSION_EVENT_TYPES,
  GUEST_STATUS_SECTION_HEIGHT_MAX,
  GUEST_STATUS_SECTION_HEIGHT_MIN,
  GUEST_STATUS_SECTION_TITLE_MAX,
  GUEST_STATUS_SOURCE_INTERVAL_MAX,
  GUEST_STATUS_SOURCE_INTERVAL_MIN,
  GUEST_SURFACE_DOCKS,
  GUEST_TOOLS_MAX,
  GUEST_TOOL_MATCH,
  GUEST_TOOL_OUTPUTS,
  TRACKER_URL_TEMPLATES_MAX,
  isBuildableLinkTemplate,
  GUEST_WAITS_MAX,
  GUEST_WAIT_ID,
  GUEST_WAIT_TITLE_MAX,
  isFileEditorPattern,
  isGuestProviderLogoPath,
  isGuestRequestPath,
  isOpenCodeProviderId,
} from '@openchamber/sdk';
import { guestToolCardSchema } from '@openchamber/sdk/schemas';
import { z } from 'zod';

import type { GuestCatalog, InstalledGuest } from './types.ts';

const PANEL_ID = /^[a-z][a-z0-9-]*$/;
/** Characters in one stored setting value, as the server's auth store caps it. */
const GUEST_TOOL_LINK_SETTING_MAX = 2000;
const STORAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const publicIntegrationSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  auth: z.enum(['oauth', 'token', 'host']).default('oauth'),
  token: z.object({
    scheme: z.enum(['raw', 'bearer', 'basic']),
    usernameLabel: z.string().trim().min(1).optional(),
  }).optional(),
  apiOrigin: z.string().trim().min(1).optional(),
  settings: z.array(z.object({
    id: z.string().regex(PANEL_ID),
    label: z.string().trim().min(1),
    secret: z.literal(true).optional(),
  })).optional(),
});

const publicSocketBindingSchema = z.object({
  id: z.string().trim().min(1),
  candidates: z.array(z.string()),
  resolved: z.string().nullable(),
  override: z.string().nullable(),
});

const publicServiceSchema = z.object({
  runtime: z.literal('host'),
  granted: z.boolean(),
  permissions: z.object({
    sockets: z.array(z.string().trim().min(1)).optional(),
    exec: z.array(z.string().trim().min(1)).optional(),
  }).optional(),
  socketBindings: z.array(publicSocketBindingSchema).optional(),
  // A role this build does not know (a newer server) drops the field, not the
  // catalog: every other extension must keep working.
  provides: z.array(z.enum(GUEST_SERVICE_PROVIDES)).optional().catch(undefined),
  surface: z.literal(true).optional().catch(undefined),
  keepRunning: z.literal(true).optional().catch(undefined),
  schedule: z.array(z.object({ id: z.string(), cron: z.string(), timezone: z.string().optional() })).optional().catch(undefined),
});

// The Git host a source-control provider extension adds, as the approval
// dialog shows it. A malformed slice drops the field, never the row.
const publicSourceControlSchema = z.object({
  label: z.string().trim().min(1).max(64),
  defaultInstances: z.array(z.string().trim().min(1)).max(4),
  custom: z.boolean(),
});

// The session events a service subscribed to, as the approval dialog lists
// them. An event type this build does not know is a newer server: the field
// drops, never the row.
const publicSessionEventsSchema = z.object({
  events: z.array(z.enum(GUEST_SESSION_EVENT_TYPES)).min(1).max(GUEST_SESSION_EVENT_TYPES.length),
  content: z.boolean(),
});

// The notification channel a `notifications` service provides, as the
// approval dialog and the Integrations card show it. A malformed slice drops
// the field, never the row.
export const publicNotificationsSchema = z.object({
  label: z.string().trim().min(1).max(64),
  instances: z.union([
    z.object({ kind: z.literal('fixed'), origin: z.string().trim().min(1).max(2_048) }),
    z.object({ kind: z.literal('user'), label: z.string().trim().min(1).max(64), placeholder: z.string().trim().max(256).optional() }),
  ]),
  token: z.object({
    scheme: z.enum(['bearer', 'token', 'basic', 'none']),
    username: z.boolean(),
    scopes: z.array(z.string().trim().min(1).max(64)).max(32),
    createPath: z.string().trim().min(1).max(256).optional(),
  }),
});

// The tracker a `tracker` service provides, as the approval dialog and the
// account card show it. A malformed slice drops the field, never the row.
const publicTrackerInstancesSchema = z.union([
  z.object({ kind: z.literal('fixed'), origin: z.string().trim().min(1).max(2_048) }),
  z.object({ kind: z.literal('user'), label: z.string().trim().min(1).max(64), placeholder: z.string().trim().max(256).optional() }),
]);
const publicTrackerSchema = z.object({
  label: z.string().trim().min(1).max(64),
  instances: publicTrackerInstancesSchema,
  authMethods: z.array(z.enum(['oauth', 'token'])).max(2),
  token: z.object({
    scheme: z.enum(['bearer', 'token', 'basic', 'none']),
    username: z.boolean(),
    scopes: z.array(z.string().trim().min(1).max(64)).max(32),
    createPath: z.string().trim().min(1).max(256).optional(),
  }).optional(),
  oauth: z.object({ scopes: z.array(z.string().trim().min(1).max(64)).max(32) }).optional(),
});

// The usage provider a `quota` service provides, as the approval dialog shows
// it: the OpenCode providers whose credentials the service receives. A
// malformed slice drops the field, never the row.
const publicQuotaSchema = z.object({
  providers: z.array(z.string().trim().min(1).max(64)).max(16),
});

const guestActionSchema = z.object({
  id: z.string().regex(PANEL_ID),
  label: z.string().trim().min(1),
  icon: z.string().trim().min(1).optional(),
  where: z.enum(['message', 'session', 'selection', 'file', 'diff']),
  mode: z.enum(['open', 'background']).optional(),
  roles: z.array(z.enum(['user', 'assistant'])).optional(),
  payload: z.array(z.enum(['messages'])).optional(),
  display: z.enum(['label', 'icon', 'both']).optional(),
});

const guestCommandSchema = z.object({
  name: z.string().regex(GUEST_COMMAND_NAME),
  description: z.string().trim().min(1).optional(),
});

const guestBlockSchema = z.object({
  name: z.string().regex(GUEST_BLOCK_NAME),
  description: z.string().trim().min(1),
  args: z.array(z.string().regex(GUEST_BLOCK_ARG_NAME)).max(GUEST_BLOCK_ARGS_MAX),
  entry: z.string().trim().min(1),
  height: z.number().int().positive().optional(),
  answers: z.boolean().optional(),
});

const guestToolSchema = z.object({
  match: z.string().regex(GUEST_TOOL_MATCH),
  name: z.string().trim().min(1).optional(),
  icon: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  subtitle: z.string().trim().min(1).optional(),
  output: z.enum(GUEST_TOOL_OUTPUTS).optional(),
  language: z.string().trim().min(1).optional(),
  columns: z.array(z.string().trim().min(1)).optional(),
  // The SDK's own schema: a card is drawn from these templates, one of them an `href`.
  card: guestToolCardSchema.optional(),
});

const guestFileEditorSchema = z.object({
  id: z.string().regex(PANEL_ID),
  title: z.string().trim().min(1).max(GUEST_FILE_EDITOR_TITLE_MAX),
  match: z.array(z.string().refine(isFileEditorPattern)).min(1).max(GUEST_FILE_EDITOR_PATTERNS_MAX),
  entry: z.string().trim().min(1),
  content: z.enum(['text', 'binary']).optional(),
});

export const guestUpdateSchema = z.object({
  version: z.string().trim().min(1).max(64),
});

// `contributes.links` as the server compiled it (`guests/links.js`): literal
// keys, and link patterns the UI only runs, never a template it compiles.
const publicLinksSchema = z.object({
  action: z.enum(GUEST_LINK_ACTIONS),
  keys: z.array(z.string().regex(GUEST_LINK_KEY)).max(GUEST_LINK_KEYS_MAX),
  urls: z.object({
    origin: z.string().refine((value) => URL.canParse(value) && new URL(value).protocol === 'https:' && new URL(value).origin === value),
    identifierPattern: z.string().min(1),
    patterns: z.array(z.object({
      path: z.string().min(1),
      query: z.object({ name: z.string().min(1) }).optional(),
    })).min(1).max(TRACKER_URL_TEMPLATES_MAX),
    itemTemplate: z.string().refine(isBuildableLinkTemplate).nullable(),
  }).nullable(),
}).refine((links) => links.keys.length > 0 || links.urls !== null);

const installedGuestSchema = z.object({
  id: z.string().regex(PANEL_ID),
  storageId: z.string().min(1).max(128).regex(STORAGE_ID).optional(),
  name: z.string().trim().min(1),
  icon: z.string().trim().min(1),
  entry: z.string().trim().min(1).optional(),
  /** Edge and thickness beside a shared surface; see `PanelContribution.dock`. */
  entryDock: z.enum(GUEST_SURFACE_DOCKS).optional(),
  entrySize: z.number().int().positive().optional(),
  entryMobile: z.literal(true).optional().catch(undefined),
  backgroundEntry: z.string().trim().min(1).optional(),
  version: z.string().trim().min(1).max(64).optional(),
  revision: z.number().int().positive().optional(),
  attach: z.union([z.boolean(), z.enum(['panel', 'dialog'])]).optional(),
  attachEntry: z.string().trim().min(1).optional(),
  pageEntry: z.string().trim().min(1).optional(),
  pageTitle: z.string().trim().min(1).max(200).optional(),
  pageMobile: z.literal(true).optional().catch(undefined),
  statusEntry: z.string().trim().min(1).optional(),
  statusSource: z.object({
    path: z.string().refine(isGuestRequestPath),
    interval: z.number().int().min(GUEST_STATUS_SOURCE_INTERVAL_MIN).max(GUEST_STATUS_SOURCE_INTERVAL_MAX),
  }).strict().optional(),
  statusTitle: z.string().trim().min(1).max(GUEST_STATUS_SECTION_TITLE_MAX).optional(),
  statusHeight: z.number().int().min(GUEST_STATUS_SECTION_HEIGHT_MIN).max(GUEST_STATUS_SECTION_HEIGHT_MAX).optional(),
  statusDefaultExpanded: z.boolean().optional(),
  statusRequiresProject: z.boolean().optional(),
  integration: publicIntegrationSchema.optional(),
  filesystem: z.array(z.string().trim().min(1)).optional(),
  origins: z.array(z.string().trim().min(1)).optional(),
  service: publicServiceSchema.optional(),
  sourceControl: publicSourceControlSchema.optional().catch(undefined),
  sessionEvents: publicSessionEventsSchema.optional().catch(undefined),
  // Only what the approval dialog names; a malformed slice drops the field, never the row.
  waits: z.array(z.object({
    id: z.string().regex(GUEST_WAIT_ID),
    title: z.string().trim().min(1).max(GUEST_WAIT_TITLE_MAX),
  })).max(GUEST_WAITS_MAX).optional().catch(undefined),
  notifications: publicNotificationsSchema.optional().catch(undefined),
  tracker: publicTrackerSchema.optional().catch(undefined),
  quota: publicQuotaSchema.optional().catch(undefined),
  sessionControl: z.object({ content: z.boolean() }).optional().catch(undefined),
  instructions: z.literal(true).optional().catch(undefined),
  marks: z.literal(true).optional().catch(undefined),
  skills: z.literal(true).optional().catch(undefined),
  opencodePlugin: z.literal(true).optional().catch(undefined),
  mentions: z.object({ label: z.string().trim().min(1) }).optional().catch(undefined),
  links: publicLinksSchema.optional().catch(undefined),
  needsConfiguration: z.string().trim().min(1).optional().catch(undefined),
  blocks: z.array(guestBlockSchema).max(GUEST_BLOCKS_MAX).optional(),
  actions: z.array(guestActionSchema).max(GUEST_ACTIONS_MAX).optional(),
  commands: z.array(guestCommandSchema).max(GUEST_COMMANDS_MAX).optional(),
  tools: z.array(guestToolSchema).max(GUEST_TOOLS_MAX).optional(),
  // Values a card link reads; a malformed slice costs those links, never the row.
  toolLinkSettings: z.record(z.string().regex(PANEL_ID), z.string().min(1).max(GUEST_TOOL_LINK_SETTING_MAX)).optional().catch(undefined),
  // A row with logos this build cannot read keeps the rest of the extension.
  providerLogos: z.record(z.string().refine(isOpenCodeProviderId), z.string().refine(isGuestProviderLogoPath)).optional().catch(undefined),
  fileEditors: z.array(guestFileEditorSchema).max(GUEST_FILE_EDITORS_MAX).optional(),
  capabilities: z.object({
    requested: z.array(z.enum(GUEST_CAPABILITIES)),
    granted: z.array(z.enum(GUEST_CAPABILITIES)),
  }),
  enterpriseBlocked: z.array(z.enum(GUEST_CAPABILITIES)).optional(),
  source: z.enum(['bundled', 'path', 'zip', 'git']).optional(),
  path: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  origin: z.object({
    url: z.string().trim().min(1),
    ref: z.string().trim().min(1).optional(),
  }).optional(),
  update: guestUpdateSchema.optional(),
});

// A delivery state this build does not know draws nothing: the card would otherwise offer a button for a case it cannot describe.
const openCodePluginsSchema = z.object({
  delivery: z.enum(['file', 'restart', 'none', 'remote']),
  globalConfigPath: z.string().nullable(),
  inGlobalConfig: z.array(z.string()),
});

const catalogSchema = z.object({
  guests: z.array(z.unknown()),
  opencodePlugins: openCodePluginsSchema.optional().catch(undefined),
});

// What Settings can still show of a row it cannot read, so the user can
// remove it. Each field falls back on its own.
const unreadableGuestSchema = z.object({
  id: z.string().regex(PANEL_ID).nullable().catch(null),
  name: z.string().trim().min(1).nullable().catch(null),
  source: z.string().nullable().catch(null),
}).catch({ id: null, name: null, source: null });

/**
 * Rows are read one by one: a row this build cannot read (a newer server, a
 * broken package) is listed in `unreadable` and every other row still loads.
 * Only a response without a guest list is a failure.
 */
export const parseGuestCatalogJson = (json: string): GuestCatalog | null => {
  try {
    const parsed = catalogSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    const catalog: GuestCatalog = { guests: [], unreadable: [], opencodePlugins: parsed.data.opencodePlugins ?? null };
    for (const row of parsed.data.guests) {
      const guest = installedGuestSchema.safeParse(row);
      if (guest.success) {
        catalog.guests.push(guest.data);
        continue;
      }
      const { id, name, source } = unreadableGuestSchema.parse(row);
      catalog.unreadable.push({ id, name, builtIn: source === 'bundled' });
    }
    return catalog;
  } catch {
    return null;
  }
};

/**
 * The answer to an install: the row, `'unreadable'` when the server installed
 * a package and answered with a row this build cannot read, or null when the
 * answer is not an install row at all.
 */
export const parseInstallAnswerJson = (json: string): InstalledGuest | 'unreadable' | null => {
  try {
    const raw: unknown = JSON.parse(json);
    const guest = z.object({ guest: installedGuestSchema }).safeParse(raw);
    if (guest.success) return guest.data.guest;
    return z.object({ guest: z.object({ id: z.string() }) }).safeParse(raw).success ? 'unreadable' : null;
  } catch {
    return null;
  }
};

export const parseInstalledGuestJson = (json: string): InstalledGuest | null => {
  try {
    const parsed = z.object({ guest: installedGuestSchema }).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data.guest : null;
  } catch {
    return null;
  }
};
