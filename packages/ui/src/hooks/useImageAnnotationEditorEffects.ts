import React from 'react';

import {
    clampNumber,
    clampViewTransform,
    removeAnnotation,
    zoomViewAt,
    type Annotation,
    type AnnotationSize,
    type AnnotationPoint,
    type ViewTransform,
} from '@/lib/imageAnnotation';

export type ImageAnnotationKeyboardHandlers = {
    undo: () => void;
    redo: () => void;
    commit: (update: (present: Annotation[]) => Annotation[]) => void;
    selected: string | null;
    saving: boolean;
};

type ImageAnnotationEditorEffectsOptions = {
    viewportRef: React.RefObject<HTMLDivElement | null>;
    surfaceRef: React.RefObject<HTMLDivElement | null>;
    saving: boolean;
    imageLoaded: boolean;
    textDraft: Annotation | null;
    selected: string | null;
    present: Annotation[];
    viewportSize: AnnotationSize;
    transformRef: React.RefObject<ViewTransform>;
    viewportSizeRef: React.RefObject<AnnotationSize>;
    setTransform: React.Dispatch<React.SetStateAction<ViewTransform>>;
    setSelected: React.Dispatch<React.SetStateAction<string | null>>;
    keyboardRef: React.RefObject<ImageAnnotationKeyboardHandlers>;
};

const INSIDE_TEXT_FIELD = 'input, textarea, [contenteditable="true"]';

export function useImageAnnotationEditorEffects({
    viewportRef,
    surfaceRef,
    saving,
    imageLoaded,
    textDraft,
    selected,
    present,
    viewportSize,
    transformRef,
    viewportSizeRef,
    setTransform,
    setSelected,
    keyboardRef,
}: ImageAnnotationEditorEffectsOptions): void {
    React.useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const listener = (event: WheelEvent) => {
            if (saving || !imageLoaded) return;
            event.preventDefault();
            const rect = viewport.getBoundingClientRect();
            const anchor: AnnotationPoint = {
                x: event.clientX - rect.left - rect.width / 2,
                y: event.clientY - rect.top - rect.height / 2,
            };
            const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
            const current = transformRef.current;
            const nextScale = current.scale * Math.exp(-clampNumber(delta, -300, 300) * 0.002);
            setTransform(zoomViewAt(current, nextScale, anchor, viewportSizeRef.current));
        };
        viewport.addEventListener('wheel', listener, { passive: false });
        return () => viewport.removeEventListener('wheel', listener);
    }, [imageLoaded, saving, setTransform, transformRef, viewportRef, viewportSizeRef]);

    React.useEffect(() => {
        setTransform((current) => clampViewTransform(current, viewportSize));
    }, [setTransform, viewportSize]);

    React.useEffect(() => {
        if (textDraft) return;
        surfaceRef.current?.focus();
    }, [surfaceRef, textDraft]);

    React.useEffect(() => {
        if (selected && !present.some((annotation) => annotation.id === selected)) {
            setSelected(null);
        }
    }, [present, selected, setSelected]);

    React.useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const latest = keyboardRef.current;
            if (!latest || latest.saving) return;
            if (event.target instanceof Element && event.target.closest(INSIDE_TEXT_FIELD)) return;
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                if (event.shiftKey) latest.redo();
                else latest.undo();
                return;
            }
            const selectedId = latest.selected;
            if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
                event.preventDefault();
                latest.commit((current) => removeAnnotation(current, selectedId));
                setSelected(null);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [keyboardRef, setSelected]);
}