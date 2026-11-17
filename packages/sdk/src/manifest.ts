import type { OpenChamberManifestApiVersion } from './api-version.ts';
import type { FileEditorContribution } from './file-editor.ts';
import { GUEST_STATUS_SOURCE_INTERVAL_DEFAULT, type StatusSectionSource } from './status-view.ts';
import type { PublicSessionEvents, SessionEventsContribution } from './session-events.ts';
import type { ServiceScheduleEntry } from './service-host.ts';
import type { WaitContribution } from './waits.ts';

export const PANEL_ID = /^[a-z][a-z0-9-]*$/;

export type PanelContribution = {
  id: string;
  name: string;
  icon: string;
  entry?: string;
  dock?: GuestSurfaceDock;
  size?: number;
  mobile?: true;
};

export const GUEST_SURFACE_DOCKS = ['top', 'bottom', 'left', 'right'] as const;
export type GuestSurfaceDock = (typeof GUEST_SURFACE_DOCKS)[number];
export const GUEST_SURFACE_DOCK_DEFAULT: GuestSurfaceDock = 'top';
export const GUEST_SURFACE_DOCK_SIZE_DEFAULT = 40;
export const GUEST_SURFACE_DOCK_SIZE_MIN = 24;
export const GUEST_SURFACE_DOCK_SIZE_MAX = 480;

export type BackgroundContribution = {
  entry: string;
};

export type AttachMode = 'panel' | 'dialog';

export type AttachContributionObject = {
  mode: AttachMode;
  entry?: string;
};

export type AttachContribution = boolean | AttachMode | AttachContributionObject;

export type PageContribution = true | { entry: string; title?: string; mobile?: true };

export type StatusSectionContribution = true | {
  entry?: string;
  source?: StatusSectionSource;
  title?: string;
  height?: number;
  defaultExpanded?: boolean;
  requiresProject?: boolean;
};

export const GUEST_STATUS_SECTION_TITLE_MAX = 60;
export const GUEST_STATUS_SECTION_HEIGHT_MIN = 24;
export const GUEST_STATUS_SECTION_HEIGHT_MAX = 480;
export const GUEST_STATUS_SECTION_HEIGHT_DEFAULT = 120;

export type GuestActionWhere = 'message' | 'session' | 'selection' | 'file' | 'diff';
export type GuestActionRole = 'user' | 'assistant';
export type GuestActionPayload = 'messages';

export const GUEST_ACTIONS_MAX = 8;
export const GUEST_ACTION_LABEL_MAX = 40;
export const GUEST_COMMANDS_MAX = 8;
export const GUEST_COMMAND_DESCRIPTION_MAX = 80;
export const GUEST_COMMAND_NAME = /^[a-z][a-z0-9-]{0,23}$/;

export type GuestActionContribution = {
  id: string;
  label: string;
  icon?: string;
  where: GuestActionWhere;
  mode?: 'open' | 'background';
  roles?: GuestActionRole[];
  payload?: GuestActionPayload[];
  display?: 'label' | 'icon' | 'both';
};

export type GuestCommandContribution = {
  name: string;
  description?: string;
};

export const GUEST_PROVIDER_LOGOS_MAX = 256;
export const GUEST_PROVIDER_LOGO_BYTES_MAX = 1024 * 1024;

export const GUEST_TOOLS_MAX = 16;
export const GUEST_TOOL_MATCH_MAX = 128;
export const GUEST_TOOL_MATCH = /^[A-Za-z0-9_.:-]+\*?$/;
export const GUEST_TOOL_NAME_MAX = 40;
export const GUEST_TOOL_TEMPLATE_MAX = 200;
export const GUEST_TOOL_TEMPLATE_VALUE_MAX = 200;
export const GUEST_TOOL_LANGUAGE_MAX = 32;
export const GUEST_TOOL_COLUMNS_MAX = 16;
export const GUEST_TOOL_COLUMN_MAX = 64;

export const GUEST_TOOL_CARD_FIELDS_MAX = 8;
export const GUEST_TOOL_CARD_TONES_MAX = 16;
export const GUEST_TOOL_CARD_TONE_KEY_MAX = 64;
export const GUEST_TOOL_CARD_URL_MAX = 2048;

export const GUEST_TOOL_OUTPUTS = ['auto', 'text', 'json', 'markdown', 'code', 'table', 'card'] as const;

export type GuestToolOutput = (typeof GUEST_TOOL_OUTPUTS)[number];

export const GUEST_TONES = ['neutral', 'info', 'success', 'warning', 'error'] as const;

export type GuestTone = (typeof GUEST_TONES)[number];

export const GUEST_TOOL_TEMPLATE_ROOTS = ['input', 'output', 'metadata'] as const;

export const guestToolPlaceholderPattern = (roots: readonly string[]): RegExp => (
  new RegExp(`\\{(${roots.join('|')})((?:\\.[A-Za-z0-9_-]+)*)\\}`, 'g')
);

export const GUEST_TOOL_CARD_TEMPLATE_ROOTS = ['input', 'output', 'metadata', 'settings'] as const;

export const guestToolLinkSettingIds = (tools: readonly GuestToolContribution[] | undefined): string[] => {
  const ids = new Set<string>();
  for (const tool of tools ?? []) {
    for (const match of (tool.card?.link?.url ?? '').matchAll(guestToolPlaceholderPattern(['settings']))) {
      if (match[2]) ids.add(match[2].slice(1));
    }
  }
  return [...ids];
};

export type GuestToolCard = {
  label?: string;
  title?: string;
  status?: { value: string; tones?: Record<string, GuestTone> };
  fields?: { label: string; value: string }[];
  link?: { label: string; url: string };
};

export type GuestToolContribution = {
  match: string;
  name?: string;
  icon?: string;
  title?: string;
  subtitle?: string;
  output?: GuestToolOutput;
  language?: string;
  columns?: string[];
  card?: GuestToolCard;
};

export type IntegrationSettingField = {
  id: string;
  label: string;
  secret?: true;
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
  scheme?: IntegrationTokenScheme;
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

export type PublicIntegrationToken = {
  scheme: IntegrationTokenScheme;
  usernameLabel?: string;
};

export type PublicIntegration = {
  name: string;
  description: string;
  auth: IntegrationAuth;
  token?: PublicIntegrationToken;
  apiOrigin?: string;
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

export type SocketBinding = {
  id: string;
  candidatesByPlatform: Partial<Record<SocketPlatform, string[]>>;
};

export type ServicePermissions = {
  sockets?: SocketBinding[];
  exec?: string[];
};

export type PublicServicePermissions = {
  sockets?: string[];
  exec?: string[];
};

export type PublicSocketBinding = {
  id: string;
  candidates: string[];
  resolved: string | null;
  override: string | null;
};

export const GUEST_SERVICE_PROVIDES = ['browser', 'source-control', 'notifications', 'tracker', 'quota', 'opencode'] as const;
export type GuestServiceProvides = (typeof GUEST_SERVICE_PROVIDES)[number];

export const SOURCE_CONTROL_GUEST_ID_MAX = 28;
export const sourceControlProviderIdOf = (guestId: string): string => `ext-${guestId}`;

export const NOTIFICATIONS_GUEST_ID_MAX = 28;
export const notificationProviderIdOf = (guestId: string): string => `ext-${guestId}`;

export type NotificationsContribution = {
  label: string;
  instances: { kind: 'fixed'; origin: string } | { kind: 'user'; label: string; placeholder?: string };
  token: {
    header: 'authorization' | 'private-token';
    scheme: 'bearer' | 'token' | 'basic' | 'none';
    username?: boolean;
    scopes?: string[];
    createPath?: string;
  };
};

export type PublicNotifications = {
  label: string;
  instances: { kind: 'fixed'; origin: string } | { kind: 'user'; label: string; placeholder?: string };
  token: { scheme: 'bearer' | 'token' | 'basic' | 'none'; username: boolean; scopes: string[]; createPath?: string };
};

export const toPublicNotifications = (contribution: NotificationsContribution): PublicNotifications => {
  const token: PublicNotifications['token'] = {
    scheme: contribution.token.scheme,
    username: contribution.token.username === true,
    scopes: [...(contribution.token.scopes ?? [])],
  };
  if (contribution.token.createPath) token.createPath = contribution.token.createPath;
  return { label: contribution.label, instances: { ...contribution.instances }, token };
};

export const QUOTA_GUEST_ID_MAX = 28;
export const quotaProviderIdOf = (guestId: string): string => `ext-${guestId}`;
export const QUOTA_PROVIDERS_MAX = 16;
export const OPENCODE_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const isOpenCodeProviderId = (value: string): boolean => OPENCODE_PROVIDER_ID.test(value);

export type QuotaContribution = {
  providers: string[];
};

export type PublicQuota = {
  providers: string[];
};

export const toPublicQuota = (contribution: QuotaContribution): PublicQuota => ({ providers: [...contribution.providers] });

export const TRACKER_GUEST_ID_MAX = 28;
export const trackerProviderIdOf = (guestId: string): string => `ext-${guestId}`;

export const TRACKER_URL_TEMPLATES_MAX = 8;
export const TRACKER_URL_TEMPLATE_MAX = 256;
export const TRACKER_URL_TOKENS = ['{id}', '{segment}', '{segments+}'] as const;
const TRACKER_URL_TEMPLATE_LITERAL = /^[A-Za-z0-9._~-]+$/;
const TRACKER_URL_TOKEN_SET: ReadonlySet<string> = new Set(TRACKER_URL_TOKENS);
const TRACKER_QUERY_TEMPLATE = /^([A-Za-z0-9_.-]{1,64})=\{id\}$/;

export const isTrackerUrlTemplate = (value: string): boolean => {
  if (!value.startsWith('/') || value.length > TRACKER_URL_TEMPLATE_MAX) return false;
  const queryAt = value.indexOf('?');
  const pathPart = queryAt === -1 ? value : value.slice(0, queryAt);
  const queryPart = queryAt === -1 ? null : value.slice(queryAt + 1);
  const segments = pathPart === '/' ? [] : pathPart.slice(1).split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return false;
  if (segments.some((segment) => !TRACKER_URL_TOKEN_SET.has(segment) && !TRACKER_URL_TEMPLATE_LITERAL.test(segment))) return false;
  const count = (token: string) => segments.filter((segment) => segment === token).length;
  if (count('{segments+}') > 1) return false;
  if (queryPart === null) return count('{id}') === 1;
  return TRACKER_QUERY_TEMPLATE.test(queryPart) && count('{id}') === 0;
};

export const TRACKER_BASE_STATE_FILTERS = ['open', 'all'] as const;
export const TRACKER_STATE_FILTERS_MAX = 16;

export const TRACKER_IDENTIFIER_KINDS = ['key-number', 'number', 'short-code'] as const;
export type TrackerIdentifierKind = (typeof TRACKER_IDENTIFIER_KINDS)[number];

export type TrackerTokenAuth = {
  header: 'authorization' | 'private-token';
  scheme: 'bearer' | 'token' | 'basic' | 'none';
  username?: boolean;
  scopes?: string[];
  createPath?: string;
};

export type TrackerOAuth = {
  authorizeUrl: string;
  tokenUrl: string;
  scopes?: string[];
};

export type TrackerCapabilities = {
  multipleAccounts: boolean;
  stateUpdate: boolean;
  children: boolean;
  labels: boolean;
  priority: boolean;
  filters: { people: boolean; priority: boolean };
  projectMapping: boolean;
  sessionComments: boolean;
};

export type TrackerContribution = {
  wire: 1;
  label: string;
  instances: { kind: 'fixed'; origin: string } | { kind: 'user'; label: string; placeholder?: string };
  auth: { token?: TrackerTokenAuth; oauth?: TrackerOAuth };
  capabilities: TrackerCapabilities;
  stateFilters: string[];
  identifier: TrackerIdentifierKind;
  urls: { item: string[] };
};

export type PublicTracker = {
  label: string;
  instances: { kind: 'fixed'; origin: string } | { kind: 'user'; label: string; placeholder?: string };
  authMethods: Array<'oauth' | 'token'>;
  token?: { scheme: 'bearer' | 'token' | 'basic' | 'none'; username: boolean; scopes: string[]; createPath?: string };
  oauth?: { scopes: string[] };
};

export const toPublicTracker = (contribution: TrackerContribution): PublicTracker => {
  const view: PublicTracker = {
    label: contribution.label,
    instances: { ...contribution.instances },
    authMethods: [
      ...(contribution.auth.oauth ? ['oauth' as const] : []),
      ...(contribution.auth.token ? ['token' as const] : []),
    ],
  };
  if (contribution.auth.token) {
    view.token = {
      scheme: contribution.auth.token.scheme,
      username: contribution.auth.token.username === true,
      scopes: [...(contribution.auth.token.scopes ?? [])],
    };
    if (contribution.auth.token.createPath) view.token.createPath = contribution.auth.token.createPath;
  }
  if (contribution.auth.oauth) view.oauth = { scopes: [...(contribution.auth.oauth.scopes ?? [])] };
  return view;
};

export const SOURCE_CONTROL_DEFAULT_INSTANCES_MAX = 4;
export const SOURCE_CONTROL_URL_TEMPLATES_MAX = 8;
export const SOURCE_CONTROL_URL_TEMPLATE_MAX = 256;
export const SOURCE_CONTROL_URL_TOKENS = ['{owner}', '{namespace+}', '{repo}', '{number}'] as const;

export type SourceControlMergeMethod = 'merge' | 'squash' | 'rebase' | 'submit';

export type SourceControlCapabilities = {
  projects: boolean;
  issues: boolean;
  changeRequests: boolean;
  draftChangeRequests: boolean;
  draftConversion?: boolean;
  merge: false | { methods: SourceControlMergeMethod[] };
  ci: boolean;
  comments: boolean;
  commentEdit: boolean;
  reviews: boolean;
  state: boolean;
  labels: boolean;
  reviewers: boolean;
  changeRequestPatch: boolean;
  liveSummaries: boolean;
  reviewModel?: 'verdict' | 'votes';
  revisions?: boolean;
};

export type SourceControlContribution = {
  wire: 1;
  label: string;
  terminology: { changeRequest: 'pullRequest' | 'mergeRequest' | 'change'; ci: 'checks' | 'pipeline' };
  referencePrefix: { changeRequest: string; issue: string };
  repositoryPath: 'owner/name' | 'namespace/name';
  instances: {
    defaultInstances: string[];
    custom: boolean;
    allowLoopbackHttp: boolean;
    allowPort: boolean;
    placeholder: string;
  };
  capabilities: SourceControlCapabilities;
  login?: { kind: 'service'; hint: string };
  token?: {
    header: 'authorization' | 'private-token';
    scheme: 'bearer' | 'token' | 'basic' | 'none';
    username?: boolean;
    scopes: string[];
    createPath?: string;
  };
  transport: {
    httpsUsername: { kind: 'login' } | { kind: 'fixed'; value: string };
    appendDotGitToHttpsClone: boolean;
  };
  limits: {
    commentMaxLength: number;
    reviewerId: 'numeric' | 'login';
    labelsMax: number;
    reviewersMax: number;
  };
  trackedItems: { batchLimit: number };
  presentation: {
    abbreviation: string;
    promptNoun: string;
    sharedNumberSpace: boolean;
    iconPath?: string;
    urls: { changeRequest: string[]; issue: string[] };
    features: { authorCanReview: boolean; issueCloseReason: boolean; submitRequirements?: boolean; issueEdit?: boolean; changeRequestEdit?: boolean };
    changeRequestTemplates: string[];
  };
};

export type PublicSourceControl = {
  label: string;
  defaultInstances: string[];
  custom: boolean;
};

export const toPublicSourceControl = (contribution: SourceControlContribution): PublicSourceControl => ({
  label: contribution.label,
  defaultInstances: [...contribution.instances.defaultInstances],
  custom: contribution.instances.custom,
});

export type ServiceContribution = {
  entry: string;
  runtime: 'host';
  permissions?: ServicePermissions;
  provides?: GuestServiceProvides[];
  surface?: true;
  keepRunning?: true;
  schedule?: ServiceScheduleEntry[];
};

export type PublicService = {
  runtime: 'host';
  permissions?: PublicServicePermissions;
  socketBindings?: PublicSocketBinding[];
  provides?: GuestServiceProvides[];
  surface?: true;
  keepRunning?: true;
  schedule?: ServiceScheduleEntry[];
  granted: boolean;
};

export const serviceProvides = (
  service: Pick<ServiceContribution, 'provides'> | undefined,
  role: GuestServiceProvides,
): boolean => Boolean(service?.provides?.includes(role));

export const GUEST_CAPABILITIES = ['prompt', 'sessions', 'files', 'model', 'shells', 'microphone', 'conversation', 'service', 'network', 'filesystem', 'origins', 'transcript', 'sessionControl', 'sessionAnswers', 'instructions', 'skills', 'opencodePlugin', 'opencode', 'links', 'wake', 'marks'] as const;

export type GuestCapability = (typeof GUEST_CAPABILITIES)[number];

export const DECLARED_GUEST_CAPABILITIES = ['prompt', 'sessions', 'files', 'model', 'shells', 'microphone'] as const;

export type DeclaredGuestCapability = (typeof DECLARED_GUEST_CAPABILITIES)[number];

export const GUEST_ORIGINS_MAX = 8;

export const GUEST_FILESYSTEM_PATTERNS_MAX = 16;
export const GUEST_FILESYSTEM_PATTERN_MAX = 256;

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

export type SessionControlContribution = {
  content?: true;
  answers?: true;
};

export type MentionsContribution = {
  label: string;
};

export const GUEST_MENTIONS_LABEL_MAX = 40;

export const GUEST_LINK_KEYS_MAX = 8;
export const GUEST_LINK_KEY = /^[A-Z][A-Z0-9_]{0,31}$/;
export const GUEST_LINK_ACTIONS = ['open', 'attach'] as const;
export type GuestLinkAction = (typeof GUEST_LINK_ACTIONS)[number];

export type LinksContribution = {
  action: GuestLinkAction;
  identifier?: { keys: string[] };
  urls?: { origin: string; identifier: TrackerIdentifierKind; item: string[] };
};

export const isBuildableLinkTemplate = (template: string): boolean => (
  isTrackerUrlTemplate(template) && !template.includes('{segment}') && !template.includes('{segments+}')
);

export const buildLinkUrl = (origin: string, template: string, identifier: string): string => (
  `${origin}${template.replace('{id}', encodeURIComponent(identifier))}`
);

export const GUEST_BLOCK_NAME = /^[A-Z][A-Za-z0-9]{1,31}$/;
export const GUEST_BLOCK_ARG_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
export const GUEST_BLOCKS_MAX = 4;
export const GUEST_BLOCK_ARGS_MAX = 8;
export const GUEST_BLOCK_DESCRIPTION_MAX = 120;
export const GUEST_BLOCK_ARGS_TEXT_MAX = 16_000;
export const GUEST_BLOCK_HEIGHT_DEFAULT = 120;
export const GUEST_BLOCK_RESERVED_NAMES: readonly string[] = [
  'Stack', 'Row', 'Card', 'Tabs', 'Tab', 'Text', 'Badge', 'Callout', 'KeyValue', 'Table', 'Steps', 'BarChart', 'LineChart',
  'Series', 'Stat', 'Progress', 'Choice', 'Input', 'DateInput', 'Slider', 'Details', 'Button',
];

export const GUEST_BLOCK_HEIGHT_MAX = 960;

export type GuestBlockContribution = {
  name: string;
  description: string;
  args: string[];
  entry: string;
  height?: number;
  answers?: boolean;
};

export type OpenChamberContributes = {
  panel: PanelContribution;
  background?: BackgroundContribution;
  attach?: AttachContribution;
  page?: PageContribution;
  statusSection?: StatusSectionContribution;
  capabilities?: DeclaredGuestCapability[];
  integration?: IntegrationContribution;
  service?: ServiceContribution;
  filesystem?: string[];
  origins?: string[];
  actions?: GuestActionContribution[];
  commands?: GuestCommandContribution[];
  tools?: GuestToolContribution[];
  providerLogos?: Record<string, string>;
  fileEditors?: FileEditorContribution[];
  sourceControl?: SourceControlContribution;
  sessionEvents?: SessionEventsContribution;
  waits?: WaitContribution[];
  notifications?: NotificationsContribution;
  tracker?: TrackerContribution;
  quota?: QuotaContribution;
  sessionControl?: SessionControlContribution;
  instructions?: true;
  marks?: true;
  skills?: string;
  opencodePlugin?: string;
  mentions?: MentionsContribution;
  blocks?: GuestBlockContribution[];
  links?: LinksContribution;
};

export const guestActionsNeedConversation = (
  actions: readonly GuestActionContribution[] | undefined,
): boolean => Boolean(actions?.some((action) => action.payload?.includes('messages')));

export type PublicGuestCapabilities = {
  requested: GuestCapability[];
  granted: GuestCapability[];
};

export const requestedGuestCapabilities = (
  contributes: Pick<OpenChamberContributes, 'capabilities' | 'integration' | 'service' | 'filesystem' | 'actions' | 'origins' | 'sessionEvents' | 'sessionControl' | 'instructions' | 'skills' | 'opencodePlugin' | 'links' | 'waits' | 'marks'>,
): GuestCapability[] => {
  const declared = new Set<GuestCapability>(contributes.capabilities ?? []);
  if (guestActionsNeedConversation(contributes.actions)) declared.add('conversation');
  if (contributes.service) declared.add('service');
  if (serviceProvides(contributes.service, 'opencode')) declared.add('opencode');
  if (contributes.integration) declared.add('network');
  if (contributes.filesystem && contributes.filesystem.length > 0) declared.add('filesystem');
  if (contributes.origins && contributes.origins.length > 0) declared.add('origins');
  if (contributes.sessionEvents?.content || contributes.sessionControl?.content) declared.add('transcript');
  if (contributes.sessionControl) declared.add('sessionControl');
  if (contributes.sessionControl?.answers) declared.add('sessionAnswers');
  if (contributes.instructions) declared.add('instructions');
  if (contributes.skills) declared.add('skills');
  if (contributes.opencodePlugin) declared.add('opencodePlugin');
  if (contributes.links) declared.add('links');
  if (contributes.waits && contributes.waits.length > 0) declared.add('wake');
  if (contributes.marks) declared.add('marks');
  return GUEST_CAPABILITIES.filter((capability) => declared.has(capability));
};

export const toPublicSessionEvents = (contribution: SessionEventsContribution): PublicSessionEvents => ({
  events: [...contribution.events],
  content: contribution.content === true,
});

export const hasGuestPage = (
  contributes: Pick<OpenChamberContributes, 'panel'>,
): boolean => Boolean(contributes.panel.entry);

export const isGuestApproved = (capabilities: PublicGuestCapabilities): boolean => (
  capabilities.requested.every((capability) => capabilities.granted.includes(capability))
);

export const hasGuestCapability = (
  capabilities: PublicGuestCapabilities,
  capability: GuestCapability,
): boolean => capabilities.granted.includes(capability);

const isAttachObject = (attach: AttachContribution | undefined): attach is AttachContributionObject => (
  attach !== undefined && attach !== true && attach !== false && attach !== 'panel' && attach !== 'dialog'
);

export const resolveAttachMode = (attach: AttachContribution | undefined): AttachMode | null => {
  if (attach === true || attach === 'panel') return 'panel';
  if (attach === 'dialog') return 'dialog';
  if (isAttachObject(attach)) return attach.mode;
  return null;
};

export const resolveAttachEntry = (
  contributes: Pick<OpenChamberContributes, 'attach'>,
): string | null => {
  const attach = contributes.attach;
  if (!isAttachObject(attach) || attach.mode !== 'dialog') return null;
  return attach.entry ?? null;
};

export const resolvePageEntry = (contributes: Pick<OpenChamberContributes, 'panel' | 'page'>): string | null => {
  if (!contributes.page) return null;
  return contributes.page === true ? contributes.panel.entry ?? null : contributes.page.entry;
};

export const resolvePageMobile = (contributes: Pick<OpenChamberContributes, 'panel' | 'page'>): boolean => {
  if (!contributes.page) return false;
  return (contributes.page === true ? contributes.panel.mobile : contributes.page.mobile) === true;
};

export const resolveStatusSectionEntry = (
  contributes: Pick<OpenChamberContributes, 'panel' | 'statusSection'>,
): string | null => {
  const section = contributes.statusSection;
  if (!section) return null;
  return section === true ? contributes.panel.entry ?? null : section.entry ?? null;
};

export const resolveStatusSectionSource = (
  contributes: Pick<OpenChamberContributes, 'statusSection'>,
): Required<StatusSectionSource> | null => {
  const section = contributes.statusSection;
  if (!section || section === true || !section.source) return null;
  return { path: section.source.path, interval: section.source.interval ?? GUEST_STATUS_SOURCE_INTERVAL_DEFAULT };
};

export const clampStatusSectionHeight = (height: number): number => {
  if (!Number.isFinite(height)) return GUEST_STATUS_SECTION_HEIGHT_DEFAULT;
  return Math.min(GUEST_STATUS_SECTION_HEIGHT_MAX, Math.max(GUEST_STATUS_SECTION_HEIGHT_MIN, Math.round(height)));
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
  | 'invalid-panel'
  | 'invalid-panel-id'
  | 'invalid-panel-name'
  | 'invalid-panel-icon'
  | 'invalid-panel-entry'
  | 'invalid-background'
  | 'invalid-attach'
  | 'invalid-page'
  | 'invalid-status-section'
  | 'invalid-session-events'
  | 'invalid-session-control'
  | 'invalid-instructions'
  | 'invalid-marks'
  | 'invalid-skills'
  | 'invalid-opencode-plugin'
  | 'invalid-mentions'
  | 'invalid-blocks'
  | 'invalid-links'
  | 'invalid-waits'
  | 'invalid-capabilities'
  | 'invalid-integration'
  | 'invalid-service'
  | 'invalid-filesystem'
  | 'invalid-origins'
  | 'invalid-actions'
  | 'invalid-commands'
  | 'invalid-tools'
  | 'invalid-provider-logos'
  | 'invalid-file-editors';

export type ParseManifestFailure = {
  ok: false;
  code: ParseManifestErrorCode;
  message: string;
};

export type ParseManifestSuccess = {
  ok: true;
  manifest: OpenChamberManifest;
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

export const isGuestPackageSvgIcon = (value: string): boolean => (
  isSafeAssetPath(value) && value.toLowerCase().endsWith('.svg')
);

export const isGuestProviderLogoPath = (value: string): boolean => (
  isSafeAssetPath(value) && /\.(?:svg|png)$/i.test(value)
);

export const toPublicIntegration = (integration: IntegrationContribution): PublicIntegration => {
  const auth = resolveIntegrationAuth(integration) ?? 'oauth';
  const next: PublicIntegration = {
    name: integration.name,
    description: integration.description,
    auth,
  };
  const api = resolveIntegrationApi(integration);
  if (api?.apiOrigin) {
    next.apiOrigin = api.apiOrigin;
  }
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
      ...(field.secret ? { secret: true as const } : {}),
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
  if (service.provides && service.provides.length > 0) {
    next.provides = [...service.provides];
  }
  if (service.surface) {
    next.surface = true;
  }
  if (service.keepRunning) {
    next.keepRunning = true;
  }
  if (service.schedule) {
    next.schedule = service.schedule.map((entry) => ({ ...entry }));
  }
  return next;
};
