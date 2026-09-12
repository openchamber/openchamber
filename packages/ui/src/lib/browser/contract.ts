/**
 * Browser surface contract.
 *
 * One shared vocabulary for the in-app browser across every runtime. The
 * surface renders a real Chromium `<webview>` on desktop and a plain iframe
 * everywhere else; both report their state through the types below, so the
 * panel never has to ask which transport it is talking to.
 *
 * Navigation is a tagged union rather than a bag of booleans: `loading` and
 * `failed` carry the URL they describe, which is what makes a late event from
 * a superseded navigation discardable instead of ambiguous.
 *
 * The agent-control backend contracts (`BrowserTarget`, `BrowserSession`,
 * `BrowserBackend`, and friends) live at the bottom of this file. The
 * deferred Phase-3 server backend is plain JavaScript and will mirror these
 * wire-level types in JSDoc, so they stay free of TypeScript-only machinery.
 *
 * Tab-id namespace rule: server-side tab ids are `sc:<cdp-target-id>`;
 * anything else is a client pane id. Routing reads the prefix.
 */

export type BrowserNavStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly url: string }
  | { readonly kind: 'ready'; readonly url: string; readonly title: string }
  | {
    readonly kind: 'failed';
    readonly url: string;
    readonly code: number;
    readonly description: string;
    /** The page's renderer died rather than the load failing; worth saying so. */
    readonly crashed?: boolean;
  };

export const IDLE_NAV_STATUS: BrowserNavStatus = { kind: 'idle' };

/** The URL a nav status refers to, or '' when idle. */
export const navStatusUrl = (status: BrowserNavStatus): string => (
  status.kind === 'idle' ? '' : status.url
);

export type BrowserRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type BrowserPoint = { readonly x: number; readonly y: number };

export type BrowserElementAncestor = {
  readonly tag: string;
  readonly id?: string;
  readonly className?: string;
  readonly selectorPart: string;
};

/**
 * A single DOM element described well enough for an agent to find it again in
 * source: a selector, a readable ancestry path, its own box, and the computed
 * styles that usually matter when someone is asking for a visual change.
 */
export type BrowserElementTarget = {
  readonly tag: string;
  readonly text: string;
  readonly selector: string;
  readonly path: string;
  readonly bounds: BrowserRect;
  readonly center: BrowserPoint;
  readonly attributes: Readonly<Record<string, string>>;
  readonly computedStyle: Readonly<Record<string, string>>;
  readonly ancestry: ReadonlyArray<BrowserElementAncestor>;
};

export type BrowserAnnotationElement = {
  readonly id: string;
  readonly element: BrowserElementTarget;
};

/** A free-form rectangle the user dragged over a part of the page. */
export type BrowserAnnotationRegion = {
  readonly id: string;
  readonly rect: BrowserRect;
};

/** A free-hand stroke drawn over the page. */
export type BrowserAnnotationStroke = {
  readonly id: string;
  readonly points: ReadonlyArray<BrowserPoint>;
  readonly bounds: BrowserRect;
};

/**
 * The complete result of one annotation session: everything the user marked,
 * everything they restyled, and what they said about it. Emitted once, on
 * submit — never per-click.
 */
export type BrowserAnnotationPayload = {
  readonly id: string;
  readonly pageUrl: string;
  readonly pageTitle: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly devicePixelRatio: number;
  readonly comment: string;
  readonly elements: ReadonlyArray<BrowserAnnotationElement>;
  readonly regions: ReadonlyArray<BrowserAnnotationRegion>;
  readonly strokes: ReadonlyArray<BrowserAnnotationStroke>;
};

export const annotationTargetCount = (payload: BrowserAnnotationPayload): number => (
  payload.elements.length + payload.regions.length + payload.strokes.length
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const isStringRecord = (value: unknown): value is Record<string, string> => (
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
);

const isBrowserRect = (value: unknown): value is BrowserRect => (
  isRecord(value)
  && isFiniteNumber(value.x)
  && isFiniteNumber(value.y)
  && isFiniteNumber(value.width)
  && isFiniteNumber(value.height)
);

const isBrowserPoint = (value: unknown): value is BrowserPoint => (
  isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y)
);

const isAncestor = (value: unknown): value is BrowserElementAncestor => (
  isRecord(value)
  && typeof value.tag === 'string'
  && typeof value.selectorPart === 'string'
  && (value.id === undefined || typeof value.id === 'string')
  && (value.className === undefined || typeof value.className === 'string')
);

/**
 * Annotation payloads cross a trust boundary: they are produced by a script
 * running inside a page we do not control. Every field a consumer dereferences
 * is validated here, not just the ones that are convenient to check — a
 * partially-valid payload would otherwise throw far away from its origin, at
 * prompt-formatting or screenshot-crop time.
 */
export const isBrowserElementTarget = (value: unknown): value is BrowserElementTarget => (
  isRecord(value)
  && typeof value.tag === 'string'
  && typeof value.text === 'string'
  && typeof value.selector === 'string'
  && typeof value.path === 'string'
  && isBrowserRect(value.bounds)
  && isBrowserPoint(value.center)
  && isStringRecord(value.attributes)
  && isStringRecord(value.computedStyle)
  && Array.isArray(value.ancestry)
  && value.ancestry.every(isAncestor)
);

const isAnnotationElement = (value: unknown): value is BrowserAnnotationElement => (
  isRecord(value) && typeof value.id === 'string' && isBrowserElementTarget(value.element)
);

const isAnnotationRegion = (value: unknown): value is BrowserAnnotationRegion => (
  isRecord(value) && typeof value.id === 'string' && isBrowserRect(value.rect)
);

const isAnnotationStroke = (value: unknown): value is BrowserAnnotationStroke => (
  isRecord(value)
  && typeof value.id === 'string'
  && isBrowserRect(value.bounds)
  && Array.isArray(value.points)
  && value.points.every(isBrowserPoint)
);

export const isBrowserAnnotationPayload = (value: unknown): value is BrowserAnnotationPayload => (
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.pageUrl === 'string'
  && typeof value.pageTitle === 'string'
  && typeof value.comment === 'string'
  && isRecord(value.viewport)
  && isFiniteNumber(value.viewport.width)
  && isFiniteNumber(value.viewport.height)
  && isFiniteNumber(value.devicePixelRatio)
  && Array.isArray(value.elements)
  && value.elements.every(isAnnotationElement)
  && Array.isArray(value.regions)
  && value.regions.every(isAnnotationRegion)
  && Array.isArray(value.strokes)
  && value.strokes.every(isAnnotationStroke)
);

/**
 * Agent browser-control contracts.
 *
 * One browser pane's identity: one tab of one project on one runtime.
 */
export type BrowserControllerKey = {
  readonly runtimeKey: string;
  readonly directory: string;
  readonly tabId: string;
};

/**
 * The scope a browser-control request names. `directory` is the project the
 * action belongs to; `tabId` names an existing tab to act on (absent for a
 * tab-less open or an action aimed at the visible tab); `openCodeSessionId`
 * ties the request back to the agent session that issued it.
 */
export type BrowserTarget = {
  readonly directory: string;
  readonly tabId?: string;
  readonly openCodeSessionId?: string;
  /** A session's explicit backend force; absent means the runtime default. */
  readonly preferBackend?: BrowserBackendKind;
};

/**
 * Targets arrive over the server's event stream, so every field a consumer
 * dereferences is checked here — a malformed target must be droppable, never
 * half-trusted.
 */
export const isBrowserTarget = (value: unknown): value is BrowserTarget => (
  isRecord(value)
  && typeof value.directory === 'string'
  && (value.tabId === undefined || typeof value.tabId === 'string')
  && (value.openCodeSessionId === undefined || typeof value.openCodeSessionId === 'string')
  && (value.preferBackend === undefined
    || value.preferBackend === 'electron-webview'
    || value.preferBackend === 'server-chrome')
);

/** One tab as the panel reports it: what it shows and whether it is visible. */
export type BrowserTabInfo = {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
  /** Set when listings merge backends; absent on single-backend listings. */
  readonly backend?: BrowserBackendKind;
};

/**
 * Names the browser backend: a client Electron webview or server-owned Chrome.
 * Server Chrome uses isolated sessions and the authenticated remote viewer.
 */
export type BrowserBackendKind = 'electron-webview' | 'server-chrome';

/**
 * The reduced Phase-2 read model: a live snapshot of what one project's
 * browser surface shows, answerable from the registry without any stored
 * state. `sessionId` and `persistence` are the Phase-3 additions, both
 * optional: a backend without stored session state simply omits them.
 */
export type BrowserSession = {
  readonly backend: BrowserBackendKind;
  readonly directory: string;
  readonly tabs: BrowserTabInfo[];
  readonly activeTabId: string | null;
  /** Stable identity of the backend's persisted session, when it has one. */
  readonly sessionId?: string;
  /** Whether the backend keeps this session across restarts. */
  readonly persistence?: 'ephemeral' | 'project';
};

/**
 * The dispatch-shaped surface every browser backend implements. One typed
 * `execute` — rather than per-action methods — covers every current action
 * without an enumeration that can drift from the server's allowlist.
 */
export interface BrowserBackend {
  getSession(scope: { directory: string }): BrowserSession | null;
  listTabs(scope: { directory: string }): BrowserTabInfo[];
  execute(target: BrowserTarget, action: string, parameters: Record<string, unknown>): Promise<unknown>;
}
