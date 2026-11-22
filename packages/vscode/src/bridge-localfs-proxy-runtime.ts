import * as fs from 'fs';
import { getFsMimeType, normalizeFsPath, resolveFileReadPath, type FsReadPathResolution } from './bridge-fs-helpers-runtime';

type ApiProxyResponsePayload = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

export const base64EncodeUtf8 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

export const collectHeaders = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

export const buildUnavailableApiResponse = (): ApiProxyResponsePayload => {
  const body = JSON.stringify({ error: 'OpenCode API unavailable' });
  return {
    status: 503,
    headers: { 'content-type': 'application/json' },
    bodyBase64: base64EncodeUtf8(body),
  };
};

export const sanitizeForwardHeaders = (input: Record<string, string> | undefined): Record<string, string> => {
  const headers: Record<string, string> = { ...(input || {}) };
  delete headers['content-length'];
  delete headers['host'];
  delete headers['connection'];
  return headers;
};

// Local-fs proxy read caps (#1027): the bridge answers with the whole file
// base64-encoded inside one JSON payload, so neither read route can stream
// and an uncapped file is held in memory several times over (Buffer, base64
// string, payload copy). The text route is capped tighter because its body
// is ALSO a UTF-8 string copy: 16 MiB of text is already a ~21 MiB payload,
// and no legitimate editor text file approaches it. The raw route serves
// the same previews/media as the web /api/fs/raw, so it takes the web
// preview cap MAX_SERVE_BYTES (packages/web/server/lib/fs/routes.js).
export const LOCAL_FS_READ_MAX_BYTES = 16 * 1024 * 1024;
export const LOCAL_FS_RAW_MAX_BYTES = 100 * 1024 * 1024;

// During-read bounded file read, mirroring the web server's shared
// standard (packages/web/server/lib/shared/bounded-file-read.js,
// design #1254), which this package cannot import: the cap is
// enforced during the read, judged from the opened handle, so a file
// grown past the cap after the caller's stat — or swapped for a
// non-regular file — is refused having buffered at most the cap + 1
// byte. O_NONBLOCK (POSIX only) keeps open() itself from blocking on
// a FIFO with no writer before the handle stat can reject it.
const readBoundedLocalFile = async (
  filePath: string,
  maxBytes: number,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: 'missing' | 'not-regular' | 'too-large' }> => {
  const openFlags = process.platform === 'win32' ? 'r' : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, openFlags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: false, reason: 'missing' };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'not-regular' };
    if (stat.size > maxBytes) return { ok: false, reason: 'too-large' };
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) return { ok: false, reason: 'too-large' };
    return { ok: true, buffer: Buffer.concat(chunks, total) };
  } finally {
    await handle.close();
  }
};

const throwMissingFile = (filePath: string): never => {
  const error = new Error('ENOENT: no such file or directory, open ' + filePath) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
};

const buildProxyJsonError = (status: number, error: string): ApiProxyResponsePayload => ({
  status,
  headers: { 'content-type': 'application/json' },
  bodyBase64: base64EncodeUtf8(JSON.stringify({ error })),
});

const normalizeFsProxyPath = (pathname: string): '/api/fs/stat' | '/api/fs/read' | '/api/fs/raw' | null => {
  if (pathname === '/api/fs/stat' || pathname === '/fs/stat') return '/api/fs/stat';
  if (pathname === '/api/fs/read' || pathname === '/fs/read') return '/api/fs/read';
  if (pathname === '/api/fs/raw' || pathname === '/fs/raw') return '/api/fs/raw';
  return null;
};

export const tryHandleLocalFsProxy = async (method: string, requestPath: string): Promise<ApiProxyResponsePayload | null> => {
  let parsed: URL;
  try {
    parsed = new URL(requestPath, 'https://openchamber.local');
  } catch {
    return buildProxyJsonError(400, 'Invalid request path');
  }

  const fsProxyPath = normalizeFsProxyPath(parsed.pathname);
  if (parsed.pathname === '/api/fs/directory-stat' || parsed.pathname === '/api/fs/directory-stats') {
    return buildProxyJsonError(501, 'Directory availability probes are not supported in the VS Code runtime');
  }
  if (/^\/api\/openchamber\/sessions\/[^/]+\/markdown-image-grants$/.test(parsed.pathname)) {
    return buildProxyJsonError(501, 'Markdown image grants are not supported in the VS Code runtime');
  }
  if (!fsProxyPath) {
    return null;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return buildProxyJsonError(405, 'Method not allowed');
  }

  const targetPath = parsed.searchParams.get('path') || '';
  const optional = parsed.searchParams.get('optional') === 'true';
  const resolution: FsReadPathResolution = await resolveFileReadPath(
    targetPath,
    parsed.searchParams.get('directory') || undefined,
  );
  if (!resolution.ok) {
    if (fsProxyPath === '/api/fs/stat' && optional && resolution.status === 404) {
      return {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
        bodyBase64: base64EncodeUtf8(JSON.stringify({ path: targetPath, exists: false })),
      };
    }
    return buildProxyJsonError(resolution.status, resolution.error);
  }

  try {
    const stats = await fs.promises.stat(resolution.resolvedPath);
    if (!stats.isFile()) {
      return buildProxyJsonError(400, 'Specified path is not a file');
    }

    if (fsProxyPath === '/api/fs/stat') {
      return {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
        bodyBase64: base64EncodeUtf8(JSON.stringify({
          path: normalizeFsPath(resolution.resolvedPath),
          isFile: true,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        })),
      };
    }

    if (fsProxyPath === '/api/fs/read') {
      if (stats.size > LOCAL_FS_READ_MAX_BYTES) {
        return buildProxyJsonError(413, `File exceeds maximum size of ${LOCAL_FS_READ_MAX_BYTES} bytes`);
      }
      const bounded = await readBoundedLocalFile(resolution.resolvedPath, LOCAL_FS_READ_MAX_BYTES);
      if (bounded.ok) {
        return {
          status: 200,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
          },
          bodyBase64: base64EncodeUtf8(bounded.buffer.toString('utf8')),
        };
      }
      if (bounded.reason === 'too-large') {
        return buildProxyJsonError(413, 'File exceeds maximum size of ' + LOCAL_FS_READ_MAX_BYTES + ' bytes');
      }
      if (bounded.reason === 'not-regular') {
        return buildProxyJsonError(400, 'Specified path is not a file');
      }
      throwMissingFile(resolution.resolvedPath);
    }

    if (stats.size > LOCAL_FS_RAW_MAX_BYTES) {
      return buildProxyJsonError(413, `File exceeds maximum size of ${LOCAL_FS_RAW_MAX_BYTES} bytes`);
    }

    const boundedRaw = await readBoundedLocalFile(resolution.resolvedPath, LOCAL_FS_RAW_MAX_BYTES);
    if (boundedRaw.ok) {
      return {
        status: 200,
        headers: {
          'content-type': getFsMimeType(resolution.resolvedPath),
          'cache-control': 'no-store',
        },
        bodyBase64: Buffer.from(boundedRaw.buffer).toString('base64'),
      };
    }
    if (boundedRaw.reason === 'too-large') {
      return buildProxyJsonError(413, 'File exceeds maximum size of ' + LOCAL_FS_RAW_MAX_BYTES + ' bytes');
    }
    if (boundedRaw.reason === 'not-regular') {
      return buildProxyJsonError(400, 'Specified path is not a file');
    }
    // 'missing': the file vanished between the stat and the read —
    // the same 404 the readFile ENOENT produced via the catch below.
    return buildProxyJsonError(404, 'File not found');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      if (fsProxyPath === '/api/fs/stat' && optional) {
        return {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
          bodyBase64: base64EncodeUtf8(JSON.stringify({ path: targetPath, exists: false })),
        };
      }
      return buildProxyJsonError(404, 'File not found');
    }
    if (fsProxyPath === '/api/fs/stat') {
      return buildProxyJsonError(500, 'Unable to stat file');
    }
    return buildProxyJsonError(500, 'Unable to read file');
  }
};
