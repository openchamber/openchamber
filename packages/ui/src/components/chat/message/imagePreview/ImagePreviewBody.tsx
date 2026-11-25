import React from 'react';

import { StatusImage } from '@/components/ui/status-image';
import { ImageAnnotationEditor } from '../imageAnnotation/ImageAnnotationEditor';

type ImageNaturalSize = {
    url: string;
    width: number;
    height: number;
};

type ImagePreviewBodyProps = {
    url: string;
    alt: string;
    filename?: string;
    displayWidth: number;
    displayHeight: number;
    naturalSize: ImageNaturalSize | null;
    annotating: boolean;
    canAnnotate: boolean;
    isMobile: boolean;
    onApply: (file: File) => Promise<boolean>;
    onNaturalSize: (size: ImageNaturalSize) => void;
};

export const ImagePreviewBody: React.FC<ImagePreviewBodyProps> = ({
    url,
    alt,
    filename,
    displayWidth,
    displayHeight,
    naturalSize,
    annotating,
    canAnnotate,
    isMobile,
    onApply,
    onNaturalSize,
}) => {
    if (annotating && canAnnotate && naturalSize) {
        return (
            <ImageAnnotationEditor
                key={url}
                src={url}
                alt={alt}
                filename={filename}
                displayWidth={displayWidth}
                displayHeight={displayHeight}
                naturalWidth={naturalSize.width}
                naturalHeight={naturalSize.height}
                isMobile={isMobile}
                onApply={onApply}
            />
        );
    }

    return (
        <StatusImage
            src={url}
            alt={alt}
            variant="large"
            style={{ width: `${displayWidth}px`, height: `${displayHeight}px` }}
            imgClassName="block h-full w-full object-contain"
            lazy
            onLoad={(element) => {
                const width = element.naturalWidth;
                const height = element.naturalHeight;
                const sourceUrl = element.getAttribute('src') ?? '';
                if (width > 0 && height > 0) {
                    onNaturalSize({ url: sourceUrl, width, height });
                }
            }}
        />
    );
};