import { z } from 'zod';

import { OPENCHAMBER_SDK_MANIFEST_API_VERSIONS } from './api-version.ts';
import type { OpenChamberManifestApiVersion } from './api-version.ts';
import { OPENCHAMBER_ENGINE_PATTERN } from './host-version.ts';

const PANEL_ID = /^[a-z][a-z0-9-]*$/;

export type PanelContribution = {
  id: string;
  name: string;
  icon: string;
  entry: string;
};

export type AttachMode = 'panel' | 'dialog';

export type AttachContribution = boolean | AttachMode;

export type IntegrationSettingField = {
  id: string;
  label: string;
};

export type IntegrationOAuthAccount = {
  path: string;
  name: string;
};

export type IntegrationOAuth = {
  authorizeUrl: string;
  tokenUrl: string;
  apiOrigin: string;
  scopes?: string[];
  account?: IntegrationOAuthAccount;
};

export type IntegrationToken = {
  apiOrigin: string;
  account?: IntegrationOAuthAccount;
};

export type IntegrationHostProvider = 'linear';

export type IntegrationHost = {
  provider: IntegrationHostProvider;
};

export type IntegrationAuth = 'oauth' | 'token' | 'host';

export type GuestAuthorization = 'bearer' | 'header';

export type ResolvedGuestApi = {
  apiOrigin: string;
  account?: IntegrationOAuthAccount;
  authorization: GuestAuthorization;
};

export const HOST_LINEAR_API_ORIGIN = 'https://api.linear.app';

export type IntegrationContribution = {
  name: string;
  description: string;
  oauth?: IntegrationOAuth;
  token?: IntegrationToken;
  host?: IntegrationHost;
  settings?: IntegrationSettingField[];
};

/** Catalog card. Drops oauth URLs and token apiOrigin. */
export type PublicIntegration = {
  name: string;
  description: string;
  auth: IntegrationAuth;
  settings?: IntegrationSettingField[];
};

export const resolveIntegrationAuth = (
  integration: Pick<IntegrationContribution, 'oauth' | 'token' | 'host'>,
): IntegrationAuth | null => {
  const kinds = [Boolean(integration.oauth), Boolean(integration.token), Boolean(integration.host)]
    .filter(Boolean).length;
  if (kinds !== 1) {
    return null;
  }
  if (integration.host) return 'host';
  return integration.oauth ? 'oauth' : 'token';
};

export const resolveIntegrationApi = (
  integration: IntegrationContribution,
): ResolvedGuestApi | null => {
  if (integration.oauth) {
    return {
      apiOrigin: integration.oauth.apiOrigin,
      account: integration.oauth.account,
      authorization: 'bearer',
    };
  }
  if (integration.token) {
    return {
      apiOrigin: integration.token.apiOrigin,
      account: integration.token.account,
      authorization: 'header',
    };
  }
  if (integration.host?.provider === 'linear') {
    return {
      apiOrigin: HOST_LINEAR_API_ORIGIN,
      authorization: 'bearer',
    };
  }
  return null;
};

export type SocketPlatform = 'linux' | 'darwin' | 'win32';

/** Declared socket the agent may dial. Candidates are per host platform. */
export type SocketBinding = {
  id: string;
  candidatesByPlatform: Partial<Record<SocketPlatform, string[]>>;
};

export type AgentPermissions = {
  sockets?: SocketBinding[];
  exec?: string[];
};

/** Catalog grant chip: ids only. Paths live on `socketBindings`. */
export type PublicAgentPermissions = {
  sockets?: string[];
  exec?: string[];
};

/** Resolved socket for this host after override + candidate scan. */
export type PublicSocketBinding = {
  id: string;
  candidates: string[];
  resolved: string | null;
  override: string | null;
};

export type AgentContribution = {
  entry: string;
  runtime: 'host';
  permissions?: AgentPermissions;
};

/** Catalog card for a local agent. Drops nothing secret; grant is host state. */
export type PublicAgent = {
  runtime: 'host';
  permissions?: PublicAgentPermissions;
  socketBindings?: PublicSocketBinding[];
  granted: boolean;
};

export type OpenChamberContributes = {
  panel: PanelContribution;
  attach?: AttachContribution;
  integration?: IntegrationContribution;
  agent?: AgentContribution;
};

export const resolveAttachMode = (attach: AttachContribution | undefined): AttachMode | null => {
  if (attach === true || attach === 'panel') return 'panel';
  if (attach === 'dialog') return 'dialog';
  return null;
};

export type OpenChamberEngines = {
  openchamber: string;
};

export type OpenChamberManifest = {
  apiVersion: OpenChamberManifestApiVersion;
  engines?: OpenChamberEngines;
  contributes: OpenChamberContributes;
};

export type ParseManifestErrorCode =
  | 'not-object'
  | 'missing-openchamber'
  | 'unsupported-api-version'
  | 'invalid-engines'
  | 'invalid-version'
  | 'missing-panel'
  | 'invalid-panel-id'
  | 'invalid-panel-name'
  | 'invalid-panel-icon'
  | 'invalid-panel-entry'
  | 'invalid-attach'
  | 'invalid-integration'
  | 'invalid-agent';

export type ParseManifestFailure = {
  ok: false;
  code: ParseManifestErrorCode;
  message: string;
};

export type ParseManifestSuccess = {
  ok: true;
  manifest: OpenChamberManifest;
  /** npm `package.json` version when parsing a package envelope. */
  version?: string;
};

export type ParseManifestResult = ParseManifestSuccess | ParseManifestFailure;

const isSafeAssetPath = (value: string): boolean => {
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.includes('://')) {
    return false;
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value);
};

/** Package SVG path for the rail, e.g. `icon.svg`. Remixicon names use `PANEL_ID`. */
export const isGuestPackageSvgIcon = (value: string): boolean => (
  isSafeAssetPath(value) && value.toLowerCase().endsWith('.svg')
);

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

export const toPublicIntegration = (integration: IntegrationContribution): PublicIntegration => {
  const auth = resolveIntegrationAuth(integration) ?? 'oauth';
  const next: PublicIntegration = {
    name: integration.name,
    description: integration.description,
    auth,
  };
  if (integration.settings && integration.settings.length > 0) {
    next.settings = integration.settings.map((field) => ({
      id: field.id,
      label: field.label,
    }));
  }
  return next;
};

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

const agentPermissionsSchema = z.object({
  sockets: z.array(socketEntrySchema).max(32).optional(),
  exec: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
}).strict().transform((value) => {
  const next: AgentPermissions = {};
  if (value.sockets && value.sockets.length > 0) {
    next.sockets = value.sockets;
  }
  if (value.exec && value.exec.length > 0) {
    next.exec = [...value.exec];
  }
  return next;
});

const agentSchema = z.object({
  entry: z.string().trim().refine(isSafeAssetPath),
  runtime: z.literal('host'),
  permissions: agentPermissionsSchema.optional(),
});

export const openChamberManifestSchema = z.object({
  apiVersion: z.literal(OPENCHAMBER_SDK_MANIFEST_API_VERSIONS[0]),
  engines: z.object({
    openchamber: z.string().trim().regex(OPENCHAMBER_ENGINE_PATTERN),
  }).strict().optional(),
  contributes: z.object({
    panel: panelSchema,
    attach: z.union([z.boolean(), z.enum(['panel', 'dialog'])]).optional(),
    integration: integrationSchema.optional(),
    agent: agentSchema.optional(),
  }),
});

export const toPublicAgent = (
  agent: AgentContribution | undefined,
  granted: boolean,
  socketBindings?: PublicSocketBinding[],
): PublicAgent | undefined => {
  if (!agent) {
    return undefined;
  }
  const next: PublicAgent = {
    runtime: agent.runtime,
    granted,
  };
  if (agent.permissions) {
    const permissions: PublicAgentPermissions = {};
    if (agent.permissions.sockets && agent.permissions.sockets.length > 0) {
      permissions.sockets = agent.permissions.sockets.map((binding) => binding.id);
    }
    if (agent.permissions.exec && agent.permissions.exec.length > 0) {
      permissions.exec = [...agent.permissions.exec];
    }
    if (permissions.sockets || permissions.exec) {
      next.permissions = permissions;
    }
  }
  if (socketBindings && socketBindings.length > 0) {
    next.socketBindings = socketBindings.map((binding) => ({
      id: binding.id,
      candidates: [...binding.candidates],
      resolved: binding.resolved,
      override: binding.override,
    }));
  }
  return next;
};

/** Guest package version: `1.2.3`, optional prerelease / build. */
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
  const path = issue.path.join('.');
  if (!path && issue.code === 'invalid_type') {
    return fail('not-object', 'Manifest must be a plain object.');
  }
  if (path.includes('apiVersion') || issue.code === 'invalid_value') {
    return fail(
      'unsupported-api-version',
      `Unsupported apiVersion. This host accepts ${OPENCHAMBER_SDK_MANIFEST_API_VERSIONS.join(' and ')}.`,
    );
  }
  if (path === 'version' || path.endsWith('.version')) {
    return fail(
      'invalid-version',
      'package.json version must be semver like 1.0.0.',
    );
  }
  if (path.includes('engines')) {
    return fail(
      'invalid-engines',
      'engines.openchamber must be a version like 1.22.0 or >=1.22.0.',
    );
  }
  if (path.endsWith('id')) {
    return fail('invalid-panel-id', 'panel.id must be kebab-case starting with a letter.');
  }
  if (path.endsWith('name')) {
    return fail('invalid-panel-name', 'panel.name must be a non-empty string.');
  }
  if (path.endsWith('icon')) {
    return fail(
      'invalid-panel-icon',
      'panel.icon must be a Remixicon name or a package .svg path.',
    );
  }
  if (path.endsWith('entry')) {
    return fail('invalid-panel-entry', 'panel.entry must be a relative path inside the package.');
  }
  if (path.endsWith('attach')) {
    return fail('invalid-attach', 'contributes.attach must be true, false, "panel", or "dialog".');
  }
  if (path.includes('integration')) {
    return fail(
      'invalid-integration',
      'contributes.integration needs a name, description, and oauth, token, or host.',
    );
  }
  if (path.includes('agent')) {
    return fail(
      'invalid-agent',
      'contributes.agent needs entry, runtime "host", and optional permissions.',
    );
  }
  if (path.includes('openchamber') && issue.code === 'invalid_type') {
    return fail('missing-openchamber', 'package.json openchamber must be a plain object.');
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
