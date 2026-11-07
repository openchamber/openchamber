import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { FIT_VIEW, type ImageView, type LightboxImage, zoomViewAt } from './imageView';

/** A pointer that moves this far (px) between press and release pans instead of clicking. */
const PAN_THRESHOLD = 4;
const WHEEL_ZOOM_RATE = 0.0015;

const overlayButtonClass = 'absolute z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * A full-window viewer for a list of images: arrows and the left/right keys page
 * through them, the wheel zooms around the pointer, a click toggles between fit and
 * full size at the clicked point, and a drag pans a zoomed image. It is portalled
 * to the body and takes Escape and the arrow keys before the app sees them.
 */
export const ImageLightbox: React.FC<{
    images: readonly LightboxImage[];
    initialIndex: number;
    onClose: () => void;
}> = ({ images, initialIndex, onClose }) => {
    const { t, direction } = useI18n();
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const count = images.length;
    const [index, setIndex] = React.useState(Math.min(Math.max(initialIndex, 0), Math.max(count - 1, 0)));
    const [view, setView] = React.useState<ImageView>(FIT_VIEW);
    const [panning, setPanning] = React.useState(false);
    const overlayRef = React.useRef<HTMLDivElement>(null);
    const imageRef = React.useRef<HTMLImageElement>(null);
    const closeRef = React.useRef<HTMLButtonElement>(null);
    const dragRef = React.useRef<{ pointerX: number; pointerY: number; viewX: number; viewY: number; moved: boolean } | null>(null);

    const go = React.useCallback((step: number) => {
        if (count < 2) return;
        setIndex((current) => (current + step + count) % count);
        setView(FIT_VIEW);
    }, [count]);

    // App shortcuts stay off while the viewer is open, and focus returns to what had it.
    React.useEffect(() => {
        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setImagePreviewOpen(true);
        closeRef.current?.focus();
        return () => {
            setImagePreviewOpen(false);
            previouslyFocused?.focus();
        };
    }, [setImagePreviewOpen]);

    // Capture phase, so Escape and the arrows never reach the app behind the viewer.
    React.useEffect(() => {
        // "Previous" sits at the start of the row: on the right in RTL.
        const previousKey = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
        const nextKey = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
            else if (event.key === previousKey && count > 1) go(-1);
            else if (event.key === nextKey && count > 1) go(1);
            else return;
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [count, direction, go, onClose]);

    const imageOrigin = React.useCallback(() => {
        const image = imageRef.current;
        return { left: image?.offsetLeft ?? 0, top: image?.offsetTop ?? 0 };
    }, []);

    // React's wheel handler is passive, which cannot stop the page from scrolling.
    React.useEffect(() => {
        const overlay = overlayRef.current;
        if (!overlay) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            const origin = imageOrigin();
            setView((current) => zoomViewAt(current, current.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE), event.clientX, event.clientY, origin));
        };
        overlay.addEventListener('wheel', onWheel, { passive: false });
        return () => overlay.removeEventListener('wheel', onWheel);
    }, [imageOrigin]);

    const toggleZoom = (cx: number, cy: number) => {
        const image = imageRef.current;
        if (!image) return;
        const origin = imageOrigin();
        // Full size when that is larger than the fitted size, else twice the fit.
        const fullSize = image.naturalWidth / (image.offsetWidth || 1);
        setView((current) => (current.scale > 1 ? FIT_VIEW : zoomViewAt(current, fullSize > 1.01 ? fullSize : 2, cx, cy, origin)));
    };

    const onPointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, viewX: view.x, viewY: view.y, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = event.clientX - drag.pointerX;
        const dy = event.clientY - drag.pointerY;
        if (!drag.moved && Math.hypot(dx, dy) > PAN_THRESHOLD) {
            drag.moved = true;
            setPanning(true);
        }
        if (drag.moved) setView((current) => (current.scale > 1 ? { ...current, x: drag.viewX + dx, y: drag.viewY + dy } : current));
    };

    const onPointerUp = (event: React.PointerEvent<HTMLImageElement>) => {
        const drag = dragRef.current;
        dragRef.current = null;
        setPanning(false);
        if (drag && !drag.moved) toggleZoom(event.clientX, event.clientY);
    };

    const onPointerCancel = () => {
        dragRef.current = null;
        setPanning(false);
    };

    const current = images[index];
    if (!current) return null;

    return createPortal(
        <div
            ref={overlayRef}
            role="dialog"
            aria-modal="true"
            aria-label={current.alt}
            data-image-lightbox=""
            className="fixed inset-0 z-50 flex touch-none select-none items-center justify-center overflow-hidden bg-black/85"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <img
                ref={imageRef}
                src={current.src}
                alt={current.alt}
                draggable={false}
                className={cn(
                    'max-h-[90vh] max-w-[90vw] origin-top-left rounded object-contain shadow-2xl will-change-transform',
                    panning && view.scale > 1 ? 'cursor-grabbing' : view.scale > 1 ? 'cursor-zoom-out' : 'cursor-zoom-in',
                )}
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
            />
            {count > 1 ? (
                <>
                    <button
                        type="button"
                        className={cn(overlayButtonClass, 'inset-s-4 top-1/2 -translate-y-1/2')}
                        aria-label={t('chat.toolOutputDialog.image.previousAria')}
                        onClick={() => go(-1)}
                    >
                        <Icon name="arrow-left-s" className="h-6 w-6" />
                    </button>
                    <button
                        type="button"
                        className={cn(overlayButtonClass, 'inset-e-4 top-1/2 -translate-y-1/2')}
                        aria-label={t('chat.toolOutputDialog.image.nextAria')}
                        onClick={() => go(1)}
                    >
                        <Icon name="arrow-right-s" className="h-6 w-6" />
                    </button>
                    <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 typography-meta text-white">
                        {index + 1} / {count}
                    </div>
                </>
            ) : null}
            <button
                ref={closeRef}
                type="button"
                className={cn(overlayButtonClass, 'inset-e-4 top-4')}
                aria-label={t('chat.toolOutputDialog.image.closeAria')}
                onClick={onClose}
            >
                <Icon name="close" className="h-6 w-6" />
            </button>
        </div>,
        document.body,
    );
};
