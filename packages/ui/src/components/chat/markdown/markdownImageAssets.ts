import { runtimeFetch } from '@/lib/runtime-fetch';
import { readAssetBlob } from '@/lib/runtime-asset';
import { getRuntimeUrlResolver, type RuntimeUrlResolver } from '@/lib/runtime-url';
import { isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import { z } from 'zod';

export const MAX_MARKDOWN_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const VIDEO_EXTENSION_RE = /\.(?:mp4|m4v|mov|webm)$/i;
const MAX_PREPARE_CACHE_ENTRIES = 1024;
const NON_READY_CACHE_MS = 30_000;
const OUTSIDE_IMAGE_CACHE_MS = 10 * 60 * 1000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export type PreparedMarkdownImage =
  | { status: 'ready'; path: string; outsideWorkspace: boolean }
  | { status: 'missing' | 'error' };

const fileStat = z.union([z.object({
  isFile: z.literal(true),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
}), z.object({ exists: z.literal(false) })]);

type PrepareCacheEntry = {
  result: Map<string, PreparedMarkdownImage> | null;
  expiresAt: number;
};

const prepareCaches = new WeakMap<RuntimeUrlResolver, Map<string, PrepareCacheEntry>>();

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new DOMException('Image load aborted', 'AbortError');
};

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
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      resolve(reader.result);
    } else {
      reject(new Error('Unable to encode image'));
    }
  };
  reader.onerror = () => reject(reader.error ?? new Error('Unable to encode image'));
  reader.readAsDataURL(blob);
});

const hasImageSignature = async (blob: Blob, mimeType: string): Promise<boolean> => {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  switch (mimeType) {
    case 'image/png':
      return bytes[0] === 0x89 && ascii(1, 4) === 'PNG'
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif': {
      const gif = ascii(0, 6);
      return gif === 'GIF87a' || gif === 'GIF89a';
    }
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    default:
      return false;
  }
};

const validateImageBlob = async (blob: Blob, mimeType: string): Promise<void> => {
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) throw new Error('Unsupported image type');
  if (blob.size > MAX_MARKDOWN_IMAGE_BYTES) throw new Error('Image is too large');
  if (!await hasImageSignature(blob, mimeType)) throw new Error('Unsupported image data');
};

const validateDataImage = async (source: string): Promise<void> => {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]*)$/i.exec(source);
  if (!match?.[1] || match[2] === undefined) throw new Error('Invalid image data URL');
  if (match[2].length > Math.ceil(MAX_MARKDOWN_IMAGE_BYTES * 4 / 3) + 4) throw new Error('Image is too large');
  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    throw new Error('Invalid image data URL');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  await validateImageBlob(new Blob([bytes]), match[1].toLowerCase());
};

export const isLocalMarkdownImageSource = (source: string): boolean => (
  !/^(?:https?:)?\/\//i.test(source)
  && !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(source)
);

export const prepareLocalMarkdownImages = async ({
  sources,
  directory,
  sessionId,
  messageId,
  signal,
  refresh = false,
}: {
  sources: readonly string[];
  directory: string;
  sessionId: string;
  messageId: string;
  signal: AbortSignal;
  refresh?: boolean;
}): Promise<Map<string, PreparedMarkdownImage>> => {
  const resolver = getRuntimeUrlResolver();
  let cache = prepareCaches.get(resolver);
  if (!cache) {
    cache = new Map();
    prepareCaches.set(resolver, cache);
  }
  throwIfAborted(signal);
  const key = `${sessionId}\0${messageId}\0${directory}\0${sources.join('\0')}`;
  const cached = cache.get(key);
  if (!refresh && cached?.result && cached.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.result;
  }
  if (cached) cache.delete(key);
  while (cache.size >= MAX_PREPARE_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  const entry: PrepareCacheEntry = { result: null, expiresAt: 0 };
  cache.set(key, entry);

  const prepared = new Map<string, PreparedMarkdownImage>();
  for (const source of new Set(sources)) {
    throwIfAborted(signal);
    try {
      const localPath = parseLocalImagePath(source);
      if (!directory || !localPath) throw new Error('Missing image path');
      const path = toAbsoluteFilePath(directory, localPath);
      const response = await runtimeFetch('/api/fs/stat', {
        query: { path, directory, optional: 'true', allowOutsideWorkspace: 'true' },
        signal,
      });
      if (!response.ok) throw new Error(`Unable to inspect media (${response.status})`);
      const stat = fileStat.parse(await response.json());
      if ('exists' in stat) {
        prepared.set(source, { status: 'missing' });
        continue;
      }
      const video = VIDEO_EXTENSION_RE.test(path);
      if (stat.size > (video ? MAX_VIDEO_BYTES : MAX_MARKDOWN_IMAGE_BYTES)) {
        throw new Error('Media file is too large');
      }
      prepared.set(source, { status: 'ready', path: stat.path, outsideWorkspace: !isFilePathWithinDirectory(stat.path, directory) });
    } catch {
      prepared.set(source, { status: 'error' });
    }
  }
  throwIfAborted(signal);
  const allReady = [...prepared.values()].every((value) => value.status === 'ready');
  const hasOutsideImage = [...prepared.values()].some((value) => value.status === 'ready' && value.outsideWorkspace);
  // A later refresh owns this slot even when an older, independent read finishes last.
  if (cache.get(key) === entry) {
    entry.result = prepared;
    entry.expiresAt = !allReady ? Date.now() + NON_READY_CACHE_MS
      : hasOutsideImage ? Date.now() + OUTSIDE_IMAGE_CACHE_MS : Number.POSITIVE_INFINITY;
  }
  return prepared;
};

export const resolveMarkdownImageSource = async (
  source: string,
  signal: AbortSignal,
): Promise<string> => {
  throwIfAborted(signal);
  if (/^(?:https?:)?\/\//i.test(source)) return source;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(source)) {
    await validateDataImage(source);
    throwIfAborted(signal);
    return source;
  }
  throw new Error('Local image has not been prepared');
};

/**
 * Reads and validates image bytes through `/api/fs/raw`. HtmlView embeds these
 * bytes because its opaque origin cannot use the authenticated asset URL.
 */
const loadRawImage = async (
  query: { path: string; directory: string; allowOutsideWorkspace?: string },
  signal: AbortSignal,
): Promise<Blob> => {
  const response = await runtimeFetch('/api/fs/raw', { query, signal });
  if (!response.ok) throw new Error(`Unable to load image (${response.status})`);

  const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.toLowerCase() ?? '';
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_MARKDOWN_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error('Image is too large');
  }
  const blob = await readAssetBlob(response, MAX_MARKDOWN_IMAGE_BYTES, signal);
  await validateImageBlob(blob, mimeType);
  throwIfAborted(signal);
  return blob;
};

/**
 * VS Code uses its workspace-only gallery path through the local
 * filesystem bridge, including the same size and signature validation.
 */
export const resolveWorkspaceMarkdownImageSource = async (
  source: string,
  directory: string,
  signal: AbortSignal,
): Promise<string> => {
  throwIfAborted(signal);
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

  return blobToDataUrl(await loadRawImage({ path: absolutePath, directory }, signal));
};

export const getPreparedMarkdownImageUrl = (
  image: Extract<PreparedMarkdownImage, { status: 'ready' }>,
  directory: string,
): string => getRuntimeUrlResolver().authenticatedAsset(
  '/api/fs/raw',
  {
    path: image.path,
    directory,
    allowOutsideWorkspace: image.outsideWorkspace ? 'true' : undefined,
  },
  );

/** Loads the full validated image for saving. */
export const loadMessageImageBlob = async ({ source, directory, sessionId, messageId, signal }: {
  source: string; directory: string; sessionId: string; messageId: string; signal: AbortSignal;
}): Promise<Blob> => {
  const resolver = getRuntimeUrlResolver();
  const prepared = (await prepareLocalMarkdownImages({ sources: [source], directory, sessionId, messageId, signal })).get(source);
  if (prepared?.status !== 'ready') throw new Error('Image is unavailable');
  if (getRuntimeUrlResolver() !== resolver) throw new DOMException('Runtime changed', 'AbortError');
  return loadRawImage({ path: prepared.path, directory, allowOutsideWorkspace: prepared.outsideWorkspace ? 'true' : undefined }, signal);
};

/** A validated image and its byte size, or null when it exceeds the page's remaining budget. */
export const loadPreparedImageAsDataUrl = async (
  image: Extract<PreparedMarkdownImage, { status: 'ready' }>,
  directory: string,
  signal: AbortSignal,
  remainingBytes: number,
): Promise<{ url: string; size: number } | null> => {
  const blob = await loadRawImage({
    path: image.path,
    directory,
    allowOutsideWorkspace: image.outsideWorkspace ? 'true' : undefined,
  }, signal);
  if (blob.size > remainingBytes) return null;
  return { url: await blobToDataUrl(blob), size: blob.size };
};
