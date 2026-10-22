/**
 * Contracts a service fulfils when it stands in for a host role
 * (`contributes.service.provides`).
 *
 * Browser: the host's `openchamber_web` tool sends its `browser.*` actions to
 * the service instead of the in-app browser view. The service answers with the
 * same shapes the in-app view answers with, so the agent sees one tool whoever
 * drives the page. The host starts the service on the first action, needs no
 * panel, and stops it after `BROWSER_PROVIDER_IDLE_MS` without actions.
 */

/** Route on the service loopback the host posts every action to. */
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

/** `browser.open` may wait for a slow page; every other action is quick. */
export const BROWSER_PROVIDER_OPEN_TIMEOUT_MS = 45_000;
export const BROWSER_PROVIDER_ACTION_TIMEOUT_MS = 20_000;
/** A screenshot is the largest answer; snapshots are capped by the provider itself. */
export const BROWSER_PROVIDER_RESPONSE_MAX = 12_000_000;
/** No action for this long stops the service; the next action starts it again. */
export const BROWSER_PROVIDER_IDLE_MS = 10 * 60_000;

/**
 * Which tab an action is for: an `id` from `BrowserSnapshotData.tabs`, passed
 * through from the agent untouched. Absent means the tab the user is looking
 * at. A provider answers an id it did not issue with `ok: false`, never by
 * acting on another tab; one without tabs issues none and refuses every id.
 */
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

/**
 * Where an action came from: the project the agent works in and the chat it
 * runs in. Filled by the host from the tool call, never typed by the model.
 * A provider that keeps one browser per project or chat keys on these; one
 * that keeps a single browser ignores them. Either is `null` when the host
 * had none (a call from the CLI, for example): treat that as "unknown", not
 * as a scope of its own.
 */
export type BrowserProviderContext = { directory: string | null; sessionId: string | null };

type ProviderRequestEnvelope = { requestId: string; context: BrowserProviderContext };

/** One action, as the host posts it. Parameters were validated by the host. */
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

/** One interactive element of a snapshot; absent fields mean empty or default. */
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
  /** The tab the page opened in, when the provider has tabs; the agent names it in later actions. */
  tabId?: string;
  url: string;
  title: string;
  opened: true;
  /** `false` means the page is still loading, not that opening failed. */
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
  /** Warnings and errors the page logged since it was opened; absent when none. */
  consoleProblems?: BrowserConsoleProblem[];
  /** Every open tab, so the agent can name one with `tabId`; `active` is the one the user sees. */
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
/** The host writes the image to the project and hands the agent its path. */
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
/**
 * A closed tab: what the provider or panel actually removed. `tabId` names it
 * when the provider has tabs; a provider with a single page refuses the action
 * rather than reporting a close it did not do.
 */
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

/**
 * What the service answers. `error` is read by the agent, so it should say
 * what to do differently ("No element matches #save"), not what broke inside.
 */
export type BrowserProviderResult =
  | { ok: true; data: BrowserProviderData }
  | { ok: false; error: string };

const CONTROL_ACTIONS: ReadonlySet<string> = new Set(BROWSER_CONTROL_ACTIONS);

export const isBrowserControlAction = (value: string): value is BrowserControlAction => CONTROL_ACTIONS.has(value);

type WireContext = { directory?: unknown; sessionId?: unknown };
type WireRequest = { requestId?: unknown; action?: unknown; parameters?: unknown; context?: WireContext };

/** Hosts before the context field posted none; that reads as an unknown scope. */
const readContext = (wire: WireContext | undefined): BrowserProviderContext => {
  const directory = wire?.directory;
  const sessionId = wire?.sessionId;
  return {
    directory: String(directory) === directory && directory.length > 0 ? directory : null,
    sessionId: String(sessionId) === sessionId && sessionId.length > 0 ? sessionId : null,
  };
};

/**
 * A provider's read of the body the host posted to `BROWSER_PROVIDER_PATH`.
 * The host is trusted and validated the parameters against the action before
 * sending, so this checks the envelope and the action, not every field, and
 * the service bundle needs no schema library for it. `null` is a body that is
 * not a browser action; answer it with HTTP 400.
 */
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

/*
 * Source control: a service with `provides: ["source-control"]` is the Git
 * host `contributes.sourceControl` describes. OpenChamber keeps the user's
 * accounts and tokens, the bindings, the idempotent mutation records and the
 * caches; it forwards the resource reads and the three mutation steps to the
 * service at `SOURCE_CONTROL_PROVIDER_PATH`. The service never sees a token: it
 * reaches the forge through OpenChamber's outbound proxy
 * (`createSourceControlForge`), which pins the instance origin and adds the
 * stored token itself.
 */

/** Route on the service loopback OpenChamber posts every source-control call to. */
export const SOURCE_CONTROL_PROVIDER_PATH = '/source-control';
/** The `v` of every request; a service answers a version it does not know with HTTP 400. */
export const SOURCE_CONTROL_PROVIDER_WIRE_VERSION = 1;

/**
 * Every call OpenChamber forwards. `auth.verify` reads who a candidate token
 * belongs to and `auth.probe` whether the instance is this forge; the fifteen
 * reads take the shell's own input without the session; the three
 * `mutation.*` steps are the part of a write the service owns, while
 * OpenChamber owns the kind, the normalized input, its digest, the
 * idempotency record and when each step runs.
 */
export const SOURCE_CONTROL_PROVIDER_METHODS = [
  'auth.verify',
  'auth.probe',
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

/** `changeRequestStatus` answers within the badge's own deadline; past it the last known status shows. */
export const SOURCE_CONTROL_PROVIDER_STATUS_TIMEOUT_MS = 12_000;
export const SOURCE_CONTROL_PROVIDER_READ_TIMEOUT_MS = 20_000;
export const SOURCE_CONTROL_PROVIDER_MUTATION_TIMEOUT_MS = 30_000;
export const SOURCE_CONTROL_PROVIDER_AUTH_TIMEOUT_MS = 15_000;
/** Answers are read up to this many bytes, enough for a change request's patch or one file. */
export const SOURCE_CONTROL_PROVIDER_RESPONSE_MAX = 8_000_000;
/** Characters of `error.message` OpenChamber reads. */
export const SOURCE_CONTROL_PROVIDER_ERROR_MESSAGE_MAX = 2_000;
/** No call for this long stops the service; the next call starts it again. */
export const SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60_000;
/** Characters of a mutation's `providerTarget` JSON, which OpenChamber stores with the record. */
export const SOURCE_CONTROL_PROVIDER_TARGET_MAX = 4_096;

/** How long OpenChamber waits for the service to answer `method`. */
export const sourceControlProviderTimeoutMs = (method: SourceControlProviderMethod): number => {
  if (method === 'changeRequestStatus') return SOURCE_CONTROL_PROVIDER_STATUS_TIMEOUT_MS;
  if (method === 'auth.verify' || method === 'auth.probe') return SOURCE_CONTROL_PROVIDER_AUTH_TIMEOUT_MS;
  if (method.startsWith('mutation.')) return SOURCE_CONTROL_PROVIDER_MUTATION_TIMEOUT_MS;
  return SOURCE_CONTROL_PROVIDER_READ_TIMEOUT_MS;
};

/**
 * Environment variable with the base URL of OpenChamber's callback listener
 * (`http://127.0.0.1:<port>`). Set only for a service that provides
 * `source-control`; `createSourceControlForge` reads it.
 */
export const OPENCHAMBER_HOST_CALLBACK_URL = 'OPENCHAMBER_HOST_CALLBACK_URL';
/** Route on the callback listener a service sends a forge request to. */
export const SOURCE_CONTROL_OUTBOUND_PATH = '/source-control/outbound';
export const SOURCE_CONTROL_OUTBOUND_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type SourceControlOutboundMethod = (typeof SOURCE_CONTROL_OUTBOUND_METHODS)[number];
/** Request headers OpenChamber passes to the forge; it sets every other header itself. */
export const SOURCE_CONTROL_OUTBOUND_REQUEST_HEADERS = ['accept', 'content-type', 'if-none-match', 'range'] as const;
/** Response headers OpenChamber hands back, plus any starting with `SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADER_PREFIX`. */
export const SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADERS = ['content-type', 'link', 'etag', 'x-total-count', 'x-total', 'retry-after'] as const;
export const SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADER_PREFIX = 'x-ratelimit-';
/** Characters of an outbound request body. */
export const SOURCE_CONTROL_OUTBOUND_BODY_MAX = 1_000_000;
/** Bytes of a forge answer OpenChamber reads; a longer one is refused whole. */
export const SOURCE_CONTROL_OUTBOUND_RESPONSE_MAX = 8_000_000;
/** One forge request may take this long; the call's own deadline may end it sooner. */
export const SOURCE_CONTROL_OUTBOUND_TIMEOUT_MS = 20_000;

export type SourceControlJson = null | boolean | number | string | SourceControlJson[] | { [key: string]: SourceControlJson };
export type SourceControlJsonObject = { [key: string]: SourceControlJson };

/** The forge account a call acts as; `null` in `auth.verify` and `auth.probe`, before one is known. */
export type SourceControlProviderUser = { id: number; login: string };

/**
 * Who a call is for. `instance` is the normalized origin (`https://git.example.com`).
 * `handle` is the capability for this one call: pass it to
 * `createSourceControlForge(...).request`. It stops working when the call
 * ends; never store it.
 */
export type SourceControlProviderSession = {
  instance: string;
  handle: string;
  user: SourceControlProviderUser | null;
};

/**
 * One call, as OpenChamber posts it. `provider` is the id OpenChamber gave this
 * Git host (`ext-<panel.id>`): put it in every DTO's `provider` field.
 * `input` was built and validated by OpenChamber; its shape per method is
 * `SourceControlProviderInputs`.
 */
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

/** The bound context OpenChamber validated: binding, account and the remote it reads through. */
type ReadInput = { context: SourceControlJsonObject; directory: string; remote: string };
type ListInput = ReadInput & { page: number; query?: string; state: string; people: string };

/**
 * The durable target of a mutation, exactly the keys OpenChamber stores:
 * the binding it was made under and what it acts on.
 */
export type SourceControlMutationTarget = {
  repositoryId: string;
  bindingRevision: number;
  primaryRemote: string;
  project: SourceControlProjectRef;
  number?: number;
  head?: string;
  base?: string;
  headSha?: string;
};

/** `providerTarget` is the service's own coordinates for the write (≤ `SOURCE_CONTROL_PROVIDER_TARGET_MAX` bytes of JSON). */
export type SourceControlMutationResolution = { providerTarget: SourceControlJsonObject; target: SourceControlMutationTarget };

type MutationStepInput = {
  route: string;
  kind: string;
  input: SourceControlJsonObject;
  resolved: SourceControlMutationResolution;
};

/** What each method's `input` holds. */
export type SourceControlProviderInputs = {
  'auth.verify': Record<string, never>;
  'auth.probe': Record<string, never>;
  changeRequestStatus: ReadInput & { branch: string; force: boolean };
  listChangeRequests: ListInput;
  changeRequestContext: ReadInput & {
    number: number; project?: SourceControlProjectSelector; includeDiff: boolean; includeCIDetails: boolean; includeTimeline: boolean;
  };
  listIssues: ListInput;
  getIssue: ReadInput & { number: number; project?: SourceControlProjectSelector };
  issueComments: ReadInput & { number: number; project?: SourceControlProjectSelector };
  projectUpstream: ReadInput;
  projectBranches: ReadInput & { project: SourceControlProjectSelector };
  listLabels: ReadInput & { project: SourceControlProjectSelector };
  listReviewerCandidates: ReadInput & { project: SourceControlProjectSelector };
  readChangeRequestPatch: ReadInput & { number: number; sourceRepo?: { owner: string; repo: string } };
  readChangeRequestFile: ReadInput & {
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

export type SourceControlForgeUser = { id: number; login: string; name?: string; email?: string; avatarUrl?: string };
export type SourceControlVerifyData = { user: SourceControlForgeUser };
export type SourceControlProbeData = { supported: boolean; version?: string; message?: string };
export type SourceControlChangeRequestHead = { project: SourceControlProjectRef; headSha: string; headBranch: string; headOwner: string };
/** OpenChamber adds the context and the requested remote name; the service names where the head lives. */
export type SourceControlChangeRequestSource = {
  sourceProject: SourceControlProjectRef;
  targetProject: SourceControlProjectRef;
  classification: 'same-repository' | 'contributor-fork';
  headSha: string;
  headRef: string;
  /** The head repository's HTTPS clone URL on the instance. */
  endpoint: string;
};
/** Only these keys are stored with a finished mutation. */
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
  commented?: boolean;
  failureStatus?: number;
  failureCode?: string;
};
export type SourceControlReconcileData = {
  state: 'succeeded' | 'failed' | 'outcome-unknown';
  result?: SourceControlMutationResult;
};

/**
 * An answer. `error.status` is the HTTP status OpenChamber should treat the
 * failure as (a 4xx the forge gave, say); a 401 only counts when OpenChamber's
 * proxy saw the forge answer 401 itself. `error.code` is `[A-Z_]{1,64}`.
 */
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

/** `undefined` is a user that is neither `null` nor `{ id, login }`. */
const readSessionUser = (user: WireSourceControlUser | null | undefined): SourceControlProviderUser | null | undefined => {
  if (user === null) return null;
  if (Object(user) !== user || user === undefined) return undefined;
  const { id, login } = user;
  if (!Number.isSafeInteger(id) || String(login) !== login || login.length === 0) return undefined;
  return { id: Number(id), login };
};

/** `undefined` is a session that is neither `null` nor `{ instance, handle, user }`. */
const readSession = (session: WireSourceControlSession | null | undefined): SourceControlProviderSession | null | undefined => {
  if (session === null) return null;
  if (Object(session) !== session || session === undefined) return undefined;
  const { instance, handle } = session;
  if (String(instance) !== instance || instance.length === 0 || String(handle) !== handle || handle.length === 0) return undefined;
  const user = readSessionUser(session.user);
  if (user === undefined) return undefined;
  return { instance, handle, user };
};

/**
 * A service's read of the body OpenChamber posted to
 * `SOURCE_CONTROL_PROVIDER_PATH`. OpenChamber built and validated `input`, so
 * this checks the envelope, not every field, and the service bundle needs no
 * schema library. `null` is a body that is not a source-control call of this
 * wire version; answer it with HTTP 400.
 */
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

/** A request to the forge, relative to the call's instance origin. */
export type SourceControlOutboundRequest = {
  method: SourceControlOutboundMethod;
  /** Starts with `/`; stays on the instance origin. */
  path: string;
  query?: Record<string, string>;
  /** Only `SOURCE_CONTROL_OUTBOUND_REQUEST_HEADERS`; OpenChamber adds the token itself. */
  headers?: Record<string, string>;
  /** At most `SOURCE_CONTROL_OUTBOUND_BODY_MAX` characters. */
  body?: string;
};

/** The forge's answer as OpenChamber relayed it: any status, the allowed headers, the body as text. */
export type SourceControlOutboundResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/**
 * OpenChamber refused the request (an expired handle, a path off the
 * instance, a body too large), could not reach the forge, or did not answer.
 * `status` is the callback listener's HTTP status, `0` when it gave none;
 * `code` is its error code (`HOST_UNAVAILABLE` when there was no usable answer).
 */
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
  /** Sends `request` to the forge of the call `handle` belongs to, with the stored token when the call has one. */
  request(handle: string, request: SourceControlOutboundRequest): Promise<SourceControlOutboundResponse>;
};

type OutboundAnswer = {
  status?: unknown; headers?: unknown; body?: unknown; error?: { message?: unknown; code?: unknown };
};

/**
 * The service's way to the forge: OpenChamber's callback listener
 * (`OPENCHAMBER_HOST_CALLBACK_URL`), which checks the handle, keeps the request
 * on the instance origin and adds the token. Plain `fetch`, no dependencies.
 * Throws `SourceControlForgeError` when OpenChamber refuses the request; a
 * forge answer of any status, 401 included, resolves.
 */
export const createSourceControlForge = ({ env }: { env: Record<string, string | undefined> }): SourceControlForge => {
  const base = env[OPENCHAMBER_HOST_CALLBACK_URL];
  if (!base) throw new Error(`${OPENCHAMBER_HOST_CALLBACK_URL} is not set: only a service that provides "source-control" can reach a forge.`);
  const url = `${base.replace(/\/+$/, '')}${SOURCE_CONTROL_OUTBOUND_PATH}`;
  return {
    async request(handle, request) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${handle}`, 'content-type': 'application/json' },
          body: JSON.stringify(request),
          // A little past OpenChamber's own deadline, so its answer wins.
          signal: AbortSignal.timeout(SOURCE_CONTROL_OUTBOUND_TIMEOUT_MS + 5_000),
        });
      } catch (error) {
        throw new SourceControlForgeError(`OpenChamber did not answer: ${error instanceof Error ? error.message : String(error)}`, 'HOST_UNAVAILABLE', 0);
      }
      let answer: OutboundAnswer;
      try {
        answer = Object(await response.json());
      } catch {
        throw new SourceControlForgeError('OpenChamber answered with something other than JSON', 'HOST_UNAVAILABLE', response.status);
      }
      if (!response.ok) {
        const message = answer.error?.message;
        const code = answer.error?.code;
        throw new SourceControlForgeError(
          String(message) === message && message.length > 0 ? message : `OpenChamber refused the request (${response.status})`,
          String(code) === code && code.length > 0 ? code : 'OUTBOUND_REFUSED',
          response.status,
        );
      }
      if (!Number.isSafeInteger(answer.status) || String(answer.body) !== answer.body) {
        throw new SourceControlForgeError('OpenChamber relayed a malformed forge answer', 'HOST_UNAVAILABLE', response.status);
      }
      const headers: SourceControlOutboundResponse['headers'] = {};
      for (const [name, text] of Object.entries(Object(answer.headers ?? {}))) {
        if (String(text) === text) headers[name] = text;
      }
      return { status: Number(answer.status), headers, body: answer.body };
    },
  };
};
