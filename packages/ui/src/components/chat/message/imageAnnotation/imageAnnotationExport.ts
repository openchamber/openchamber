import {
    ANNOTATION_EXPORT_MAX_PIXELS,
    annotationExportSize,
} from '@/lib/imageAnnotation';

const ANNOTATED_IMAGE_TARGET_BYTES = 9_500_000;

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> => (
    new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('The annotated image could not be encoded.'));
        }, type, quality);
    })
);

const loadSvgLayer = (url: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The annotation layer could not be rendered.'));
    image.src = url;
});

const safeImageName = (filename: string | undefined): string => {
    const name = filename?.split(/[\\/]/).pop()?.trim();
    return name || 'image.png';
};

export const exportAnnotatedImage = async (
    image: HTMLImageElement,
    overlay: SVGSVGElement,
    filename: string | undefined,
): Promise<File> => {
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    if (!naturalWidth || !naturalHeight) {
        throw new Error('The image is not ready to annotate.');
    }

    const firstSize = annotationExportSize(naturalWidth, naturalHeight);
    // SAFETY: the overlay is the SVG element this editor rendered; cloneNode preserves its node type.
    const clone = overlay.cloneNode(true) as SVGSVGElement;
    clone.querySelectorAll('[data-annotation-ui]').forEach((node) => node.remove());
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(firstSize.width));
    clone.setAttribute('height', String(firstSize.height));
    clone.setAttribute('viewBox', `0 0 ${naturalWidth} ${naturalHeight}`);
    clone.removeAttribute('class');
    clone.removeAttribute('style');

    const layerUrl = URL.createObjectURL(new Blob(
        [new XMLSerializer().serializeToString(clone)],
        { type: 'image/svg+xml' },
    ));

    try {
        const layer = await loadSvgLayer(layerUrl);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable.');

        let maxPixels = ANNOTATION_EXPORT_MAX_PIXELS;
        let lastSize = firstSize;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const size = annotationExportSize(naturalWidth, naturalHeight, maxPixels);
            lastSize = size;
            canvas.width = size.width;
            canvas.height = size.height;
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.clearRect(0, 0, size.width, size.height);
            context.drawImage(image, 0, 0, size.width, size.height);
            context.drawImage(layer, 0, 0, size.width, size.height);

            const type = attempt === 0 ? 'image/png' : 'image/jpeg';
            const blob = await canvasToBlob(canvas, type, 0.92);
            if (blob.size <= ANNOTATED_IMAGE_TARGET_BYTES) {
                return new File([blob], safeImageName(filename), { type: blob.type });
            }
            maxPixels = Math.max(1, Math.round(size.width * size.height * 0.64));
        }

        throw new Error(`The annotated image is too large to attach (${lastSize.width}x${lastSize.height}).`);
    } finally {
        URL.revokeObjectURL(layerUrl);
    }
};