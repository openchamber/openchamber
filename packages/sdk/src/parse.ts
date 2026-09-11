import { z } from 'zod';

import { OPENCHAMBER_SDK_MANIFEST_API_VERSIONS } from './api-version.ts';
import { OPENCHAMBER_ENGINE_PATTERN } from './host-version.ts';
import {
  DECLARED_GUEST_CAPABILITIES,
  GUEST_ACTIONS_MAX,
  GUEST_ACTION_LABEL_MAX,
  GUEST_COMMANDS_MAX,
  GUEST_COMMAND_DESCRIPTION_MAX,
  GUEST_COMMAND_NAME,
  GUEST_FILESYSTEM_PATTERNS_MAX,
  GUEST_FILESYSTEM_PATTERN_MAX,
  PANEL_ID,
  isGuestFilesystemPattern,
  isGuestPackageSvgIcon,
  isSafeAssetPath,
  resolveIntegrationAuth,
  type ServicePermissions,
  type ParseManifestErrorCode,
  type ParseManifestFailure,
  type ParseManifestResult,
  type ParseManifestSuccess,
  type SocketBinding,
} from './manifest.ts';

const isPanelIcon = (value: string): boolean => (
  PANEL_ID.test(value) || isGuestPackageSvgIcon(value)
);

const isHttpsUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
};

const isHttpsOrigin = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === '/'
      && parsed.search === ''
      && parsed.hash === ''
      && value === parsed.origin;
  } catch {
    return false;
  }
};

const isSafeApiPath = (value: string): boolean => {
  if (!value.startsWith('/') || value.includes('\0') || value.includes('\\') || value.includes('://')) {
    return false;
  }
  const segments = value.split('/');
  return !segments.some((segment) => segment === '.' || segment === '..');
};

const ACCOUNT_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

const attachModeSchema = z.enum(['panel', 'dialog']);

// `entry` only means something for the dialog; a panel-mode object naming one
// is a misconfiguration and fails closed rather than carrying a dead field.
const attachObjectSchema = z.object({
  mode: attachModeSchema,
  entry: z.string().trim().refine(isSafeAssetPath).optional(),
}).refine((value) => value.mode === 'dialog' || value.entry === undefined, { path: ['entry'] });

const attachSchema = z.union([z.boolean(), attachModeSchema, attachObjectSchema]);

const panelSchema = z.object({
  id: z.string().trim().regex(PANEL_ID),
  name: z.string().trim().min(1),
  icon: z.string().trim().refine(isPanelIcon),
  entry: z.string().trim().refine(isSafeAssetPath),
});

const integrationSettingSchema = z.object({
  id: z.string().trim().regex(PANEL_ID),
  label: z.string().trim().min(1),
});

const integrationOauthSchema = z.object({
  authorizeUrl: z.string().trim().refine(isHttpsUrl),
  tokenUrl: z.string().trim().refine(isHttpsUrl),
  apiOrigin: z.string().trim().refine(isHttpsOrigin),
  scopes: z.array(z.string().trim().min(1)).optional(),
  account: z.object({
    path: z.string().trim().refine(isSafeApiPath),
    name: z.string().trim().regex(ACCOUNT_NAME),
  }).optional(),
});

const integrationTokenSchema = z.object({
  apiOrigin: z.string().trim().refine(isHttpsOrigin),
  account: z.object({
    path: z.string().trim().refine(isSafeApiPath),
    name: z.string().trim().regex(ACCOUNT_NAME),
  }).optional(),
  scheme: z.enum(['raw', 'bearer', 'basic']).optional(),
  usernameLabel: z.string().trim().min(1).max(64).optional(),
});

const integrationHostSchema = z.object({
  provider: z.enum(['linear']),
});

const integrationSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  oauth: integrationOauthSchema.optional(),
  token: integrationTokenSchema.optional(),
  host: integrationHostSchema.optional(),
  settings: z.array(integrationSettingSchema).optional(),
}).refine((value) => resolveIntegrationAuth(value) !== null, { path: ['oauth'] });

const SOCKET_PLATFORMS = ['linux', 'darwin', 'win32'] as const;

const socketPathSchema = z.string().trim().min(1).max(512);

const socketCandidatesSchema = z.object({
  linux: z.array(socketPathSchema).max(16).optional(),
  darwin: z.array(socketPathSchema).max(16).optional(),
  win32: z.array(socketPathSchema).max(16).optional(),
}).strict();

const socketBindingObjectSchema = z.object({
  id: z.string().trim().regex(PANEL_ID).max(64),
  path: socketPathSchema.optional(),
  candidates: socketCandidatesSchema.optional(),
}).strict().refine(
  (value) => Boolean(value.path) || Boolean(value.candidates),
  { message: 'socket binding needs path or candidates' },
);

const normalizeSocketObject = (
  entry: z.infer<typeof socketBindingObjectSchema>,
): SocketBinding => {
  const candidatesByPlatform: SocketBinding['candidatesByPlatform'] = {};
  if (entry.candidates) {
    for (const platform of SOCKET_PLATFORMS) {
      const list = entry.candidates[platform];
      if (list && list.length > 0) {
        candidatesByPlatform[platform] = [...list];
      }
    }
  } else if (entry.path) {
    for (const platform of SOCKET_PLATFORMS) {
      candidatesByPlatform[platform] = [entry.path];
    }
  }
  return { id: entry.id, candidatesByPlatform };
};

const socketEntrySchema = z.union([
  socketPathSchema.transform((path): SocketBinding => ({
    id: path,
    candidatesByPlatform: {
      linux: [path],
      darwin: [path],
      win32: [path],
    },
  })),
  socketBindingObjectSchema.transform(normalizeSocketObject),
]);

const servicePermissionsSchema = z.object({
  sockets: z.array(socketEntrySchema).max(32).optional(),
  exec: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
}).strict().transform((value) => {
  const next: ServicePermissions = {};
  if (value.sockets && value.sockets.length > 0) {
    next.sockets = value.sockets;
  }
  if (value.exec && value.exec.length > 0) {
    next.exec = [...value.exec];
  }
  return next;
});

const serviceSchema = z.object({
  entry: z.string().trim().refine(isSafeAssetPath),
  runtime: z.literal('host'),
  permissions: servicePermissionsSchema.optional(),
});

const uniqueBy = <T,>(items: T[], key: (item: T) => string): boolean => (
  new Set(items.map(key)).size === items.length
);

// `roles` only means something on a message action and `payload` only on a
// session action; a dead field is a misconfiguration and fails closed.
const actionSchema = z.object({
  id: z.string().trim().regex(PANEL_ID).max(64),
  label: z.string().trim().min(1).max(GUEST_ACTION_LABEL_MAX),
  icon: z.string().trim().refine(isPanelIcon).optional(),
  where: z.enum(['message', 'session']),
  roles: z.array(z.enum(['user', 'assistant'])).min(1).max(2).optional(),
  payload: z.array(z.enum(['messages'])).max(1).optional(),
}).refine((value) => value.where === 'message' || value.roles === undefined, { path: ['roles'] })
  .refine((value) => value.where === 'session' || value.payload === undefined, { path: ['payload'] });

const actionsSchema = z.array(actionSchema).min(1).max(GUEST_ACTIONS_MAX)
  .refine((actions) => uniqueBy(actions, (action) => action.id), { message: 'action ids must be unique' });

const commandSchema = z.object({
  name: z.string().trim().regex(GUEST_COMMAND_NAME),
  description: z.string().trim().min(1).max(GUEST_COMMAND_DESCRIPTION_MAX).optional(),
});

const commandsSchema = z.array(commandSchema).min(1).max(GUEST_COMMANDS_MAX)
  .refine((commands) => uniqueBy(commands, (command) => command.name), { message: 'command names must be unique' });

export const openChamberManifestSchema = z.object({
  apiVersion: z.literal(OPENCHAMBER_SDK_MANIFEST_API_VERSIONS[0]),
  engines: z.object({
    openchamber: z.string().trim().regex(OPENCHAMBER_ENGINE_PATTERN),
  }).strict().optional(),
  contributes: z.object({
    panel: panelSchema,
    attach: attachSchema.optional(),
    capabilities: z.array(z.enum(DECLARED_GUEST_CAPABILITIES)).max(8).optional(),
    integration: integrationSchema.optional(),
    service: serviceSchema.optional(),
    filesystem: z.array(
      z.string().max(GUEST_FILESYSTEM_PATTERN_MAX).refine(isGuestFilesystemPattern),
    ).min(1).max(GUEST_FILESYSTEM_PATTERNS_MAX).optional(),
    actions: actionsSchema.optional(),
    commands: commandsSchema.optional(),
  }),
});

export const PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const packageVersionSchema = z.string().trim().regex(PACKAGE_VERSION_PATTERN).max(64);

export const packageManifestSchema = z.object({
  version: packageVersionSchema.optional(),
  openchamber: openChamberManifestSchema,
});

const packageEnvelopeSchema = z.union([
  z.object({ openchamber: z.null() }),
  z.object({ openchamber: z.object({}).passthrough() }),
]);

export type ManifestDocument = z.input<typeof openChamberManifestSchema> | z.input<typeof packageManifestSchema>;

const fail = (code: ParseManifestErrorCode, message: string): ParseManifestFailure => ({
  ok: false,
  code,
  message,
});

const failureFromIssue = (issue: { path: ReadonlyArray<PropertyKey>; code: string }): ParseManifestFailure => {
  // Paths are reported relative to the `openchamber` block whether the
  // document was a bare manifest or a package.json envelope.
  const segments = issue.path.map(String);
  const path = (segments[0] === 'openchamber' ? segments.slice(1) : segments).join('.');
  const isPackageEnvelope = segments[0] === 'openchamber';
  if (!path && issue.code === 'invalid_type') {
    return isPackageEnvelope
      ? fail('missing-openchamber', 'package.json openchamber must be a plain object.')
      : fail('not-object', 'Manifest must be a plain object.');
  }
  if (segments.length === 1 && segments[0] === 'version') {
    return fail('invalid-version', 'package.json version must be semver like 1.0.0.');
  }
  if (path === 'apiVersion') {
    return fail(
      'unsupported-api-version',
      `Unsupported apiVersion. This host accepts ${OPENCHAMBER_SDK_MANIFEST_API_VERSIONS.join(' and ')}.`,
    );
  }
  if (path === 'engines' || path.startsWith('engines.')) {
    return fail('invalid-engines', 'engines.openchamber must be a version like 1.22.0 or >=1.22.0.');
  }
  if (path === 'contributes' || path === 'contributes.panel') {
    return fail('missing-panel', 'contributes.panel is required.');
  }
  switch (path) {
    case 'contributes.panel.id':
      return fail('invalid-panel-id', 'panel.id must be kebab-case starting with a letter.');
    case 'contributes.panel.name':
      return fail('invalid-panel-name', 'panel.name must be a non-empty string.');
    case 'contributes.panel.icon':
      return fail('invalid-panel-icon', 'panel.icon must be a Remixicon name or a package .svg path.');
    case 'contributes.panel.entry':
      return fail('invalid-panel-entry', 'panel.entry must be a relative path inside the package.');
    case 'contributes.capabilities':
      return fail('invalid-capabilities', 'contributes.capabilities may list "prompt", "sessions", and "files".');
    default:
      break;
  }
  if (path === 'contributes.attach' || path.startsWith('contributes.attach.')) {
    return fail(
      'invalid-attach',
      'contributes.attach must be true, false, "panel", "dialog", or { "mode": "panel" | "dialog", "entry"?: "<html inside the package, dialog only>" }.',
    );
  }
  if (path.startsWith('contributes.capabilities')) {
    return fail('invalid-capabilities', 'contributes.capabilities may list "prompt", "sessions", and "files".');
  }
  if (path.startsWith('contributes.filesystem')) {
    return fail(
      'invalid-filesystem',
      'contributes.filesystem lists 1 to 16 patterns starting with "/" or "~/", without "..", empty segments, or backslashes.',
    );
  }
  if (path.startsWith('contributes.actions')) {
    return fail(
      'invalid-actions',
      'contributes.actions lists up to 8 entries with a unique kebab-case id, a label of 1 to 40 characters, where "message" or "session", optional roles (message only), and optional payload ["messages"] (session only).',
    );
  }
  if (path.startsWith('contributes.commands')) {
    return fail(
      'invalid-commands',
      'contributes.commands lists up to 8 entries with a unique name matching /^[a-z][a-z0-9-]{0,23}$/ and an optional description of 1 to 80 characters.',
    );
  }
  if (path.startsWith('contributes.integration')) {
    return fail(
      'invalid-integration',
      'contributes.integration needs a name, description, and oauth, token, or host.',
    );
  }
  if (path.startsWith('contributes.service')) {
    return fail('invalid-service', 'contributes.service needs entry, runtime "host", and optional permissions.');
  }
  return fail('missing-panel', 'contributes.panel is required.');
};

const decodeManifest = (parsed: ReturnType<typeof openChamberManifestSchema.safeParse>): ParseManifestResult => {
  if (parsed.success) {
    return { ok: true, manifest: parsed.data };
  }
  const issue = parsed.error.issues[0];
  if (!issue) {
    return fail('not-object', 'Manifest must be a plain object.');
  }
  return failureFromIssue(issue);
};

export const parseManifest = (document: ManifestDocument): ParseManifestResult => {
  if ('openchamber' in document) {
    const parsed = packageManifestSchema.safeParse(document);
    if (parsed.success) {
      const success: ParseManifestSuccess = {
        ok: true,
        manifest: parsed.data.openchamber,
      };
      if (parsed.data.version) {
        success.version = parsed.data.version;
      }
      return success;
    }
    const issue = parsed.error.issues[0];
    if (!issue) {
      return fail('not-object', 'Manifest must be a plain object.');
    }
    return failureFromIssue(issue);
  }
  return decodeManifest(openChamberManifestSchema.safeParse(document));
};

export const parseManifestJson = (json: string): ParseManifestResult => {
  try {
    const raw = JSON.parse(json);
    if (packageEnvelopeSchema.safeParse(raw).success) {
      const parsed = packageManifestSchema.safeParse(raw);
      if (parsed.success) {
        const success: ParseManifestSuccess = {
          ok: true,
          manifest: parsed.data.openchamber,
        };
        if (parsed.data.version) {
          success.version = parsed.data.version;
        }
        return success;
      }
      const issue = parsed.error.issues[0];
      if (!issue) {
        return fail('not-object', 'Manifest must be a plain object.');
      }
      return failureFromIssue(issue);
    }
    return decodeManifest(openChamberManifestSchema.safeParse(raw));
  } catch {
    return fail('not-object', 'Manifest must be a plain object.');
  }
};
