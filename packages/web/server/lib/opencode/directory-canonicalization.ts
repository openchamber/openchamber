import fs from 'node:fs/promises';
import path from 'node:path';

import { directoryReachability } from '../directory-reachability/index.js';
import { createRealpathCache } from '../path-realpath-cache.js';
import type { RealpathCacheOptions } from '../path-realpath-cache.js';
import { isString } from '../shared/object-guards.js';

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

export type CanonicalizeDirectory = (directory: string) => Promise<string>;
export type SessionDirectoryCanonicalizer = () => CanonicalizeDirectory | null;

export const isInsideDirectory = (directory: string, root: string | null | undefined) => {
  if (!isString(root) || root.length === 0) {
    return false;
  }

  const relative = path.relative(path.resolve(root), path.resolve(directory));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export const createSessionDirectoryCanonicalizer = ({
  sharesFilesystem,
  realpath = async (directory) => {
    await directoryReachability.assertReachable(directory);
    return fs.realpath(directory);
  },
}: {
  sharesFilesystem: () => boolean;
  realpath?: CanonicalizeDirectory;
}): SessionDirectoryCanonicalizer => {
  const canonicalize: CanonicalizeDirectory = async (directory) => {
    if (!path.isAbsolute(directory)) return directory;
    return await realpath(directory).catch(() => directory);
  };
  return () => (sharesFilesystem() ? canonicalize : null);
};

export const canonicalizeWith = async (canonicalize: CanonicalizeDirectory | null | undefined, directory: string) => (
  canonicalize ? await canonicalize(directory) : directory
);

export const canonicalizeMoveBodyDirectory = async <Body>(
  body: Body,
  canonicalize: CanonicalizeDirectory,
): Promise<Body> => {
  if (!isObject(body) || !isString(body.directory)) {
    return body;
  }
  const canonical = await canonicalize(body.directory);
  return canonical === body.directory ? body : { ...body, directory: canonical };
};

export const canonicalizeCreateBodyDirectory = async <Body>(
  body: Body,
  canonicalize: CanonicalizeDirectory,
  chatsRoot: string | null | undefined,
): Promise<Body> => {
  if (!isObject(body)) {
    return body;
  }
  const location = body.location;
  if (!isObject(location) || !isString(location.directory)) {
    return body;
  }
  const directory = location.directory;
  if (isInsideDirectory(directory, chatsRoot)) {
    return body;
  }
  const canonical = await canonicalize(directory);
  if (canonical === directory) {
    return body;
  }
  return { ...body, location: { ...location, directory: canonical } };
};

type CreateBodyRefusal = { status: 400 | 413; body: { error: string } };

export const readCanonicalCreateBody = async <Body>(
  readBody: () => Promise<Body>,
  canonicalize: CanonicalizeDirectory,
  chatsRoot: string | null | undefined,
): Promise<{ body: Body; refusal?: never } | { refusal: CreateBodyRefusal; body?: never }> => {
  let body: Body;
  try {
    body = await readBody();
  } catch (error) {
    const tooLarge = isObject(error) && error.status === 413;
    return { refusal: tooLarge
      ? { status: 413, body: { error: 'Session create body is too large' } }
      : { status: 400, body: { error: 'Session create body is not valid JSON' } } };
  }
  return { body: await canonicalizeCreateBodyDirectory(body, canonicalize, chatsRoot) };
};

export const createDirectoryQueryCanonicalizer = ({ realpath, checkDirectory = directoryReachability.check, ...cacheOptions }: RealpathCacheOptions & { checkDirectory?: typeof directoryReachability.check } = {}) => {
  const realpathCache = createRealpathCache({ fallbackOnError: true, realpath, ...cacheOptions });

  return async (requestUrl: string) => {
    if (!requestUrl.includes('directory=')) {
      return requestUrl;
    }

    const url = new URL(requestUrl, 'http://localhost');
    const directory = url.searchParams.get('directory');
    if (!directory) {
      return requestUrl;
    }

    if (await checkDirectory(directory) === 'unreachable') return requestUrl;
    const canonicalDirectory = await realpathCache.resolve(directory);
    if (!canonicalDirectory || canonicalDirectory === directory) {
      return requestUrl;
    }

    url.searchParams.set('directory', canonicalDirectory);
    return `${url.pathname}${url.search}`;
  };
};
