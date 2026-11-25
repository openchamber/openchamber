
export const BROWSER_PROVIDER_PATH = '/browser-control';

export const BROWSER_CONTROL_ACTIONS = [
  'browser.open',
  'browser.snapshot',
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.scroll',
  'browser.back',
  'browser.forward',
  'browser.inspect',
  'browser.capture',
  'browser.resize',
  'browser.close',
] as const;
export type BrowserControlAction = (typeof BROWSER_CONTROL_ACTIONS)[number];

export const BROWSER_VIEWPORT_MODES = ['mobile', 'tablet', 'desktop', 'fill'] as const;
export type BrowserViewportMode = (typeof BROWSER_VIEWPORT_MODES)[number];

export const BROWSER_SCROLL_DIRECTIONS = ['up', 'down', 'top', 'bottom'] as const;
export type BrowserScrollDirection = (typeof BROWSER_SCROLL_DIRECTIONS)[number];

export const BROWSER_PROVIDER_OPEN_TIMEOUT_MS = 45_000;
export const BROWSER_PROVIDER_ACTION_TIMEOUT_MS = 20_000;
export const BROWSER_PROVIDER_RESPONSE_MAX = 12_000_000;
export const BROWSER_PROVIDER_IDLE_MS = 10 * 60_000;

export type BrowserTabTarget = { tabId?: string };

export type BrowserOpenParameters = BrowserTabTarget & { url: string; viewport?: BrowserViewportMode };
export type BrowserSnapshotParameters = BrowserTabTarget & { selector?: string };
export type BrowserClickParameters = BrowserTabTarget & { selector?: string; text?: string };
export type BrowserTypeParameters = BrowserTabTarget & { selector: string; value: string; submit: boolean };
export type BrowserSelectParameters = BrowserTabTarget & {
  selector: string;
} & ({ label: string; value?: never } | { value: string; label?: never });
export type BrowserScrollParameters = BrowserTabTarget & { selector?: string; direction?: BrowserScrollDirection };
export type BrowserInspectParameters = BrowserTabTarget & { selector: string };
export type BrowserCaptureParameters = BrowserTabTarget & { label?: string };
export type BrowserResizeParameters = BrowserTabTarget & { viewport: BrowserViewportMode };
export type BrowserCloseParameters = BrowserTabTarget;

export type BrowserProviderContext = { directory: string | null; sessionId: string | null };

type ProviderRequestEnvelope = { requestId: string; context: BrowserProviderContext };

export type BrowserProviderRequest = ProviderRequestEnvelope & (
  | { action: 'browser.open'; parameters: BrowserOpenParameters }
  | { action: 'browser.snapshot'; parameters: BrowserSnapshotParameters }
  | { action: 'browser.click'; parameters: BrowserClickParameters }
  | { action: 'browser.type'; parameters: BrowserTypeParameters }
  | { action: 'browser.select'; parameters: BrowserSelectParameters }
  | { action: 'browser.scroll'; parameters: BrowserScrollParameters }
  | { action: 'browser.back'; parameters: BrowserTabTarget }
  | { action: 'browser.forward'; parameters: BrowserTabTarget }
  | { action: 'browser.inspect'; parameters: BrowserInspectParameters }
  | { action: 'browser.capture'; parameters: BrowserCaptureParameters }
  | { action: 'browser.resize'; parameters: BrowserResizeParameters }
  | { action: 'browser.close'; parameters: BrowserCloseParameters }
);

export type BrowserViewportSummary = {
  mode: BrowserViewportMode | 'custom';
  width: number | null;
  height: number | null;
};

export type BrowserElementBounds = { x: number; y: number; width: number; height: number };

export type BrowserSnapshotOption = {
  label: string;
  value: string;
  selected: boolean;
  disabled: boolean;
};

export type BrowserSnapshotElement = {
  selector: string;
  tag: string;
  bounds: BrowserElementBounds;
  inViewport?: true;
  type?: string;
  role?: string;
  label?: string;
  disabled?: true;
  options?: BrowserSnapshotOption[];
  optionsTruncated?: boolean;
  multiple?: boolean;
  missingAccessibleName?: true;
};

export type BrowserOpenData = {
  tabId?: string;
  url: string;
  title: string;
  opened: true;
  settled: boolean;
  viewport: BrowserViewportSummary;
};

export type BrowserSnapshotData = {
  url: string;
  title: string;
  scope: string;
  scrollY: number;
  maxScrollY: number;
  text: string;
  elements: BrowserSnapshotElement[];
  textTruncated?: true;
  textTotalChars?: number;
  elementsTruncated?: true;
  interactiveElementsOnPage?: number;
  viewport: BrowserViewportSummary;
  consoleProblems?: BrowserConsoleProblem[];
  tabs?: BrowserTab[];
};

export type BrowserTab = { id: string; title: string; url: string; active: boolean };

export type BrowserConsoleProblem = {
  level: 'warning' | 'error';
  message: string;
  source: string;
};

export type BrowserClickData = { clicked: string; label: string; url: string };
export type BrowserTypeData = { selector: string; url: string };
export type BrowserSelectData = { selector: string; label: string; value: string; url: string };
export type BrowserScrollData = {
  scrollY: number;
  maxScrollY: number;
  atTop: boolean;
  atBottom: boolean;
  scrolledTo?: string;
  direction?: BrowserScrollDirection;
};
export type BrowserNavigationData = { url: string; title: string };
export type BrowserInspectData = {
  selector: string;
  tag: string;
  label: string;
  bounds: BrowserElementBounds;
  inViewport: boolean;
  styles: Record<string, string>;
};
export type BrowserCaptureData = {
  base64: string;
  mime: string;
  width: number;
  height: number;
  url: string;
  title: string;
  viewport: BrowserViewportSummary;
};
export type BrowserResizeData = { viewport: BrowserViewportSummary };
export type BrowserCloseData = { closed: true; tabId?: string };

export type BrowserProviderData =
  | BrowserOpenData
  | BrowserSnapshotData
  | BrowserClickData
  | BrowserTypeData
  | BrowserSelectData
  | BrowserScrollData
  | BrowserNavigationData
  | BrowserInspectData
  | BrowserCaptureData
  | BrowserResizeData
  | BrowserCloseData;

export type BrowserProviderResult =
  | { ok: true; data: BrowserProviderData }
  | { ok: false; error: string };

const CONTROL_ACTIONS: ReadonlySet<string> = new Set(BROWSER_CONTROL_ACTIONS);

export const isBrowserControlAction = (value: string): value is BrowserControlAction => CONTROL_ACTIONS.has(value);

type WireContext = { directory?: unknown; sessionId?: unknown };
type WireRequest = { requestId?: unknown; action?: unknown; parameters?: unknown; context?: WireContext };

const readContext = (wire: WireContext | undefined): BrowserProviderContext => {
  const directory = wire?.directory;
  const sessionId = wire?.sessionId;
  return {
    directory: String(directory) === directory && directory.length > 0 ? directory : null,
    sessionId: String(sessionId) === sessionId && sessionId.length > 0 ? sessionId : null,
  };
};

export const readBrowserProviderRequest = (body: string): BrowserProviderRequest | null => {
  let wire: WireRequest;
  try {
    const parsed: WireRequest | null = JSON.parse(body);
    if (Object(parsed) !== parsed || parsed === null) return null;
    wire = parsed;
  } catch {
    return null;
  }
  const { requestId, action, parameters, context } = wire;
  if (String(requestId) !== requestId || requestId.length === 0) return null;
  if (String(action) !== action || !isBrowserControlAction(action)) return null;
  if (Object(parameters) !== parameters) return null;
  // SAFETY: requestId, action, and the parameters object were checked above,
  // and the host validated the parameters for this action before posting.
  return { requestId, action, parameters, context: readContext(context) } as BrowserProviderRequest;
};


export const SOURCE_CONTROL_PROVIDER_PATH = '/source-control';
export const SOURCE_CONTROL_PROVIDER_WIRE_VERSION = 1;

export const SOURCE_CONTROL_PROVIDER_METHODS = [
  'auth.verify',
  'auth.probe',
  'auth.status',
  'changeRequestStatus',
  'listChangeRequests',
  'changeRequestContext',
  'listIssues',
  'getIssue',
  'issueComments',
  'projectUpstream',
  'projectBranches',
  'listLabels',
  'listReviewerCandidates',
  'readChangeRequestPatch',
  'readChangeRequestFile',
  'liveSummaries',
  'readChangeRequestHead',
  'resolveChangeRequestSource',
  'mutation.resolveTarget',
  'mutation.perform',
  'mutation.reconcile',
] as const;
export type SourceControlProviderMethod = (typeof SOURCE_CONTROL_PROVIDER_METHODS)[number];
export type SourceControlMutationMethod = Extract<SourceControlProviderMethod, `mutation.${string}`>;
export type SourceControlResourceMethod = Exclude<SourceControlProviderMethod, `auth.${string}` | SourceControlMutationMethod>;

export const SOURCE_CONTROL_PROVIDER_STATUS_TIMEOUT_MS = 12_000;
export const SOURCE_CONTROL_PROVIDER_READ_TIMEOUT_MS = 20_000;
export const SOURCE_CONTROL_PROVIDER_MUTATION_TIMEOUT_MS = 30_000;
export const SOURCE_CONTROL_PROVIDER_AUTH_TIMEOUT_MS = 15_000;
export const SOURCE_CONTROL_PROVIDER_RESPONSE_MAX = 8_000_000;
export const SOURCE_CONTROL_PROVIDER_ERROR_MESSAGE_MAX = 2_000;
export const SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60_000;
export const SOURCE_CONTROL_PROVIDER_TARGET_MAX = 4_096;

export const sourceControlProviderTimeoutMs = (method: SourceControlProviderMethod): number => {
  if (method === 'changeRequestStatus') return SOURCE_CONTROL_PROVIDER_STATUS_TIMEOUT_MS;
  if (method === 'auth.verify' || method === 'auth.probe' || method === 'auth.status') return SOURCE_CONTROL_PROVIDER_AUTH_TIMEOUT_MS;
  if (method.startsWith('mutation.')) return SOURCE_CONTROL_PROVIDER_MUTATION_TIMEOUT_MS;
  return SOURCE_CONTROL_PROVIDER_READ_TIMEOUT_MS;
};

export const OPENCHAMBER_HOST_CALLBACK_URL = 'OPENCHAMBER_HOST_CALLBACK_URL';
export const OPENCHAMBER_SERVICE_DATA_DIR = 'OPENCHAMBER_SERVICE_DATA_DIR';
export const SOURCE_CONTROL_OUTBOUND_PATH = '/source-control/outbound';
export const SOURCE_CONTROL_OUTBOUND_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type SourceControlOutboundMethod = (typeof SOURCE_CONTROL_OUTBOUND_METHODS)[number];
export const SOURCE_CONTROL_OUTBOUND_REQUEST_HEADERS = ['accept', 'content-type', 'if-none-match', 'range'] as const;
export const SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADERS = ['content-type', 'link', 'etag', 'x-total-count', 'x-total', 'retry-after'] as const;
export const SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADER_PREFIX = 'x-ratelimit-';
export const SOURCE_CONTROL_OUTBOUND_BODY_MAX = 1_000_000;
export const SOURCE_CONTROL_OUTBOUND_RESPONSE_MAX = 8_000_000;
export const SOURCE_CONTROL_OUTBOUND_TIMEOUT_MS = 20_000;

export type SourceControlJson = null | boolean | number | string | SourceControlJson[] | { [key: string]: SourceControlJson };
export type SourceControlJsonObject = { [key: string]: SourceControlJson };

export type SourceControlProviderUser = { id: number | string; login: string };

export type SourceControlProviderSession = {
  instance: string;
  handle: string;
  user: SourceControlProviderUser | null;
};

export type SourceControlProviderRequest = {
  v: typeof SOURCE_CONTROL_PROVIDER_WIRE_VERSION;
  requestId: string;
  method: SourceControlProviderMethod;
  provider: string;
  session: SourceControlProviderSession | null;
  input: SourceControlJsonObject;
};

export type SourceControlProjectSelector = { owner: string; name: string };
export type SourceControlProjectRef = { id: string; owner: string; name: string };

type ReadInput = { context: SourceControlJsonObject; directory: string; remote: string };
type ListInput = ReadInput & { page: number; query?: string; state: string; people: string };
type RevisionInput = { revision?: string };

export type SourceControlMutationTarget = {
  repositoryId: string;
  bindingRevision: number;
  primaryRemote: string;
  project: SourceControlProjectRef;
  number?: number;
  head?: string;
  base?: string; headSha?: string;
};

export type SourceControlMutationResolution = { providerTarget: SourceControlJsonObject; target: SourceControlMutationTarget };

type MutationStepInput = {
  route: string;
  kind: string;
  input: SourceControlJsonObject;
  resolved: SourceControlMutationResolution;
};

export type SourceControlProviderInputs = {
  'auth.verify': Record<string, never>;
  'auth.probe': Record<string, never>;
  'auth.status': Record<string, never>;
  changeRequestStatus: ReadInput & { branch: string; force: boolean };
  listChangeRequests: ListInput;
  changeRequestContext: ReadInput & RevisionInput & {
    number: number; project?: SourceControlProjectSelector; includeDiff: boolean; includeCIDetails: boolean; includeTimeline: boolean; includeReferences?: boolean;
  };
  listIssues: ListInput;
  getIssue: ReadInput & { number: number; project?: SourceControlProjectSelector; includeReferences?: boolean };
  issueComments: ReadInput & { number: number; project?: SourceControlProjectSelector };
  projectUpstream: ReadInput;
  projectBranches: ReadInput & { project: SourceControlProjectSelector };
  listLabels: ReadInput & { project: SourceControlProjectSelector };
  listReviewerCandidates: ReadInput & { project: SourceControlProjectSelector; role?: 'assignee' | 'reviewer' };
  readChangeRequestPatch: ReadInput & RevisionInput & { number: number; sourceRepo?: { owner: string; repo: string } };
  readChangeRequestFile: ReadInput & RevisionInput & {
    number: number; sourceRepo?: { owner: string; repo: string }; path: string; previousPath?: string; status?: string;
  };
  liveSummaries: {
    refs: Array<{ owner: string; repo: string; number: number }>;
    issueRefs: Array<{ owner: string; repo: string; number: number }>;
  };
  readChangeRequestHead: ReadInput & { number: number };
  resolveChangeRequestSource: ReadInput & { project: SourceControlProjectRef; number: number; expectedHeadSha: string };
  'mutation.resolveTarget': { context: SourceControlJsonObject; kind: string; input: SourceControlJsonObject; replayOf?: SourceControlJsonObject };
  'mutation.perform': MutationStepInput;
  'mutation.reconcile': MutationStepInput;
};

export type { SourceControlChangeRequestContext, SourceControlReviewerState } from './source-control-reviewers.ts';

export type SourceControlNumericForgeUser = { id: number; login: string; name?: string; email?: string; avatarUrl?: string };
export type SourceControlStringForgeUser = { id: string; login: string; name?: string; email?: string; avatarUrl?: string };
export type SourceControlForgeUser = SourceControlNumericForgeUser | SourceControlStringForgeUser;
export type SourceControlVerifyData = { user: SourceControlForgeUser };
export type SourceControlStatusData = { user: SourceControlForgeUser | null };
export type SourceControlProbeData = { supported: boolean; version?: string; message?: string };
export type SourceControlChangeRequestHead = { project: SourceControlProjectRef; headSha: string; headBranch: string; headOwner: string };
export type SourceControlChangeRequestSource = {
  sourceProject: SourceControlProjectRef;
  targetProject: SourceControlProjectRef;
  classification: 'same-repository' | 'contributor-fork';
  headSha: string;
  headRef: string;
  endpoint: string;
};
export type SourceControlMutationResult = {
  project?: SourceControlProjectRef;
  number?: number;
  head?: string;
  base?: string;
  headSha?: string;
  state?: string;
  merged?: boolean;
  outcome?: 'queued' | 'merging';
  stacked?: boolean;
  ready?: boolean;
  draft?: boolean;
  commented?: boolean;
  failureStatus?: number; failureCode?: string;
};
export type SourceControlReconcileData = {
  state: 'succeeded' | 'failed' | 'outcome-unknown';
  result?: SourceControlMutationResult;
};

export type SourceControlProviderError = { message: string; status?: number; code?: string };
export type SourceControlProviderResult =
  | { ok: true; data: SourceControlJson }
  | { ok: false; error: SourceControlProviderError };

export const isSourceControlProviderMethod = (value: string): value is SourceControlProviderMethod => (
  SOURCE_CONTROL_PROVIDER_METHODS.some((method) => method === value)
);

type WireSourceControlUser = { id?: unknown; login?: unknown };
type WireSourceControlSession = { instance?: unknown; handle?: unknown; user?: WireSourceControlUser | null };
type WireSourceControlRequest = {
  v?: unknown; requestId?: unknown; method?: unknown; provider?: unknown; session?: WireSourceControlSession | null; input?: unknown;
};

const readSessionUser = (user: WireSourceControlUser | null | undefined): SourceControlProviderUser | null | undefined => {
  if (user === null) return null;
  if (Object(user) !== user || user === undefined) return undefined;
  const { id, login } = user;
  const isPositiveSafeIntegerId = typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
  const isBoundedStringId = typeof id === 'string' && id.length > 0 && id.length <= 256;
  const validId = isPositiveSafeIntegerId || isBoundedStringId;
  if (!validId || String(login) !== login || login.length === 0) return undefined;
  return { id, login };
};

const readSession = (session: WireSourceControlSession | null | undefined): SourceControlProviderSession | null | undefined => {
  if (session === null) return null;
  if (Object(session) !== session || session === undefined) return undefined;
  const { instance, handle } = session;
  if (String(instance) !== instance || instance.length === 0 || String(handle) !== handle || handle.length === 0) return undefined;
  const user = readSessionUser(session.user);
  if (user === undefined) return undefined;
  return { instance, handle, user };
};

export const readSourceControlProviderRequest = (body: string): SourceControlProviderRequest | null => {
  let wire: WireSourceControlRequest;
  try {
    const parsed: WireSourceControlRequest | null = JSON.parse(body);
    if (Object(parsed) !== parsed || parsed === null) return null;
    wire = parsed;
  } catch {
    return null;
  }
  const { v, requestId, method, provider, input } = wire;
  if (v !== SOURCE_CONTROL_PROVIDER_WIRE_VERSION) return null;
  if (String(requestId) !== requestId || requestId.length === 0) return null;
  if (String(provider) !== provider || provider.length === 0) return null;
  if (String(method) !== method || !isSourceControlProviderMethod(method)) return null;
  if (Object(input) !== input || Array.isArray(input)) return null;
  const session = readSession(wire.session);
  if (session === undefined) return null;
  // SAFETY: `input` is a plain object parsed from JSON, so every value in it is JSON.
  return { v: SOURCE_CONTROL_PROVIDER_WIRE_VERSION, requestId, method, provider, session, input: input as SourceControlJsonObject };
};

export type SourceControlOutboundRequest = {
  method: SourceControlOutboundMethod;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
};

export type SourceControlOutboundResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export class SourceControlForgeError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'SourceControlForgeError';
    this.code = code;
    this.status = status;
  }
}

export type SourceControlForge = {
  request(handle: string, request: SourceControlOutboundRequest): Promise<SourceControlOutboundResponse>;
};

type OutboundAnswer = {
  status?: unknown; headers?: unknown; body?: unknown; error?: { message?: unknown; code?: unknown };
};

type OutboundFailure = (message: string, code: string, status: number) => Error;

const postOutbound = async (
  url: string,
  handle: string,
  request: SourceControlOutboundRequest,
  timeoutMs: number,
  fail: OutboundFailure,
): Promise<SourceControlOutboundResponse> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });
  } catch (error) {
    throw fail(`OpenChamber did not answer: ${error instanceof Error ? error.message : String(error)}`, 'HOST_UNAVAILABLE', 0);
  }
  let answer: OutboundAnswer;
  try {
    answer = Object(await response.json());
  } catch {
    throw fail('OpenChamber answered with something other than JSON', 'HOST_UNAVAILABLE', response.status);
  }
  if (!response.ok) {
    const message = answer.error?.message;
    const code = answer.error?.code;
    throw fail(
      String(message) === message && message.length > 0 ? message : `OpenChamber refused the request (${response.status})`,
      String(code) === code && code.length > 0 ? code : 'OUTBOUND_REFUSED',
      response.status,
    );
  }
  if (!Number.isSafeInteger(answer.status) || String(answer.body) !== answer.body) {
    throw fail('OpenChamber relayed a malformed answer', 'HOST_UNAVAILABLE', response.status);
  }
  const headers: SourceControlOutboundResponse['headers'] = {};
  for (const [name, text] of Object.entries(Object(answer.headers ?? {}))) {
    if (String(text) === text) headers[name] = text;
  }
  return { status: Number(answer.status), headers, body: answer.body };
};

export const createSourceControlForge = ({ env }: { env: Record<string, string | undefined> }): SourceControlForge => {
  const base = env[OPENCHAMBER_HOST_CALLBACK_URL];
  if (!base) throw new Error(`${OPENCHAMBER_HOST_CALLBACK_URL} is not set: only a service that provides "source-control" can reach a forge.`);
  const url = `${base.replace(/\/+$/, '')}${SOURCE_CONTROL_OUTBOUND_PATH}`;
  return {
    request: (handle, request) => postOutbound(url, handle, request, SOURCE_CONTROL_OUTBOUND_TIMEOUT_MS,
      (message, code, status) => new SourceControlForgeError(message, code, status)),
  };
};


export const NOTIFICATIONS_PROVIDER_PATH = '/notifications';
export const NOTIFICATIONS_PROVIDER_WIRE_VERSION = 1;
export const NOTIFICATIONS_PROVIDER_METHODS = ['auth.verify', 'auth.probe', 'notify'] as const;
export type NotificationsProviderMethod = (typeof NOTIFICATIONS_PROVIDER_METHODS)[number];

export const NOTIFICATIONS_PROVIDER_NOTIFY_TIMEOUT_MS = 10_000;
export const NOTIFICATIONS_PROVIDER_AUTH_TIMEOUT_MS = 15_000;
export const NOTIFICATIONS_PROVIDER_RESPONSE_MAX = 16_000;
export const NOTIFICATIONS_PROVIDER_ERROR_MESSAGE_MAX = 2_000;
export const NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60_000;
export const NOTIFICATIONS_OUTBOUND_PATH = '/notifications/outbound';
export const NOTIFICATIONS_OUTBOUND_TIMEOUT_MS = 20_000;

export const notificationsProviderTimeoutMs = (method: NotificationsProviderMethod): number => (
  method === 'notify' ? NOTIFICATIONS_PROVIDER_NOTIFY_TIMEOUT_MS : NOTIFICATIONS_PROVIDER_AUTH_TIMEOUT_MS
);

export const GUEST_NOTIFICATION_KINDS = ['ready', 'error', 'question', 'permission', 'review', 'goal_complete', 'goal_blocked', 'goal_budget', 'pull-request'] as const;
export type GuestNotificationKind = (typeof GUEST_NOTIFICATION_KINDS)[number];

export type GuestNotification = {
  kind: GuestNotificationKind;
  title: string;
  body: string;
  tag: string;
  at: number;
  sessionId: string | null;
  sessionName: string | null;
  directory: string | null;
  url: string | null;
};

export type NotificationsProviderAccount = { id: string; login: string | null };

export type NotificationsProviderSession = {
  instance: string;
  handle: string;
  account: NotificationsProviderAccount | null;
};

export type NotificationsProviderInputs = {
  'auth.verify': Record<string, never>;
  'auth.probe': Record<string, never>;
  notify: { notification: GuestNotification };
};

export type NotificationsProviderRequest = {
  v: typeof NOTIFICATIONS_PROVIDER_WIRE_VERSION;
  requestId: string;
  method: NotificationsProviderMethod;
  provider: string;
  session: NotificationsProviderSession;
  input: SourceControlJsonObject;
};

export type NotificationsAccountData = { account: { id: string; login: string; name?: string } };
export type NotificationsProbeData = { supported: boolean; message?: string };
export type NotificationsNotifyData = { delivered: true };

export type NotificationsProviderError = SourceControlProviderError;
export type NotificationsProviderResult =
  | { ok: true; data: SourceControlJson }
  | { ok: false; error: NotificationsProviderError };

export const isNotificationsProviderMethod = (value: string): value is NotificationsProviderMethod => (
  NOTIFICATIONS_PROVIDER_METHODS.some((method) => method === value)
);

type WireNotificationsAccount = { id?: unknown; login?: unknown };
type WireNotificationsSession = { instance?: unknown; handle?: unknown; account?: WireNotificationsAccount | null };
type WireNotificationsRequest = {
  v?: unknown; requestId?: unknown; method?: unknown; provider?: unknown; session?: WireNotificationsSession | null; input?: unknown;
};

const readNotificationsAccount = (account: WireNotificationsAccount | null | undefined): NotificationsProviderAccount | null | undefined => {
  if (account === null) return null;
  if (Object(account) !== account || account === undefined) return undefined;
  const { id, login } = account;
  if (String(id) !== id || id.length === 0) return undefined;
  if (login !== null && (String(login) !== login || login.length === 0)) return undefined;
  return { id, login };
};

export const readNotificationsProviderRequest = (body: string): NotificationsProviderRequest | null => {
  let wire: WireNotificationsRequest;
  try {
    const parsed: WireNotificationsRequest | null = JSON.parse(body);
    if (Object(parsed) !== parsed || parsed === null) return null;
    wire = parsed;
  } catch {
    return null;
  }
  const { v, requestId, method, provider, session, input } = wire;
  if (v !== NOTIFICATIONS_PROVIDER_WIRE_VERSION) return null;
  if (String(requestId) !== requestId || requestId.length === 0) return null;
  if (String(provider) !== provider || provider.length === 0) return null;
  if (String(method) !== method || !isNotificationsProviderMethod(method)) return null;
  if (Object(input) !== input || Array.isArray(input)) return null;
  if (Object(session) !== session || session === null || session === undefined) return null;
  const { instance, handle } = session;
  if (String(instance) !== instance || instance.length === 0 || String(handle) !== handle || handle.length === 0) return null;
  const account = readNotificationsAccount(session.account);
  if (account === undefined) return null;
  // SAFETY: `input` is a plain object parsed from JSON, so every value in it is JSON.
  return { v: NOTIFICATIONS_PROVIDER_WIRE_VERSION, requestId, method, provider, session: { instance, handle, account }, input: input as SourceControlJsonObject };
};

export class NotificationsOutboundError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'NotificationsOutboundError';
    this.code = code;
    this.status = status;
  }
}

export type NotificationsOutbound = {
  request(handle: string, request: SourceControlOutboundRequest): Promise<SourceControlOutboundResponse>;
};

export const createNotificationsOutbound = ({ env }: { env: Record<string, string | undefined> }): NotificationsOutbound => {
  const base = env[OPENCHAMBER_HOST_CALLBACK_URL];
  if (!base) throw new Error(`${OPENCHAMBER_HOST_CALLBACK_URL} is not set: only a service that provides "notifications" can reach a channel's server.`);
  const url = `${base.replace(/\/+$/, '')}${NOTIFICATIONS_OUTBOUND_PATH}`;
  return {
    request: (handle, request) => postOutbound(url, handle, request, NOTIFICATIONS_OUTBOUND_TIMEOUT_MS,
      (message, code, status) => new NotificationsOutboundError(message, code, status)),
  };
};


export const TRACKER_PROVIDER_PATH = '/tracker';
export const TRACKER_PROVIDER_WIRE_VERSION = 1;

export const TRACKER_PROVIDER_METHODS = [
  'auth.probe',
  'auth.verify',
  'items.list',
  'items.get',
  'items.updateState',
  'items.liveSummaries',
  'states.list',
  'containers.list',
  'comments.create',
] as const;
export type TrackerProviderMethod = (typeof TRACKER_PROVIDER_METHODS)[number];
export const TRACKER_PROVIDER_WRITE_METHODS = ['items.updateState', 'comments.create'] as const satisfies readonly TrackerProviderMethod[];

export const TRACKER_PROVIDER_AUTH_TIMEOUT_MS = 15_000;
export const TRACKER_PROVIDER_READ_TIMEOUT_MS = 20_000;
export const TRACKER_PROVIDER_WRITE_TIMEOUT_MS = 30_000;
export const TRACKER_PROVIDER_RESPONSE_MAX = 2_000_000;
export const TRACKER_PROVIDER_ERROR_MESSAGE_MAX = 2_000;
export const TRACKER_PROVIDER_IDLE_MS = 10 * 60_000;
export const TRACKER_PROVIDER_LIST_MAX = 100;
export const TRACKER_PROVIDER_LIVE_SUMMARIES_MAX = 50;
export const TRACKER_PROVIDER_CONTAINERS_MAX = 500;
export const TRACKER_OUTBOUND_PATH = '/tracker/outbound';
export const TRACKER_OUTBOUND_TIMEOUT_MS = 20_000;

export const isTrackerProviderWriteMethod = (method: TrackerProviderMethod): boolean => (
  TRACKER_PROVIDER_WRITE_METHODS.some((write) => write === method)
);

export const trackerProviderTimeoutMs = (method: TrackerProviderMethod): number => {
  if (method === 'auth.probe' || method === 'auth.verify') return TRACKER_PROVIDER_AUTH_TIMEOUT_MS;
  if (isTrackerProviderWriteMethod(method)) return TRACKER_PROVIDER_WRITE_TIMEOUT_MS;
  return TRACKER_PROVIDER_READ_TIMEOUT_MS;
};


export type TrackerProviderStateCategory = 'triage' | 'backlog' | 'todo' | 'in-progress' | 'done' | 'canceled';
export type TrackerProviderPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low';
export type TrackerProviderPerson = { name: string | null; avatarUrl: string | null };
export type TrackerProviderItemState = { id: string | null; name: string; category: TrackerProviderStateCategory | null };
export type TrackerProviderContainer = { id: string; key: string | null; name: string };
export type TrackerProviderLabel = { id: string; name: string; color: string | null };
export type TrackerProviderProgress = { total: number; done: number; more: boolean };

export type TrackerProviderItemSummary = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: TrackerProviderItemState | null;
  priority?: TrackerProviderPriority | null;
  labels?: TrackerProviderLabel[];
  assignee?: TrackerProviderPerson | null;
  container?: TrackerProviderContainer | null;
  parent?: TrackerProviderItemSummary | null;
  progress?: TrackerProviderProgress | null;
  updatedAt?: string | null;
};

export type TrackerProviderComment = { id: string; body: string; createdAt: string | null; author: TrackerProviderPerson | null };

export type TrackerProviderItem = TrackerProviderItemSummary & {
  description?: string | null;
  comments?: TrackerProviderComment[];
  children?: TrackerProviderItemSummary[];
  childrenMore?: boolean;
};

export type TrackerProviderWorkflowState = { id: string; name: string; category: TrackerProviderStateCategory | null; position: number };
export type TrackerProviderLiveSummary = { identifier: string; title: string; state: { name: string; category: TrackerProviderStateCategory } };

export type TrackerProviderAccount = { id: string; login: string | null };

export type TrackerProviderSession = {
  instance: string;
  handle: string;
  account: TrackerProviderAccount | null;
};

export type TrackerProviderInputs = {
  'auth.probe': Record<string, never>;
  'auth.verify': Record<string, never>;
  'items.list': {
    query?: string;
    cursor?: string;
    state: string;
    people: 'any' | 'me' | 'created';
    priority: 'all' | TrackerProviderPriority;
    containerId: string | null;
  };
  'items.get': { id: string };
  'items.updateState': { id: string; stateId: string };
  'items.liveSummaries': { identifiers: string[] };
  'states.list': { containerId: string };
  'containers.list': Record<string, never>;
  'comments.create': { identifier: string; body: string };
};

export type TrackerProviderRequest = {
  v: typeof TRACKER_PROVIDER_WIRE_VERSION;
  requestId: string;
  method: TrackerProviderMethod;
  provider: string;
  session: TrackerProviderSession;
  input: SourceControlJsonObject;
};

export type TrackerProviderAccountData = { account: { id: string; login: string | null; name?: string; avatarUrl?: string } };
export type TrackerProviderProbeData = { supported: boolean; message?: string };
export type TrackerProviderListData = { items: TrackerProviderItemSummary[]; cursor: string | null; hasMore: boolean };
export type TrackerProviderItemData = { item: TrackerProviderItem | null };
export type TrackerProviderStatesData = { states: TrackerProviderWorkflowState[] };
export type TrackerProviderLiveSummariesData = { items: TrackerProviderLiveSummary[] };
export type TrackerProviderContainersData = { containers: TrackerProviderContainer[] };
export type TrackerProviderCommentData = { comment: { id: string } | null };

export type TrackerProviderDataByMethod = {
  'auth.probe': TrackerProviderProbeData;
  'auth.verify': TrackerProviderAccountData;
  'items.list': TrackerProviderListData;
  'items.get': TrackerProviderItemData;
  'items.updateState': TrackerProviderItemData;
  'items.liveSummaries': TrackerProviderLiveSummariesData;
  'states.list': TrackerProviderStatesData;
  'containers.list': TrackerProviderContainersData;
  'comments.create': TrackerProviderCommentData;
};

export type TrackerProviderError = SourceControlProviderError;
export type TrackerProviderResult =
  | { ok: true; data: SourceControlJson }
  | { ok: false; error: TrackerProviderError };

export const isTrackerProviderMethod = (value: string): value is TrackerProviderMethod => (
  TRACKER_PROVIDER_METHODS.some((method) => method === value)
);

type WireTrackerRequest = {
  v?: unknown; requestId?: unknown; method?: unknown; provider?: unknown; session?: WireNotificationsSession | null; input?: unknown;
};

export const readTrackerProviderRequest = (body: string): TrackerProviderRequest | null => {
  let wire: WireTrackerRequest;
  try {
    const parsed: WireTrackerRequest | null = JSON.parse(body);
    if (Object(parsed) !== parsed || parsed === null) return null;
    wire = parsed;
  } catch {
    return null;
  }
  const { v, requestId, method, provider, session, input } = wire;
  if (v !== TRACKER_PROVIDER_WIRE_VERSION) return null;
  if (String(requestId) !== requestId || requestId.length === 0) return null;
  if (String(provider) !== provider || provider.length === 0) return null;
  if (String(method) !== method || !isTrackerProviderMethod(method)) return null;
  if (Object(input) !== input || Array.isArray(input)) return null;
  if (Object(session) !== session || session === null || session === undefined) return null;
  const { instance, handle } = session;
  if (String(instance) !== instance || instance.length === 0 || String(handle) !== handle || handle.length === 0) return null;
  const account = readNotificationsAccount(session.account);
  if (account === undefined) return null;
  // SAFETY: `input` is a plain object parsed from JSON, so every value in it is JSON.
  return { v: TRACKER_PROVIDER_WIRE_VERSION, requestId, method, provider, session: { instance, handle, account }, input: input as SourceControlJsonObject };
};

export class TrackerOutboundError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'TrackerOutboundError';
    this.code = code;
    this.status = status;
  }
}

export type TrackerOutbound = {
  request(handle: string, request: SourceControlOutboundRequest): Promise<SourceControlOutboundResponse>;
};

export const createTrackerOutbound = ({ env }: { env: Record<string, string | undefined> }): TrackerOutbound => {
  const base = env[OPENCHAMBER_HOST_CALLBACK_URL];
  if (!base) throw new Error(`${OPENCHAMBER_HOST_CALLBACK_URL} is not set: only a service that provides "tracker" can reach a tracker's server.`);
  const url = `${base.replace(/\/+$/, '')}${TRACKER_OUTBOUND_PATH}`;
  return {
    request: (handle, request) => postOutbound(url, handle, request, TRACKER_OUTBOUND_TIMEOUT_MS,
      (message, code, status) => new TrackerOutboundError(message, code, status)),
  };
};


export const QUOTA_PROVIDER_PATH = '/quota';
export const QUOTA_PROVIDER_WIRE_VERSION = 1;
export const QUOTA_PROVIDER_METHODS = ['usage.read'] as const;
export type QuotaProviderMethod = (typeof QUOTA_PROVIDER_METHODS)[number];

export const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;
export const QUOTA_PROVIDER_RESPONSE_MAX = 1_000_000;
export const QUOTA_PROVIDER_ERROR_MESSAGE_MAX = 2_000;
export const QUOTA_PROVIDER_IDLE_MS = 10 * 60_000;
export const QUOTA_PROVIDER_WINDOWS_MAX = 32;
export const QUOTA_PROVIDER_MODELS_MAX = 64;
export const QUOTA_PROVIDER_NAME_MAX = 128;
export const QUOTA_PROVIDER_LABEL_MAX = 128;

export type QuotaProviderCredential =
  | { type: 'api'; key: string; metadata?: SourceControlJsonObject }
  | { type: 'oauth'; access: string; refresh: string; expires: number; accountId?: string; enterpriseUrl?: string; server?: string; orgID?: string };

export type QuotaProviderWindowValue =
  | { kind: 'requests'; count: number }
  | { kind: 'spend'; spent: number; limit: number | null };

export type QuotaProviderWindow = {
  usedPercent: number | null;
  windowSeconds?: number | null;
  resetAt?: number | null;
  valueLabel?: string | null;
  value?: QuotaProviderWindowValue;
  creditsUsed?: number;
};

export type QuotaProviderUsage = {
  windows: Record<string, QuotaProviderWindow>;
  models?: Record<string, { windows: Record<string, QuotaProviderWindow> }>;
};

export type QuotaProviderUsageData = {
  ok: boolean;
  configured: boolean;
  error?: string;
  planLabel?: string | null;
  usage: QuotaProviderUsage | null;
};

export type QuotaProviderInputs = {
  'usage.read': { credentials: Record<string, QuotaProviderCredential> };
};

export type QuotaProviderRequest = {
  v: typeof QUOTA_PROVIDER_WIRE_VERSION;
  requestId: string;
  method: QuotaProviderMethod;
  provider: string;
  input: QuotaProviderInputs['usage.read'];
};

export type QuotaProviderDataByMethod = {
  'usage.read': QuotaProviderUsageData;
};

export type QuotaProviderError = SourceControlProviderError;
export type QuotaProviderResult =
  | { ok: true; data: QuotaProviderUsageData }
  | { ok: false; error: QuotaProviderError };

export const isQuotaProviderMethod = (value: string): value is QuotaProviderMethod => (
  QUOTA_PROVIDER_METHODS.some((method) => method === value)
);

type WireQuotaRequest = {
  v?: unknown; requestId?: unknown; method?: unknown; provider?: unknown; input?: { credentials?: unknown } | null;
};

export const readQuotaProviderRequest = (body: string): QuotaProviderRequest | null => {
  let wire: WireQuotaRequest;
  try {
    const parsed: WireQuotaRequest | null = JSON.parse(body);
    if (Object(parsed) !== parsed || parsed === null) return null;
    wire = parsed;
  } catch {
    return null;
  }
  const { v, requestId, method, provider, input } = wire;
  if (v !== QUOTA_PROVIDER_WIRE_VERSION) return null;
  if (String(requestId) !== requestId || requestId.length === 0) return null;
  if (String(provider) !== provider || provider.length === 0) return null;
  if (String(method) !== method || !isQuotaProviderMethod(method)) return null;
  if (Object(input) !== input || input === null || input === undefined || Array.isArray(input)) return null;
  const { credentials } = input;
  if (Object(credentials) !== credentials || credentials === null || Array.isArray(credentials)) return null;
  if (Object.values(Object(credentials)).some((credential) => Object(credential) !== credential || credential === null || Array.isArray(credential))) return null;
  // SAFETY: `credentials` is a plain object of plain objects parsed from JSON, built by OpenChamber from OpenCode's store.
  return { v: QUOTA_PROVIDER_WIRE_VERSION, requestId, method, provider, input: { credentials: credentials as Record<string, QuotaProviderCredential> } };
};
