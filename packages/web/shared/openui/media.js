import { z } from 'zod/v4';

const image = z.object({ src: z.string() });
const gallery = z.object({ images: z.array(image) });

/** Only these native component properties represent media, never arbitrary data. */
export function nativeOpenUIImageSources(node) {
  if (node.typeName === 'Image') {
    const result = image.safeParse(node.props);
    return result.success ? [result.data.src] : [];
  }
  if (node.typeName === 'ImageGallery') {
    const result = gallery.safeParse(node.props);
    return result.success ? result.data.images.map((item) => item.src) : [];
  }
  return [];
}
