import React from 'react';
import { flushSync } from 'react-dom';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ImageAnnotationToolbar } from './ImageAnnotationToolbar';
import { exportAnnotatedImage } from './imageAnnotationExport';
import { useImageAnnotationEditorEffects, type ImageAnnotationKeyboardHandlers } from '@/hooks/useImageAnnotationEditorEffects';
import {
    ANNOTATION_MIN_SCALE,
    DEFAULT_ANNOTATION_COLOR,
    annotationBounds,
    annotationFontSizeFor,
    annotationHistoryWith,
    annotationWidthFor,
    clampViewTransform,
    createAnnotationHistory,
    moveAnnotation,
    nextAnnotationId,
    pointInNaturalSpace,
    redoAnnotationHistory,
    removeAnnotation,
    undoAnnotationHistory,
    zoomViewAt,
    type Annotation,
    type AnnotationHistory,
    type AnnotationPoint,
    type AnnotationSize,
    type AnnotationTool,
    type ViewTransform,
} from '@/lib/imageAnnotation';

type DrawGesture = {
    kind: 'draw';
    start: AnnotationPoint;
    annotation: Annotation;
    pointerId: number;
};

type MoveGesture = {
    kind: 'move';
    start: AnnotationPoint;
    original: Annotation;
    pointerId: number;
};

type PanGesture = {
    kind: 'pan';
    start: AnnotationPoint;
    transform: ViewTransform;
    pointerId: number;
};

type Gesture = DrawGesture | MoveGesture | PanGesture;

type PinchGesture = {
    distance: number;
    transform: ViewTransform;
};

const CENTER: AnnotationPoint = { x: 0, y: 0 };

const distanceBetween = (a: AnnotationPoint, b: AnnotationPoint): number => (
    Math.hypot(a.x - b.x, a.y - b.y)
);

const AnnotationMark: React.FC<{ annotation: Annotation }> = ({ annotation }) => {
    const { tool, points, color, width, text } = annotation;
    const start = points[0];
    const end = points[points.length - 1] ?? start;
    if (!start || !end) return null;

    if (tool === 'text') {
        const fontSize = annotationFontSizeFor(width);
        return (
            <text
                x={start.x}
                y={start.y}
                fill={color}
                stroke="rgba(0, 0, 0, 0.38)"
                strokeWidth={fontSize / 6}
                strokeLinejoin="round"
                paintOrder="stroke"
                fontFamily="sans-serif"
                fontSize={fontSize}
                dominantBaseline="hanging"
            >
                {text}
            </text>
        );
    }

    if (tool === 'rectangle') {
        return (
            <rect
                x={Math.min(start.x, end.x)}
                y={Math.min(start.y, end.y)}
                width={Math.abs(end.x - start.x)}
                height={Math.abs(end.y - start.y)}
                fill="none"
                stroke={color}
                strokeWidth={width}
            />
        );
    }

    if (tool === 'ellipse') {
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        return (
            <ellipse
                cx={x + Math.abs(end.x - start.x) / 2}
                cy={y + Math.abs(end.y - start.y) / 2}
                rx={Math.abs(end.x - start.x) / 2}
                ry={Math.abs(end.y - start.y) / 2}
                fill="none"
                stroke={color}
                strokeWidth={width}
            />
        );
    }

    if (tool === 'arrow') {
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const head = width * 4;
        return (
            <path
                d={[
                    `M${start.x},${start.y} L${end.x},${end.y}`,
                    `M${end.x - head * Math.cos(angle - 0.5)},${end.y - head * Math.sin(angle - 0.5)} L${end.x},${end.y} L${end.x - head * Math.cos(angle + 0.5)},${end.y - head * Math.sin(angle + 0.5)}`,
                ].join(' ')}
                fill="none"
                stroke={color}
                strokeWidth={width}
            />
        );
    }

    if (points.length === 1) {
        return <circle cx={start.x} cy={start.y} r={width / 2} fill={color} stroke="none" />;
    }

    return (
        <polyline
            points={points.map((point) => `${point.x},${point.y}`).join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={width}
        />
    );
};

const AnnotationHitTarget: React.FC<{ annotation: Annotation }> = ({ annotation }) => {
    const { tool, points, width, text } = annotation;
    const start = points[0];
    const end = points[points.length - 1] ?? start;
    if (!start || !end) return null;
    const hitWidth = Math.max(width * 3, 12);

    if (tool === 'text') {
        const fontSize = annotationFontSizeFor(width);
        const textWidth = Math.max(fontSize, (text?.length ?? 0) * fontSize * 0.58);
        return (
            <rect
                x={start.x}
                y={start.y}
                width={textWidth}
                height={fontSize * 1.2}
                fill="transparent"
                pointerEvents="all"
            />
        );
    }

    if (tool === 'rectangle') {
        return (
            <rect
                x={Math.min(start.x, end.x)}
                y={Math.min(start.y, end.y)}
                width={Math.abs(end.x - start.x)}
                height={Math.abs(end.y - start.y)}
                fill="none"
                stroke="transparent"
                strokeWidth={hitWidth}
                pointerEvents="stroke"
            />
        );
    }

    if (tool === 'ellipse') {
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        return (
            <ellipse
                cx={x + Math.abs(end.x - start.x) / 2}
                cy={y + Math.abs(end.y - start.y) / 2}
                rx={Math.abs(end.x - start.x) / 2}
                ry={Math.abs(end.y - start.y) / 2}
                fill="none"
                stroke="transparent"
                strokeWidth={hitWidth}
                pointerEvents="stroke"
            />
        );
    }

    if (tool === 'arrow') {
        return (
            <line
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                stroke="transparent"
                strokeWidth={hitWidth}
                pointerEvents="stroke"
            />
        );
    }

    if (points.length === 1) {
        return <circle cx={start.x} cy={start.y} r={hitWidth / 2} fill="transparent" pointerEvents="all" />;
    }

    return (
        <polyline
            points={points.map((point) => `${point.x},${point.y}`).join(' ')}
            fill="none"
            stroke="transparent"
            strokeWidth={hitWidth}
            pointerEvents="stroke"
        />
    );
};

const AnnotationLayer: React.FC<{
    annotations: readonly Annotation[];
    selectedId: string | null;
}> = ({ annotations, selectedId }) => (
    <>
        {annotations.map((annotation) => (
            <g
                key={annotation.id}
                data-annotation-id={annotation.id}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ pointerEvents: 'none' }}
            >
                <AnnotationMark annotation={annotation} />
                <AnnotationHitTarget annotation={annotation} />
                {selectedId === annotation.id ? (() => {
                    const bounds = annotationBounds(annotation);
                    return (
                        <rect
                            data-annotation-ui=""
                            x={bounds.left}
                            y={bounds.top}
                            width={bounds.width}
                            height={bounds.height}
                            fill="none"
                            stroke="currentColor"
                            strokeDasharray="4 4"
                            strokeWidth={1}
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                        />
                    );
                })() : null}
            </g>
        ))}
    </>
);

type ImageAnnotationEditorProps = {
    src: string;
    alt: string;
    filename?: string;
    displayWidth: number;
    displayHeight: number;
    naturalWidth: number;
    naturalHeight: number;
    isMobile: boolean;
    onApply: (file: File) => Promise<boolean>;
};

export const ImageAnnotationEditor: React.FC<ImageAnnotationEditorProps> = ({
    src,
    alt,
    filename,
    displayWidth,
    displayHeight,
    naturalWidth,
    naturalHeight,
    isMobile,
    onApply,
}) => {
    const { t } = useI18n();
    const [tool, setTool] = React.useState<AnnotationTool>('pen');
    const [color, setColor] = React.useState<string>(DEFAULT_ANNOTATION_COLOR);
    const [history, setHistory] = React.useState<AnnotationHistory>(createAnnotationHistory);
    const [draft, setDraft] = React.useState<Annotation | null>(null);
    const [textDraft, setTextDraft] = React.useState<Annotation | null>(null);
    const [selected, setSelected] = React.useState<string | null>(null);
    const [transform, setTransform] = React.useState<ViewTransform>({ scale: 1, offset: CENTER });
    const [saving, setSaving] = React.useState(false);
    const [imageLoaded, setImageLoaded] = React.useState(false);
    const [imageFailed, setImageFailed] = React.useState(false);

    const viewportRef = React.useRef<HTMLDivElement>(null);
    const surfaceRef = React.useRef<HTMLDivElement>(null);
    const imageRef = React.useRef<HTMLImageElement>(null);
    const overlayRef = React.useRef<SVGSVGElement>(null);
    const draftRef = React.useRef<Annotation | null>(null);
    const gestureRef = React.useRef<Gesture | null>(null);
    const pointersRef = React.useRef<Map<number, AnnotationPoint>>(new Map());
    const pinchRef = React.useRef<PinchGesture | null>(null);
    const transformRef = React.useRef(transform);
    const viewportSizeRef = React.useRef<AnnotationSize>({ width: displayWidth, height: displayHeight });

    transformRef.current = transform;
    viewportSizeRef.current = { width: displayWidth, height: displayHeight };

    const viewportSize = React.useMemo<AnnotationSize>(
        () => ({ width: displayWidth, height: displayHeight }),
        [displayHeight, displayWidth],
    );

    const setDraftAnnotation = (annotation: Annotation | null) => {
        draftRef.current = annotation;
        setDraft(annotation);
    };

    const commit = (update: (present: Annotation[]) => Annotation[]) => {
        setHistory((current) => annotationHistoryWith(current, update(current.present)));
    };

    const undo = () => {
        setTextDraft(null);
        setDraftAnnotation(null);
        setSelected(null);
        setHistory(undoAnnotationHistory);
    };

    const redo = () => {
        setTextDraft(null);
        setDraftAnnotation(null);
        setSelected(null);
        setHistory(redoAnnotationHistory);
    };

    const keyboardRef = React.useRef<ImageAnnotationKeyboardHandlers>({ undo, redo, commit, selected, saving });
    keyboardRef.current = { undo, redo, commit, selected, saving };

    const finishTextDraft = (commitText: boolean) => {
        const current = textDraft;
        if (!current) return;
        const text = current.text?.trim();
        if (commitText && text) {
            commit((present) => [...present, { ...current, text }]);
        }
        setTextDraft(null);
    };

    const changeTool = (nextTool: AnnotationTool) => {
        finishTextDraft(true);
        setSelected(null);
        setTool(nextTool);
    };

    const applyTransform = (next: ViewTransform) => {
        setTransform(clampViewTransform(next, viewportSizeRef.current));
    };

    const zoomBy = (delta: number) => {
        const current = transformRef.current;
        applyTransform(zoomViewAt(current, current.scale + delta, CENTER, viewportSizeRef.current));
    };

    const naturalPoint = (clientX: number, clientY: number): AnnotationPoint | null => {
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (!rect) return null;
        return pointInNaturalSpace(
            { x: clientX, y: clientY },
            rect,
            { width: naturalWidth, height: naturalHeight },
        );
    };

    const annotationWidth = annotationWidthFor(naturalWidth, displayWidth);

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (saving || !imageLoaded || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (pointersRef.current.size === 2) {
            finishTextDraft(true);
            setDraftAnnotation(null);
            gestureRef.current = null;
            const [first, second] = [...pointersRef.current.values()];
            if (first && second) {
                pinchRef.current = {
                    distance: Math.max(1, distanceBetween(first, second)),
                    transform: transformRef.current,
                };
            }
            return;
        }
        if (pointersRef.current.size > 2) return;

        const point = naturalPoint(event.clientX, event.clientY);
        if (!point) return;

        finishTextDraft(true);
        const hitId = event.target instanceof Element
            ? event.target.closest('[data-annotation-id]')?.getAttribute('data-annotation-id') ?? null
            : null;
        const hit = hitId ? history.present.find((annotation) => annotation.id === hitId) : undefined;

        if (tool === 'eraser') {
            if (hit) {
                commit((present) => removeAnnotation(present, hit.id));
                setSelected(null);
            }
            return;
        }

        if (tool === 'text') {
            setSelected(null);
            setTextDraft({
                id: nextAnnotationId(),
                tool: 'text',
                points: [point],
                color,
                width: annotationWidth,
                text: '',
            });
            return;
        }

        if (tool === 'select') {
            setSelected(hit?.id ?? null);
            if (hit) {
                gestureRef.current = {
                    kind: 'move',
                    start: point,
                    original: hit,
                    pointerId: event.pointerId,
                };
                return;
            }
            if (transformRef.current.scale > ANNOTATION_MIN_SCALE) {
                gestureRef.current = {
                    kind: 'pan',
                    start: { x: event.clientX, y: event.clientY },
                    transform: transformRef.current,
                    pointerId: event.pointerId,
                };
            }
            return;
        }

        const annotation: Annotation = {
            id: nextAnnotationId(),
            tool,
            points: [point],
            color,
            width: annotationWidth,
        };
        gestureRef.current = {
            kind: 'draw',
            start: point,
            annotation,
            pointerId: event.pointerId,
        };
        setSelected(null);
        setDraftAnnotation(annotation);
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!pointersRef.current.has(event.pointerId)) return;
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

        const pinch = pinchRef.current;
        if (pinch && pointersRef.current.size >= 2) {
            const [first, second] = [...pointersRef.current.values()];
            if (!first || !second) return;
            const rect = viewportRef.current?.getBoundingClientRect();
            if (!rect) return;
            const midpoint = {
                x: (first.x + second.x) / 2 - rect.left - rect.width / 2,
                y: (first.y + second.y) / 2 - rect.top - rect.height / 2,
            };
            const nextScale = pinch.transform.scale * (distanceBetween(first, second) / pinch.distance);
            applyTransform(zoomViewAt(pinch.transform, nextScale, midpoint, viewportSizeRef.current));
            return;
        }

        const gesture = gestureRef.current;
        if (!gesture) return;

        if (gesture.kind === 'pan') {
            applyTransform({
                scale: gesture.transform.scale,
                offset: {
                    x: gesture.transform.offset.x + event.clientX - gesture.start.x,
                    y: gesture.transform.offset.y + event.clientY - gesture.start.y,
                },
            });
            return;
        }

        const point = naturalPoint(event.clientX, event.clientY);
        if (!point) return;

        if (gesture.kind === 'move') {
            const dx = point.x - gesture.start.x;
            const dy = point.y - gesture.start.y;
            if (!draftRef.current && Math.abs(dx) + Math.abs(dy) < 2) return;
            setDraftAnnotation(moveAnnotation(gesture.original, dx, dy));
            return;
        }

        if (gesture.annotation.tool === 'pen') {
            const points = draftRef.current?.points ?? gesture.annotation.points;
            setDraftAnnotation({
                ...gesture.annotation,
                points: [...points, point],
            });
            return;
        }

        setDraftAnnotation({
            ...gesture.annotation,
            points: [gesture.start, point],
        });
    };

    const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!pointersRef.current.has(event.pointerId)) return;
        pointersRef.current.delete(event.pointerId);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }

        if (pinchRef.current) {
            if (pointersRef.current.size < 2) {
                pinchRef.current = null;
                gestureRef.current = null;
                setDraftAnnotation(null);
            }
            return;
        }

        const gesture = gestureRef.current;
        const currentDraft = draftRef.current;
        if (gesture?.kind === 'draw' && event.type === 'pointerup' && currentDraft) {
            commit((present) => [...present, currentDraft]);
        }
        if (gesture?.kind === 'move' && event.type === 'pointerup' && currentDraft) {
            commit((present) => present.map((annotation) => (
                annotation.id === currentDraft.id ? currentDraft : annotation
            )));
        }
        setDraftAnnotation(null);
        gestureRef.current = null;
    };

    useImageAnnotationEditorEffects({
        viewportRef,
        surfaceRef,
        saving,
        imageLoaded,
        textDraft,
        selected,
        present: history.present,
        viewportSize,
        transformRef,
        viewportSizeRef,
        setTransform,
        setSelected,
        keyboardRef,
    });

    const previewAnnotations = React.useMemo(() => {
        let present = history.present;
        if (draft) {
            present = present.some((annotation) => annotation.id === draft.id)
                ? present.map((annotation) => (annotation.id === draft.id ? draft : annotation))
                : [...present, draft];
        }
        if (textDraft?.text?.trim()) present = [...present, textDraft];
        return present;
    }, [draft, history.present, textDraft]);

    const canApply = !saving && (history.present.length > 0 || Boolean(textDraft?.text?.trim()));

    const handleApply = async () => {
        if (!canApply) return;
        if (textDraft) {
            flushSync(() => finishTextDraft(true));
        }
        const image = imageRef.current;
        const overlay = overlayRef.current;
        if (!image || !overlay) {
            toast.error(t('chat.image.annotate.failed'));
            return;
        }
        setSaving(true);
        try {
            const file = await exportAnnotatedImage(image, overlay, filename || alt);
            const accepted = await onApply(file);
            if (!accepted) toast.error(t('chat.image.annotate.failed'));
        } catch {
            toast.error(t('chat.image.annotate.failed'));
        } finally {
            setSaving(false);
        }
    };

    const cursor = tool === 'text'
        ? 'text'
        : tool === 'select'
            ? transform.scale > ANNOTATION_MIN_SCALE ? 'grab' : 'default'
            : 'crosshair';

    return (
        <div className="relative select-none" style={{ width: `${displayWidth}px`, height: `${displayHeight}px` }}>
            <div
                ref={viewportRef}
                className="absolute inset-0 touch-none overflow-hidden"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
                onLostPointerCapture={handlePointerEnd}
            >
                <div
                    ref={surfaceRef}
                    className="absolute inset-0 outline-none"
                    tabIndex={0}
                    role="group"
                    aria-label={t('chat.image.annotate.canvas')}
                    style={{
                        transform: `translate3d(${transform.offset.x}px, ${transform.offset.y}px, 0) scale(${transform.scale})`,
                        transformOrigin: 'center',
                        cursor,
                    }}
                >
                    <img
                        ref={imageRef}
                        src={src}
                        alt={alt}
                        draggable={false}
                        className="block size-full select-none object-contain"
                        onLoad={() => setImageLoaded(true)}
                        onError={() => {
                            setImageLoaded(false);
                            setImageFailed(true);
                        }}
                    />
                    <svg
                        ref={overlayRef}
                        viewBox={`0 0 ${naturalWidth} ${naturalHeight}`}
                        preserveAspectRatio="none"
                        xmlns="http://www.w3.org/2000/svg"
                        className="pointer-events-none absolute inset-0 size-full overflow-hidden text-foreground"
                    >
                        <AnnotationLayer annotations={previewAnnotations} selectedId={selected} />
                    </svg>
                </div>
            </div>

            {imageFailed ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center p-4 text-center typography-meta text-muted-foreground">
                    {t('chat.image.annotate.loadFailed')}
                </div>
            ) : null}

            {textDraft ? (
                <div
                    className={cn(
                        'absolute inset-x-2 top-2 z-30 flex items-center gap-1 rounded-xl p-1',
                        'oc-glass-popover oc-glass-floating',
                    )}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <Input
                        autoFocus
                        inputSize={isMobile ? 'default' : 'compact'}
                        value={textDraft.text ?? ''}
                        onChange={(event) => setTextDraft({ ...textDraft, text: event.target.value })}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                finishTextDraft(true);
                            }
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                finishTextDraft(false);
                            }
                        }}
                        placeholder={t('chat.image.annotate.textPlaceholder')}
                        aria-label={t('chat.image.annotate.textPlaceholder')}
                    />
                    <Button
                        type="button"
                        size="sm"
                        className={cn(isMobile && 'h-9')}
                        onClick={() => finishTextDraft(true)}
                        disabled={!textDraft.text?.trim()}
                    >
                        {t('chat.image.annotate.addText')}
                    </Button>
                </div>
            ) : null}

            {!imageFailed ? (
                <ImageAnnotationToolbar
                    tool={tool}
                    color={color}
                    scale={transform.scale}
                    canUndo={history.past.length > 0}
                    canRedo={history.future.length > 0}
                    canApply={canApply}
                    saving={saving}
                    ready={imageLoaded}
                    isMobile={isMobile}
                    onToolChange={changeTool}
                    onColorChange={setColor}
                    onUndo={undo}
                    onRedo={redo}
                    onZoomIn={() => zoomBy(0.5)}
                    onZoomOut={() => zoomBy(-0.5)}
                    onApply={() => { void handleApply(); }}
                />
            ) : null}
        </div>
    );
};