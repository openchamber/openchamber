import * as React from 'react';

import type { ToolPopupContent } from '@/components/chat/message/types';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useDeviceInfo } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';

const ToolOutputDialog = lazyWithChunkRecovery(() => import('@/components/chat/message/ToolOutputDialog'));

// A decorative picture, such as the site icon before a link, is no picture of the item.
const MARKDOWN_IMAGE_SELECTOR = '[data-markdown-content] img:not([aria-hidden="true"])';

// A picture inside a link (a badge, a linked screenshot) keeps opening its link.
const isPreviewable = (image: HTMLImageElement): boolean => (
    !image.closest('a') && image.complete && image.naturalWidth > 0
);

type ImageGallery = NonNullable<ToolPopupContent['image']>;

/** The viewer's pictures when `target` is a picture it opens: every one in `scope`, starting at `target`. */
export const imageGalleryAt = (target: EventTarget | null, scope: HTMLElement): ImageGallery | null => {
    if (!(target instanceof HTMLImageElement) || !target.matches(MARKDOWN_IMAGE_SELECTOR) || !isPreviewable(target)) return null;
    const images = Array.from(scope.querySelectorAll<HTMLImageElement>(MARKDOWN_IMAGE_SELECTOR)).filter(isPreviewable);
    const gallery = images.map((image) => ({ url: image.currentSrc || image.src, filename: image.alt.trim() || undefined }));
    const index = images.indexOf(target);
    const selected = gallery[index];
    return selected ? { ...selected, gallery, index } : null;
};

const CLOSED: ToolPopupContent = { open: false, title: '', content: '' };

/**
 * Clicking a picture in an item's description or comments opens the chat's
 * image viewer with every loaded picture of the item, in page order. The
 * viewer's chunk loads on the first click; nothing runs before one.
 */
export const useReferenceImagePreview = () => {
    const { isMobile } = useDeviceInfo();
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const [popup, setPopup] = React.useState<ToolPopupContent>(CLOSED);
    const [mounted, setMounted] = React.useState(false);
    const openRef = React.useRef(false);

    const onClick = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
        const image = imageGalleryAt(event.target, event.currentTarget);
        if (!image) return;
        event.preventDefault();
        setMounted(true);
        setPopup({ open: true, title: image.filename ?? '', content: '', image });
        openRef.current = true;
        setImagePreviewOpen(true);
    }, [setImagePreviewOpen]);

    const onOpenChange = React.useCallback((open: boolean) => {
        setPopup((previous) => ({ ...previous, open }));
        openRef.current = open;
        setImagePreviewOpen(open);
    }, [setImagePreviewOpen]);

    // Escape closes the viewer alone: the picker is a dialog that closes on
    // Escape too, and would otherwise go with it.
    React.useEffect(() => {
        if (!popup.open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onOpenChange(false);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [onOpenChange, popup.open]);

    // A viewer left open when the preview goes away must not keep app shortcuts off.
    React.useEffect(() => () => {
        if (openRef.current) setImagePreviewOpen(false);
    }, [setImagePreviewOpen]);

    const viewer = mounted ? (
        <React.Suspense fallback={null}>
            <ToolOutputDialog popup={popup} onOpenChange={onOpenChange} isMobile={isMobile} />
        </React.Suspense>
    ) : null;

    return { onClick, viewer };
};
