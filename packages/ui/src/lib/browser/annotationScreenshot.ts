/**
 * Turns a native page capture plus an annotation payload into the image the
 * agent receives.
 *
 * The image is the whole visible page, with the marked targets drawn on top —
 * not a crop around them. A tight crop answers "what does this element look
 * like" but destroys the answer to "where is it and what is it next to", which
 * is usually the more useful half of pointing at something.
 *
 * The capture arrives in device pixels while every rectangle in the payload is
 * in CSS pixels, so everything is scaled by the ratio between the two rather
 * than by `devicePixelRatio` — the page may be zoomed, and the measured ratio
 * stays correct when it is.
 */
import type { BrowserAnnotationPayload, BrowserRect } from './contract';

const MAX_OUTPUT_WIDTH = 1600;

const loadImage = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('Failed to decode browser page capture'));
  image.src = src;
});

export const renderAnnotationScreenshot = async ({
  base64,
  mime,
  captureWidth,
  captureHeight,
  cssWidth,
  cssHeight,
  payload,
  accentColor,
  accentFill,
}: {
  base64: string;
  mime: string;
  captureWidth: number;
  captureHeight: number;
  cssWidth: number;
  cssHeight: number;
  payload: BrowserAnnotationPayload;
  /** Solid outline color. */
  accentColor: string;
  /**
   * Translucent fill, resolved by the caller. Never derive this by appending an
   * alpha suffix to `accentColor`: theme colors are not necessarily hex, and an
   * invalid value leaves canvas on its default opaque black, which paints over
   * the very element the screenshot is meant to show.
   */
  accentFill: string;
}): Promise<File | null> => {
  if (!base64) return null;

  try {
    const image = await loadImage(`data:${mime};base64,${base64}`);
    const pixelWidth = Math.max(1, image.naturalWidth || captureWidth);
    const pixelHeight = Math.max(1, image.naturalHeight || captureHeight);
    const scaleX = pixelWidth / Math.max(1, cssWidth || pixelWidth);
    const scaleY = pixelHeight / Math.max(1, cssHeight || pixelHeight);

    const outputScale = Math.min(1, MAX_OUTPUT_WIDTH / pixelWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(pixelWidth * outputScale));
    canvas.height = Math.max(1, Math.floor(pixelHeight * outputScale));
    const context = canvas.getContext('2d');
    if (!context) return null;

    context.scale(outputScale, outputScale);
    context.drawImage(image, 0, 0, pixelWidth, pixelHeight);

    /** CSS pixels to capture pixels; the canvas transform handles the rest. */
    const toCanvas = (rect: BrowserRect): BrowserRect => ({
      x: rect.x * scaleX,
      y: rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    });

    // Scale the outline with the image so it stays visible once a full page is
    // shrunk to the output width; a hairline on a 1600px-wide page is lost.
    const outlineWidth = Math.max(2, 2.5 * scaleX / Math.max(outputScale, 0.2));
    context.strokeStyle = accentColor;
    context.fillStyle = accentFill;

    const markRect = (rect: BrowserRect) => {
      const box = toCanvas(rect);
      context.lineWidth = outlineWidth;
      context.fillRect(box.x, box.y, box.width, box.height);
      context.strokeRect(box.x, box.y, box.width, box.height);
    };

    for (const entry of payload.elements) markRect(entry.element.bounds);
    for (const region of payload.regions) markRect(region.rect);

    for (const stroke of payload.strokes) {
      if (stroke.points.length < 2) continue;
      context.beginPath();
      stroke.points.forEach((point, index) => {
        const x = point.x * scaleX;
        const y = point.y * scaleY;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.lineWidth = outlineWidth * 1.4;
      context.stroke();
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) return null;
    return new File([blob], `browser-annotation-${Date.now()}.jpg`, { type: 'image/jpeg' });
  } catch {
    return null;
  }
};
