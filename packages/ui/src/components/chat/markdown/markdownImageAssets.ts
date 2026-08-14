import { isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import { runtimeFetch } from '@/lib/runtime-fetch';

const MAX_MARKDOWN_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const parseLocalImagePath = (source: string): string => {
  let value = source;
  if (/^file:\/\//i.test(value)) {
    try {
      const fileUrl = new URL(value);
      if (fileUrl.protocol !== 'file:') return '';
      value = fileUrl.host && fileUrl.host !== 'localhost'
        ? `//${fileUrl.host}${fileUrl.pathname}`
        : fileUrl.pathname;
      if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
    } catch {
      return '';
    }
  }

  const path = value.split(/[?#]/, 1)[0] ?? '';
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === 'string'
    ? resolve(reader.result)
    : reject(new Error('Unable to encode image'));
  reader.onerror = () => reject(reader.error ?? new Error('Unable to encode image'));
  reader.readAsDataURL(blob);
});

const hasImageSignature = async (blob: Blob, mimeType: string): Promise<boolean> => {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (mimeType === 'image/png') {
    return bytes[0] === 0x89 && ascii(1, 4) === 'PNG'
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  if (mimeType === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/gif') {
    const gif = ascii(0, 6);
    return gif === 'GIF87a' || gif === 'GIF89a';
  }
  return mimeType === 'image/webp' && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
};

const validateImageBlob = async (blob: Blob, mimeType: string): Promise<void> => {
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) throw new Error('Unsupported image type');
  if (blob.size > MAX_MARKDOWN_IMAGE_BYTES) throw new Error('Image is too large');
  if (!await hasImageSignature(blob, mimeType)) throw new Error('Unsupported image data');
};

const validateDataImage = async (source: string): Promise<void> => {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]*)$/i.exec(source);
  if (!match?.[1] || match[2] === undefined) throw new Error('Invalid image data URL');
  const encoded = match[2];
  if (encoded.length > Math.ceil(MAX_MARKDOWN_IMAGE_BYTES * 4 / 3) + 4) {
    throw new Error('Image is too large');
  }

  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error('Invalid image data URL');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  await validateImageBlob(new Blob([bytes]), match[1].toLowerCase());
};

export const resolveMarkdownImageSource = async (
  source: string,
  directory: string,
  signal: AbortSignal,
): Promise<string> => {
  if (signal.aborted) throw new DOMException('Image load aborted', 'AbortError');
  if (/^(?:https?:)?\/\//i.test(source)) return source;

  if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(source)) {
    await validateDataImage(source);
    if (signal.aborted) throw new DOMException('Image load aborted', 'AbortError');
    return source;
  }

  const localPath = parseLocalImagePath(source);
  const absolutePath = toAbsoluteFilePath(directory, localPath);
  if (!directory || !localPath || !isFilePathWithinDirectory(absolutePath, directory)) {
    throw new Error('Image path is outside the active workspace');
  }

  const statResponse = await runtimeFetch('/api/fs/stat', {
    query: { path: absolutePath, directory, optional: 'true' },
    signal,
  });
  if (!statResponse.ok) throw new Error(`Unable to inspect image (${statResponse.status})`);
  const stat = await statResponse.json() as { isFile?: boolean; size?: number };
  if (!stat.isFile) throw new Error('Image path is not a file');
  if (typeof stat.size === 'number' && stat.size > MAX_MARKDOWN_IMAGE_BYTES) {
    throw new Error('Image is too large');
  }

  const response = await runtimeFetch('/api/fs/raw', {
    query: { path: absolutePath, directory },
    signal,
  });
  if (!response.ok) throw new Error(`Unable to load image (${response.status})`);

  const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.toLowerCase() ?? '';
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_MARKDOWN_IMAGE_BYTES) {
    throw new Error('Image is too large');
  }

  const blob = await response.blob();
  await validateImageBlob(blob, mimeType);
  return blobToDataUrl(blob);
};
