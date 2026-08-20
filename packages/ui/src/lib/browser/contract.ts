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
