import * as React from 'react';

import type { ToolPopupContent } from '@/components/chat/message/types';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useDeviceInfo } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';

const ToolOutputDialog = lazyWithChunkRecovery(() => import('@/components/chat/message/ToolOutputDialog'));

const MARKDOWN_IMAGE_SELECTOR = '[data-markdown-content] img:not([aria-hidden="true"])';

const isPreviewable = (image: HTMLImageElement): boolean => (
    !image.closest('a') && image.complete && image.naturalWidth > 0
);

type ImageGallery = NonNullable<ToolPopupContent['image']>;

export const imageGalleryAt = (target: EventTarget | null, scope: HTMLElement): ImageGallery | null => {
    if (!(target instanceof HTMLImageElement) || !target.matches(MARKDOWN_IMAGE_SELECTOR) || !isPreviewable(target)) return null;
    const images = Array.from(scope.querySelectorAll<HTMLImageElement>(MARKDOWN_IMAGE_SELECTOR)).filter(isPreviewable);
    const gallery = images.map((image) => ({ url: image.currentSrc || image.src, filename: image.alt.trim() || undefined }));
    const index = images.indexOf(target);
    const selected = gallery[index];
    return selected ? { ...selected, gallery, index } : null;
};

const CLOSED: ToolPopupContent = { open: false, title: '', content: '' };

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
