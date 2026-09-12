import type { OpenChamberManifestApiVersion } from './api-version.ts';

export const PANEL_ID = /^[a-z][a-z0-9-]*$/;

export type PanelContribution = {
  id: string;
  name: string;
  icon: string;
  entry: string;
};

export type AttachMode = 'panel' | 'dialog';

/**
 * Object form of `contributes.attach`. `entry` is an HTML page inside the
 * package that the attach dialog loads instead of `panel.entry`; it is only
 * meaningful with `mode: "dialog"`.
 */
export type AttachContributionObject = {
  mode: AttachMode;
  entry?: string;
};

export type AttachContribution = boolean | AttachMode | AttachContributionObject;

export type GuestActionWhere = 'message' | 'session';
export type GuestActionRole = 'user' | 'assistant';
/** What a session action wants alongside the session id and title. */
export type GuestActionPayload = 'messages';

/** How many `contributes.actions` entries a package may declare. */
export const GUEST_ACTIONS_MAX = 8;
/** Characters in an action label. */
export const GUEST_ACTION_LABEL_MAX = 40;
/** How many `contributes.commands` entries a package may declare. */
export const GUEST_COMMANDS_MAX = 8;
/** Characters in a command description. */
export const GUEST_COMMAND_DESCRIPTION_MAX = 80;
/** A slash command name: lower-case, digits and dashes, up to 24 characters. */
export const GUEST_COMMAND_NAME = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * A menu entry on a message or a session. Clicking it opens the guest with
 * the message or session as `ready.item`. `roles` narrows a message action
 * to user or assistant messages (default both); `payload: ["messages"]` on
 * a session action asks for the conversation and needs the `conversation`
 * capability.
 */
export type GuestActionContribution = {
  id: string;
  label: string;
  /** Remixicon name or package `.svg` path, same as `panel.icon`. Falls back to the panel icon. */
  icon?: string;
  where: GuestActionWhere;
  roles?: GuestActionRole[];
  payload?: GuestActionPayload[];
};

/** A composer slash command the guest resolves into a chip through `host.onResolve`. */
export type GuestCommandContribution = {
  name: string;
  description?: string;
};

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

export type IntegrationTokenScheme = 'raw' | 'bearer' | 'basic';

export type IntegrationToken = {
  apiOrigin: string;
  account?: IntegrationOAuthAccount;
  /**
   * How the pasted token travels: `raw` puts it in `Authorization` as is (default),
   * `bearer` prefixes `Bearer `, `basic` asks for a username too and sends
   * `Basic base64(username:token)` (Jira Cloud, Bitbucket, most Atlassian APIs).
   */
  scheme?: IntegrationTokenScheme;
  /** Label of the username field on the Integrations card for `basic`. Defaults to "Username". */
  usernameLabel?: string;
};

export type IntegrationHostProvider = 'linear';

export type IntegrationHost = {
  provider: IntegrationHostProvider;
};

export type IntegrationAuth = 'oauth' | 'token' | 'host';

export type GuestAuthorization = 'bearer' | 'basic' | 'header';

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
export type PublicIntegrationToken = {
  scheme: IntegrationTokenScheme;
  usernameLabel?: string;
};

export type PublicIntegration = {
  name: string;
  description: string;
  auth: IntegrationAuth;
  /** Present for `auth: 'token'`. Tells the Integrations card which fields to draw. */
  token?: PublicIntegrationToken;
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

const resolveTokenAuthorization = (scheme: IntegrationTokenScheme | undefined): GuestAuthorization => {
  if (scheme === 'bearer' || scheme === 'basic') {
    return scheme;
  }
  return 'header';
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
      authorization: resolveTokenAuthorization(integration.token.scheme),
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

/** Declared socket the service may dial. Candidates are per host platform. */
export type SocketBinding = {
  id: string;
  candidatesByPlatform: Partial<Record<SocketPlatform, string[]>>;
};

export type ServicePermissions = {
  sockets?: SocketBinding[];
  exec?: string[];
};

/** Catalog grant chip: ids only. Paths live on `socketBindings`. */
export type PublicServicePermissions = {
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

export type ServiceContribution = {
  entry: string;
  runtime: 'host';
  permissions?: ServicePermissions;
};

/** Catalog card for a local service. Drops nothing secret; grant is host state. */
export type PublicService = {
  runtime: 'host';
  permissions?: PublicServicePermissions;
  socketBindings?: PublicSocketBinding[];
  granted: boolean;
};

/**
 * What a guest may do beyond drawing its own panel. The user approves the
 * full list once, when the package is installed; a later package that asks
 * for more is re-approved. `prompt`, `sessions`, and `files` are declared
 * under `contributes.capabilities`; `service`, `network`, and `filesystem`
 * follow from `contributes.service`, `contributes.integration`, and
 * `contributes.filesystem`.
 */
export const GUEST_CAPABILITIES = ['prompt', 'sessions', 'files', 'conversation', 'service', 'network', 'filesystem'] as const;

export type GuestCapability = (typeof GUEST_CAPABILITIES)[number];

export const DECLARED_GUEST_CAPABILITIES = ['prompt', 'sessions', 'files'] as const;

/** The capabilities a manifest may ask for directly. */
export type DeclaredGuestCapability = (typeof DECLARED_GUEST_CAPABILITIES)[number];

/** How many `contributes.filesystem` patterns a package may declare. */
export const GUEST_FILESYSTEM_PATTERNS_MAX = 16;
/** Characters in one `contributes.filesystem` pattern. */
export const GUEST_FILESYSTEM_PATTERN_MAX = 256;

/**
 * A `contributes.filesystem` entry: an absolute glob (`/…`) or one under the
 * user's home (`~/…`). `**` spans directories, `*` and `?` stay inside one
 * segment. No `..`, no empty segment, no NUL, no backslash.
 */
export const isGuestFilesystemPattern = (value: string): boolean => {
  if (value.length === 0 || value.length > GUEST_FILESYSTEM_PATTERN_MAX) {
    return false;
  }
  if (value.includes('\0') || value.includes('\\')) {
    return false;
  }
  if (!value.startsWith('/') && !value.startsWith('~/')) {
    return false;
  }
  const segments = value.split('/').slice(1);
  return !segments.some((segment) => segment === '' || segment === '..');
};

export type OpenChamberContributes = {
  panel: PanelContribution;
  attach?: AttachContribution;
  capabilities?: DeclaredGuestCapability[];
  integration?: IntegrationContribution;
  service?: ServiceContribution;
  /** Paths outside the project the panel may read and write. Grants `filesystem`. */
  filesystem?: string[];
  /** Menu entries on messages and sessions. */
  actions?: GuestActionContribution[];
  /** Composer slash commands that attach a chip. */
  commands?: GuestCommandContribution[];
};

/** Whether any declared action asks for a session's messages, which needs `conversation`. */
export const guestActionsNeedConversation = (
  actions: readonly GuestActionContribution[] | undefined,
): boolean => Boolean(actions?.some((action) => action.payload?.includes('messages')));

/** Catalog view of the approval: what the package asks for and what the user allowed. */
export type PublicGuestCapabilities = {
  requested: GuestCapability[];
  granted: GuestCapability[];
};

export const requestedGuestCapabilities = (
  contributes: Pick<OpenChamberContributes, 'capabilities' | 'integration' | 'service' | 'filesystem' | 'actions'>,
): GuestCapability[] => {
  const declared = new Set<GuestCapability>(contributes.capabilities ?? []);
  if (guestActionsNeedConversation(contributes.actions)) declared.add('conversation');
  if (contributes.service) declared.add('service');
  if (contributes.integration) declared.add('network');
  if (contributes.filesystem && contributes.filesystem.length > 0) declared.add('filesystem');
  return GUEST_CAPABILITIES.filter((capability) => declared.has(capability));
};

export const isGuestApproved = (capabilities: PublicGuestCapabilities): boolean => (
  capabilities.requested.every((capability) => capabilities.granted.includes(capability))
);

export const hasGuestCapability = (
  capabilities: PublicGuestCapabilities,
  capability: GuestCapability,
): boolean => capabilities.granted.includes(capability);

// Everything that is not one of the scalar spellings is the object form;
// the parser has already refused anything else.
const isAttachObject = (attach: AttachContribution | undefined): attach is AttachContributionObject => (
  attach !== undefined && attach !== true && attach !== false && attach !== 'panel' && attach !== 'dialog'
);

export const resolveAttachMode = (attach: AttachContribution | undefined): AttachMode | null => {
  if (attach === true || attach === 'panel') return 'panel';
  if (attach === 'dialog') return 'dialog';
  if (isAttachObject(attach)) return attach.mode;
  return null;
};

/**
 * The page the attach dialog loads, or `null` when the dialog reuses
 * `panel.entry`. Only the object form with `mode: "dialog"` can name one.
 */
export const resolveAttachEntry = (
  contributes: Pick<OpenChamberContributes, 'attach'>,
): string | null => {
  const attach = contributes.attach;
  if (!isAttachObject(attach) || attach.mode !== 'dialog') return null;
  return attach.entry ?? null;
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
  | 'invalid-capabilities'
  | 'invalid-integration'
  | 'invalid-service'
  | 'invalid-filesystem'
  | 'invalid-actions'
  | 'invalid-commands';

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

export const isSafeAssetPath = (value: string): boolean => {
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

export const toPublicIntegration = (integration: IntegrationContribution): PublicIntegration => {
  const auth = resolveIntegrationAuth(integration) ?? 'oauth';
  const next: PublicIntegration = {
    name: integration.name,
    description: integration.description,
    auth,
  };
  if (auth === 'token' && integration.token) {
    next.token = { scheme: integration.token.scheme ?? 'raw' };
    if (integration.token.usernameLabel) {
      next.token.usernameLabel = integration.token.usernameLabel;
    }
  }
  if (integration.settings && integration.settings.length > 0) {
    next.settings = integration.settings.map((field) => ({
      id: field.id,
      label: field.label,
    }));
  }
  return next;
};

export const toPublicService = (
  service: ServiceContribution | undefined,
  granted: boolean,
  socketBindings?: PublicSocketBinding[],
): PublicService | undefined => {
  if (!service) {
    return undefined;
  }
  const next: PublicService = {
    runtime: service.runtime,
    granted,
  };
  if (service.permissions) {
    const permissions: PublicServicePermissions = {};
    if (service.permissions.sockets && service.permissions.sockets.length > 0) {
      permissions.sockets = service.permissions.sockets.map((binding) => binding.id);
    }
    if (service.permissions.exec && service.permissions.exec.length > 0) {
      permissions.exec = [...service.permissions.exec];
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
