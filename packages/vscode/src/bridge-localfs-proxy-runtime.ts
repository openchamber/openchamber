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

const buildProxyJsonError = (status: number, error: string): ApiProxyResponsePayload => ({
  status,
  headers: { 'content-type': 'application/json' },
  bodyBase64: base64EncodeUtf8(JSON.stringify({ error })),
});

export const tryHandleLocalFsProxy = async (method: string, requestPath: string): Promise<ApiProxyResponsePayload | null> => {
  let parsed: URL;
  try {
    parsed = new URL(requestPath, 'https://openchamber.local');
  } catch {
    return buildProxyJsonError(400, 'Invalid request path');
  }

  if (parsed.pathname !== '/api/fs/stat' && parsed.pathname !== '/api/fs/read' && parsed.pathname !== '/api/fs/raw') {
    return null;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return buildProxyJsonError(405, 'Method not allowed');
  }

  const targetPath = parsed.searchParams.get('path') || '';
  const resolution: FsReadPathResolution = await resolveFileReadPath(targetPath);
  if (!resolution.ok) {
    return buildProxyJsonError(resolution.status, resolution.error);
  }

  try {
    const stats = await fs.promises.stat(resolution.resolvedPath);
    if (!stats.isFile()) {
      return buildProxyJsonError(400, 'Specified path is not a file');
    }

    if (parsed.pathname === '/api/fs/stat') {
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

    if (parsed.pathname === '/api/fs/read') {
      const content = await fs.promises.readFile(resolution.resolvedPath, 'utf8');
      return {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
        bodyBase64: base64EncodeUtf8(content),
      };
    }

    const raw = await fs.promises.readFile(resolution.resolvedPath);
    return {
      status: 200,
      headers: {
        'content-type': getFsMimeType(resolution.resolvedPath),
        'cache-control': 'no-store',
      },
      bodyBase64: Buffer.from(raw).toString('base64'),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      return buildProxyJsonError(404, 'File not found');
    }
    if (parsed.pathname === '/api/fs/stat') {
      return buildProxyJsonError(500, 'Unable to stat file');
    }
    return buildProxyJsonError(500, 'Unable to read file');
  }
};
