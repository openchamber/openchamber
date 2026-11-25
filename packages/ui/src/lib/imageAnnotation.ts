export type AnnotationTool = 'select' | 'pen' | 'text' | 'rectangle' | 'ellipse' | 'arrow' | 'eraser';

export type DrawingAnnotationTool = Exclude<AnnotationTool, 'select' | 'eraser'>;

export type AnnotationPoint = { x: number; y: number };

export type Annotation = {
    id: string;
    tool: DrawingAnnotationTool;
    points: AnnotationPoint[];
    color: string;
    width: number;
    text?: string;
};

export type AnnotationHistory = {
    past: Annotation[][];
    present: Annotation[];
    future: Annotation[][];
};

export type ViewTransform = {
    scale: number;
    offset: AnnotationPoint;
};

export type AnnotationSize = { width: number; height: number };

type MeasurementRect = {
    left: number;
    top: number;
    width: number;
    height: number;
};

export const ANNOTATION_HISTORY_LIMIT = 50;
export const ANNOTATION_MIN_SCALE = 1;
export const ANNOTATION_MAX_SCALE = 4;
export const ANNOTATION_EXPORT_MAX_PIXELS = 16_000_000;

export const ANNOTATION_INK_COLORS = [
    '#ef4444',
    '#f59e0b',
    '#22c55e',
    '#3b82f6',
    '#111827',
    '#ffffff',
] as const;

export const DEFAULT_ANNOTATION_COLOR = ANNOTATION_INK_COLORS[0];

export const createAnnotationHistory = (): AnnotationHistory => ({
    past: [],
    present: [],
    future: [],
});

export const annotationHistoryWith = (
    history: AnnotationHistory,
    present: Annotation[],
): AnnotationHistory => ({
    past: [...history.past, history.present].slice(-ANNOTATION_HISTORY_LIMIT),
    present,
    future: [],
});

export const undoAnnotationHistory = (history: AnnotationHistory): AnnotationHistory => {
    const previous = history.past[history.past.length - 1];
    if (!previous) return history;
    return {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
    };
};

export const redoAnnotationHistory = (history: AnnotationHistory): AnnotationHistory => {
    const next = history.future[0];
    if (!next) return history;
    return {
        past: [...history.past, history.present].slice(-ANNOTATION_HISTORY_LIMIT),
        present: next,
        future: history.future.slice(1),
    };
};

export const moveAnnotation = (
    annotation: Annotation,
    dx: number,
    dy: number,
): Annotation => ({
    ...annotation,
    points: annotation.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
});

export const removeAnnotation = (
    annotations: readonly Annotation[],
    id: string,
): Annotation[] => annotations.filter((annotation) => annotation.id !== id);

export const annotationWidthFor = (naturalWidth: number, displayWidth: number): number => {
    const scale = displayWidth / Math.max(1, naturalWidth);
    return Math.max(2, 3 / Math.max(scale, 0.01));
};

export const annotationFontSizeFor = (strokeWidth: number): number => Math.max(12, strokeWidth * 6);

export const annotationBounds = (annotation: Annotation): MeasurementRect => {
    const xs = annotation.points.map((point) => point.x);
    const ys = annotation.points.map((point) => point.y);
    const fontSize = annotationFontSizeFor(annotation.width);
    const textWidth = annotation.tool === 'text'
        ? (annotation.text?.length ?? 0) * fontSize * 0.58
        : 0;
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs, annotation.tool === 'text' ? minX + textWidth : Number.NEGATIVE_INFINITY);
    const maxY = Math.max(...ys, annotation.tool === 'text' ? minY + fontSize * 1.2 : Number.NEGATIVE_INFINITY);
    const padding = annotation.width * 4;
    return {
        left: minX - padding,
        top: minY - padding,
        width: Math.max(annotation.width * 8, maxX - minX + padding * 2),
        height: Math.max(annotation.width * 8, maxY - minY + padding * 2),
    };
};

export const clampNumber = (value: number, min: number, max: number): number => (
    Math.min(max, Math.max(min, value))
);

export const clampViewTransform = (
    transform: ViewTransform,
    viewport: AnnotationSize,
): ViewTransform => {
    const limitX = Math.max(0, (viewport.width * transform.scale - viewport.width) / 2);
    const limitY = Math.max(0, (viewport.height * transform.scale - viewport.height) / 2);
    return {
        scale: transform.scale,
        offset: {
            x: clampNumber(transform.offset.x, -limitX, limitX),
            y: clampNumber(transform.offset.y, -limitY, limitY),
        },
    };
};

export const zoomViewAt = (
    transform: ViewTransform,
    scale: number,
    anchor: AnnotationPoint,
    viewport: AnnotationSize,
): ViewTransform => {
    const nextScale = clampNumber(scale, ANNOTATION_MIN_SCALE, ANNOTATION_MAX_SCALE);
    const ratio = nextScale / transform.scale;
    return clampViewTransform({
        scale: nextScale,
        offset: {
            x: anchor.x - (anchor.x - transform.offset.x) * ratio,
            y: anchor.y - (anchor.y - transform.offset.y) * ratio,
        },
    }, viewport);
};

export const pointInNaturalSpace = (
    client: AnnotationPoint,
    rect: MeasurementRect,
    natural: AnnotationSize,
): AnnotationPoint => ({
    x: clampNumber(((client.x - rect.left) / Math.max(1, rect.width)) * natural.width, 0, natural.width),
    y: clampNumber(((client.y - rect.top) / Math.max(1, rect.height)) * natural.height, 0, natural.height),
});

export const annotationExportSize = (
    width: number,
    height: number,
    maxPixels: number = ANNOTATION_EXPORT_MAX_PIXELS,
): AnnotationSize & { scale: number } => {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    const scale = Math.min(1, Math.sqrt(maxPixels / (safeWidth * safeHeight)));
    return {
        width: Math.max(1, Math.round(safeWidth * scale)),
        height: Math.max(1, Math.round(safeHeight * scale)),
        scale,
    };
};

const randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);

export const nextAnnotationId = (): string => (
    randomUuid ? randomUuid() : `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);