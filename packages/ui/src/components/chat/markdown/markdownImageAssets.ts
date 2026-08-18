import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver, type RuntimeUrlResolver } from '@/lib/runtime-url';
import { isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';

const MAX_MARKDOWN_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PREPARE_CACHE_ENTRIES = 1024;
const NON_READY_CACHE_MS = 30_000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export type PreparedMarkdownImage =
  | { status: 'ready'; path: string; outsideFileGrant?: string; expiresAt?: number }
  | { status: 'missing' | 'error' };

type PrepareCacheEntry = {
  result: Map<string, PreparedMarkdownImage>;
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
}: {
  sources: readonly string[];
  directory: string;
  sessionId: string;
  messageId: string;
  signal: AbortSignal;
}): Promise<Map<string, PreparedMarkdownImage>> => {
  const resolver = getRuntimeUrlResolver();
  let cache = prepareCaches.get(resolver);
  if (!cache) {
    cache = new Map();
    prepareCaches.set(resolver, cache);
  }
  const key = `${sessionId}\0${messageId}\0${directory}\0${sources.join('\0')}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.result;
  }
  if (cached) cache.delete(key);

  const response = await runtimeFetch(
    `/api/openchamber/sessions/${encodeURIComponent(sessionId)}/markdown-image-grants`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory, messageId, sources }),
      signal,
    },
  );
  if (!response.ok) throw new Error(`Unable to prepare images (${response.status})`);
  const payload = await response.json() as {
    results?: Array<{
      source?: string;
      status?: string;
      path?: string;
      outsideFileGrant?: string;
      expiresAt?: number;
    }>;
  };
  const prepared = new Map<string, PreparedMarkdownImage>();
  for (const result of payload.results ?? []) {
    if (!result.source) continue;
    if (result.status === 'ready' && result.path) {
      prepared.set(result.source, {
        status: 'ready',
        path: result.path,
        outsideFileGrant: result.outsideFileGrant,
        expiresAt: result.expiresAt,
      });
    } else if (result.status === 'missing') {
      prepared.set(result.source, { status: 'missing' });
    } else {
      prepared.set(result.source, { status: 'error' });
    }
  }
  for (const source of sources) {
    if (!prepared.has(source)) prepared.set(source, { status: 'error' });
  }
  while (cache.size >= MAX_PREPARE_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  const allReady = [...prepared.values()].every((value) => value.status === 'ready');
  const grantExpiry = Math.min(...[...prepared.values()]
    .filter((value): value is Extract<PreparedMarkdownImage, { status: 'ready' }> => value.status === 'ready')
    .map((value) => value.expiresAt ?? Number.POSITIVE_INFINITY));
  cache.set(key, {
    result: prepared,
    expiresAt: allReady ? grantExpiry : Date.now() + NON_READY_CACHE_MS,
  });
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
 * VS Code has no OpenChamber server route for message-scoped temporary-file
 * grants. Preserve its existing workspace-only gallery path through the local
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
  throwIfAborted(signal);
  return blobToDataUrl(blob);
};

export const getPreparedMarkdownImageUrl = (
  image: Extract<PreparedMarkdownImage, { status: 'ready' }>,
  directory: string,
): string => getRuntimeUrlResolver().authenticatedAsset(
  '/api/fs/raw',
  {
    path: image.path,
    directory,
    allowOutsideWorkspace: image.outsideFileGrant ? 'true' : undefined,
    outsideFileGrant: image.outsideFileGrant,
  },
  );
