import React from 'react';

import { useRawAssetUrl } from '@/components/views/files/useRawAssetUrl';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isFilePathWithinDirectory } from '@/lib/path-utils';
import { ImageLightbox } from './ImageLightbox';
import type { LightboxImage } from './imageView';

const INLINE_IMAGE_ATTRIBUTE = 'data-inline-image';
const ignoreAssetError = () => {};

type Gallery = { images: LightboxImage[]; index: number };

/** The inline images the viewer pages through: those of the chat column `from` sits in. */
const inlineImagesAround = (from: HTMLImageElement): Gallery => {
    const scope: ParentNode = from.closest('[data-chat-column]') ?? document;
    const found = Array.from(scope.querySelectorAll<HTMLImageElement>(`img[${INLINE_IMAGE_ATTRIBUTE}]`))
        .filter((image) => (image.currentSrc || image.src) !== '');
    const index = found.indexOf(from);
    if (index < 0) return { images: [{ src: from.currentSrc || from.src, alt: from.alt }], index: 0 };
    return { images: found.map((image) => ({ src: image.currentSrc || image.src, alt: image.alt })), index };
};

/**
 * An image drawn in the chat at a bounded size; a click opens it in the full-window
 * viewer, which pages through every inline image of the conversation. An image that
 * fails to load disappears, leaving the row or chip it sits under as it was.
 */
export const InlineImage: React.FC<{ src: string; alt: string }> = ({ src, alt }) => {
    const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
    const [viewer, setViewer] = React.useState<Gallery | null>(null);
    const closeViewer = React.useCallback(() => setViewer(null), []);

    if (!src || failedSrc === src) return null;
    return (
        <>
            <button
                type="button"
                className="mt-1.5 block w-fit max-w-[min(100%,320px)] cursor-zoom-in rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={alt}
                onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const image = event.currentTarget.querySelector('img');
                    if (image) setViewer(inlineImagesAround(image));
                }}
            >
                <img
                    {...{ [INLINE_IMAGE_ATTRIBUTE]: '' }}
                    src={src}
                    alt={alt}
                    loading="lazy"
                    className="block h-auto max-h-[240px] w-auto max-w-full rounded-lg border border-edge-muted object-contain"
                    onError={() => setFailedSrc(src)}
                />
            </button>
            {viewer ? <ImageLightbox images={viewer.images} initialIndex={viewer.index} onClose={closeViewer} /> : null}
        </>
    );
};

/** True once the element has come within a screenful of the viewport; stays true after. */
const useNearViewport = () => {
    const [element, setElement] = React.useState<HTMLElement | null>(null);
    const [near, setNear] = React.useState(false);
    React.useEffect(() => {
        if (!element || near) return;
        const Observer = element.ownerDocument.defaultView?.IntersectionObserver;
        if (!Observer) {
            setNear(true);
            return;
        }
        const observer = new Observer((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) setNear(true);
        }, { rootMargin: '200px' });
        observer.observe(element);
        return () => observer.disconnect();
    }, [element, near]);
    return { setElement, near };
};

/**
 * An inline image read from a file on the server's disk, through `/api/fs/raw` and the
 * authenticated asset URL the Files viewer uses for its media. The file is requested
 * only once the image is near the viewport, so a long chat does not read every image.
 */
export const WorkspaceImage: React.FC<{ path: string; directory: string; alt: string }> = ({ path, directory, alt }) => {
    const { setElement, near } = useNearViewport();
    const request = React.useMemo(() => (near
        ? { runtime: getRuntimeKey(), path, directory, revision: '', outsideWorkspace: !isFilePathWithinDirectory(path, directory) }
        : null), [near, path, directory]);
    const { src } = useRawAssetUrl(request, ignoreAssetError, '');
    return <div ref={setElement}><InlineImage src={src} alt={alt} /></div>;
};
