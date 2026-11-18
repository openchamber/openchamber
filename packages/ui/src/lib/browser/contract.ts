export type BrowserNavStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly url: string }
  | {
    readonly kind: 'ready';
    readonly url: string;
    readonly title: string;
    readonly httpStatus?: number;
  }
  | {
    readonly kind: 'failed';
    readonly url: string;
    readonly code: number;
    readonly description: string;
    readonly crashed?: boolean;
  };

export const IDLE_NAV_STATUS: BrowserNavStatus = { kind: 'idle' };

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

export type BrowserAnnotationRegion = {
  readonly id: string;
  readonly rect: BrowserRect;
};

export type BrowserAnnotationStroke = {
  readonly id: string;
  readonly points: ReadonlyArray<BrowserPoint>;
  readonly bounds: BrowserRect;
};

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
