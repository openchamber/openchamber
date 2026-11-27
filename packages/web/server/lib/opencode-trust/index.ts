import fs from 'fs';
import os from 'os';
import path from 'path';

import { z } from 'zod';

import { DIRECTORY_UNREACHABLE, directoryReachability, directoryUnreachableError } from '../directory-reachability/index.js';
import { assessOpenCodeConfig } from './assessment.js';
import { createOpenCodeTrustStore, hasMessage } from './store.js';
import type { ConfigAssessment, OpenCodeTrustAssessment, OpenCodeTrustAnswer, OpenCodeTrustRequest, OpenCodeTrustRouteRequest, ReadTrustBody, TrustOptions } from './contracts.js';

export type { OpenCodeTrust, OpenCodeTrustItemKind, OpenCodeTrustItem, OpenCodeTrustAssessment, OpenCodeTrustRefusal, OpenCodeTrustAnswer, OpenCodeTrustJsonBody, OpenCodeTrustRequest, OpenCodeTrustRouteRequest } from './contracts.js';

export const OPENCODE_TRUST_REQUIRED = 'opencode_trust_required';
export const OPENCODE_TRUST_ROUTE = '/api/opencode/trust';

const TRUST_REQUIRED_ERROR = 'OpenCode is paused for this folder until you trust the plugins and commands in its configuration';

const ASSESSMENT_CACHE_MS = 2000;
const ASSESSMENT_CACHE_LIMIT = 200;
const SEED_PROJECT_TIMEOUT_MS = 2000;

const GLOBAL_READS = [
  /^\/api\/session$/,
  /^\/api\/session\/active$/,
  /^\/api\/experimental\/session\/stats$/,
  /^\/api\/session\/[^/]+$/,
  /^\/api\/session\/[^/]+\/message(?:\/[^/]+)?$/,
  /^\/api\/(?:global\/)?event$/,
  /^\/api\/credential(?:\/|$)/,
];
const GLOBAL_MUTATIONS = [
  { method: 'DELETE', pattern: /^\/api\/session\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/session\/[^/]+\/view$/ },
  { method: 'DELETE', pattern: /^\/api\/debug\/location$/ },
];
const SESSION_MOVE = /^\/api\/session\/([^/]+)\/move$/;
const MOVE_BODY_ERROR = 'A session move needs a JSON body naming its directory';
const moveBodySchema = z.object({ directory: z.string() });

const SESSION_SCOPED = /^\/api\/(?:experimental\/)?session\/([^/]+)\/.+$/;
const LOCATION_SCOPED_FORM_OWNER = 'global';

const trustQuerySchema = z.object({ directory: z.string().trim().min(1) });
const trustAnswerSchema = z.object({ directory: z.string().trim().min(1), fingerprint: z.string().nullable() });
const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

export const isGlobalRead = (method: string, pathname: string) => (
  (method === 'GET' || method === 'HEAD') && GLOBAL_READS.some((pattern) => pattern.test(pathname))
);

const isGlobalRoute = (method: string, pathname: string) => (
  isGlobalRead(method, pathname)
    || GLOBAL_MUTATIONS.some((route) => route.method === method && route.pattern.test(pathname))
);

const directoriesNamedBy = (url: URL, headers: Record<string, string | undefined>) => {
  const directories = [...url.searchParams.getAll('directory'), ...url.searchParams.getAll('location[directory]')];
  const header = headers['x-opencode-directory'];
  if (header) {
    let directory = header;
    if (headers['x-opencode-directory-encoding'] === 'uri' || PERCENT_ESCAPE.test(header)) {
      try {
        directory = decodeURIComponent(header);
      } catch {
        directory = header;
      }
    }
    directories.push(directory);
  }
  return directories;
};

const bodyOrNothing = async (readBody: ReadTrustBody | undefined) => {
  try {
    return await readBody?.();
  } catch {
    return undefined;
  }
};

export const sessionMoveOf = (method: string, pathname: string) => {
  if (String(method || '').toUpperCase() !== 'POST') return null;
  const sessionID = SESSION_MOVE.exec(pathname)?.[1];
  if (!sessionID) return null;
  try {
    return decodeURIComponent(sessionID);
  } catch {
    return sessionID;
  }
};

export const readMoveDestination = async (readBody: ReadTrustBody | undefined, sessionDirectory: string | null, homeDirectory = os.homedir()): Promise<
  { refusal: OpenCodeTrustAnswer; destination?: never } | { refusal?: never; destination: string | null }
> => {
  const parsed = moveBodySchema.safeParse(await bodyOrNothing(readBody));
  if (!parsed.success) return { refusal: { status: 400, body: { error: MOVE_BODY_ERROR } } };
  const value = parsed.data.directory.trim();
  const expanded = value === '~'
    ? homeDirectory
    : value.startsWith('~/') ? path.join(homeDirectory, value.slice(2)) : value;
  if (sessionDirectory) return { destination: path.resolve(sessionDirectory, expanded) };
  return { destination: path.isAbsolute(expanded) ? expanded : null };
};

const lowercaseKeys = (headers: OpenCodeTrustRequest['headers']) => Object.fromEntries(
  Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value[0] : value]),
);

const publicAssessment = (assessment: ConfigAssessment, trusted: boolean): OpenCodeTrustAssessment => ({
  directory: assessment.directory,
  trusted,
  fingerprint: assessment.fingerprint,
  items: assessment.items.map(({ kind, source, name, detail }) => ({ kind, source, name, detail })),
});

export const createOpenCodeTrust = ({
  storePath,
  listKnownDirectories = null,
  homeDirectory = os.homedir(),
  fsPromises = fs.promises,
  now = Date.now,
  checkDirectory = directoryReachability.check,
}: TrustOptions) => {
  const store = createOpenCodeTrustStore({ filePath: storePath, fsPromises });
  type Evaluation = { assessment: ConfigAssessment; trusted: boolean };
  interface CacheEntry {
    at: number;
    result: Promise<Evaluation>;
    trusted: boolean | null;
    resolved: string | null;
  }
  const cache = new Map<string, CacheEntry>();

  let seeding: Promise<void> | null = null;
  const assessWithin = (directory: string) => Promise.race([
    checkDirectory(directory).then((reachability) => (
      reachability === 'unreachable' ? null : assessOpenCodeConfig(directory, { fsPromises, homeDirectory })
    )).catch(() => null),
    new Promise<null>((resolve) => { setTimeout(resolve, SEED_PROJECT_TIMEOUT_MS, null).unref?.(); }),
  ]);
  const seedKnown = async () => {
    if (!listKnownDirectories || await store.isSeeded()) return;
    const assessments = await Promise.all((await listKnownDirectories()).map(assessWithin));
    await store.seed(assessments.flatMap((assessment): [string, string][] => (
      assessment?.fingerprint ? [[assessment.repositoryKey, assessment.fingerprint]] : []
    )));
  };
  const ensureSeeded = () => {
    seeding ??= seedKnown().catch((error) => {
      console.warn('[opencode-trust] Could not trust the existing projects:', hasMessage(error) ? error.message ?? error : error);
    });
    return seeding;
  };

  const evaluate = async (directory: string) => {
    await ensureSeeded();
    if (await checkDirectory(directory) === 'unreachable') throw directoryUnreachableError(directory);
    const assessment = await assessOpenCodeConfig(directory, { fsPromises, homeDirectory });
    const trusted = assessment.fingerprint === null || await store.has(assessment.repositoryKey, assessment.fingerprint);
    return { assessment, trusted };
  };

  let followsLocations = false;

  const isFresh = (entry: CacheEntry) => (
    (followsLocations && entry.trusted === true) || now() - entry.at < ASSESSMENT_CACHE_MS
  );

  const assess = (directory: string, { fresh = false } = {}) => {
    const cached = cache.get(directory);
    if (!fresh && cached && isFresh(cached)) return cached.result;
    const result = evaluate(directory);
    const entry: CacheEntry = { at: now(), result, trusted: null, resolved: null };
    cache.delete(directory);
    cache.set(directory, entry);
    if (cache.size > ASSESSMENT_CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    result.then((answer) => {
      entry.trusted = answer.trusted;
      entry.resolved = answer.assessment.directory;
    }, () => cache.delete(directory));
    return result;
  };

  const forget = async (directory: string) => {
    const resolved = await checkDirectory(directory) === 'unreachable'
      ? directory
      : await fsPromises.realpath(directory).catch(() => directory);
    for (const [key, entry] of cache) {
      if ([key, entry.resolved].some((name) => name === directory || name === resolved)) cache.delete(key);
    }
  };

  const followLocations = (following: boolean) => {
    if (following) cache.clear();
    followsLocations = following;
  };

  const firstUntrusted = async (directories: string[]) => {
    for (const directory of new Set(directories)) {
      const { assessment, trusted } = await assess(directory);
      if (!trusted) return assessment;
    }
    return null;
  };

  const isTrusted = async (directory: string) => (await assess(directory)).trusted;

  const trust = async (directory: string, fingerprint: string | null) => {
    const { assessment, trusted } = await assess(directory, { fresh: true });
    if (assessment.fingerprint !== fingerprint) {
      return { ok: false, assessment: publicAssessment(assessment, trusted) };
    }
    if (!trusted && assessment.fingerprint !== null) await store.add(assessment.repositoryKey, assessment.fingerprint);
    cache.delete(directory);
    return { ok: true, assessment: publicAssessment(assessment, true) };
  };

  const refusalFor = async ({ method, path: requestPath, headers, resolveSessionDirectory, readBody }: OpenCodeTrustRequest): Promise<OpenCodeTrustAnswer | null> => {
    const url = new URL(requestPath, 'http://opencode.invalid');
    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (isGlobalRoute(normalizedMethod, url.pathname)) return null;
    const directories = directoriesNamedBy(url, lowercaseKeys(headers));
    const sessionID = SESSION_SCOPED.exec(url.pathname)?.[1];
    const isMove = sessionMoveOf(normalizedMethod, url.pathname) !== null;
    let sessionDirectory: string | null = null;
    if (sessionID && sessionID !== LOCATION_SCOPED_FORM_OWNER && resolveSessionDirectory) {
      try {
        sessionDirectory = await resolveSessionDirectory(decodeURIComponent(sessionID), { fresh: isMove });
      } catch {
        return { status: 503, body: { error: 'Could not check whether this session\'s folder is trusted' } };
      }
      if (sessionDirectory) directories.push(sessionDirectory);
    }
    if (isMove) {
      const { refusal, destination } = await readMoveDestination(readBody, sessionDirectory, homeDirectory);
      if (refusal) return refusal;
      if (destination) directories.unshift(destination);
    }
    if (directories.length === 0) return null;
    for (const directory of new Set(directories)) {
      if (await checkDirectory(directory) === 'unreachable') {
        return { status: 503, body: { error: directoryUnreachableError(directory).message, code: DIRECTORY_UNREACHABLE, directory } };
      }
    }
    const untrusted = await firstUntrusted(directories);
    if (!untrusted) return null;
    return {
      status: 403,
      body: { error: TRUST_REQUIRED_ERROR, code: OPENCODE_TRUST_REQUIRED, directory: untrusted.directory },
    };
  };

  const handleRoute = async ({ method, query, body }: OpenCodeTrustRouteRequest): Promise<OpenCodeTrustAnswer> => {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (normalizedMethod === 'GET') {
      const parsed = trustQuerySchema.safeParse(query);
      if (!parsed.success) return { status: 400, body: { error: 'directory is required' } };
      const { assessment, trusted } = await assess(parsed.data.directory, { fresh: true });
      return { status: 200, body: publicAssessment(assessment, trusted) };
    }
    if (normalizedMethod === 'POST') {
      const parsed = trustAnswerSchema.safeParse(body);
      if (!parsed.success) return { status: 400, body: { error: 'directory and fingerprint are required' } };
      const result = await trust(parsed.data.directory, parsed.data.fingerprint);
      return result.ok
        ? { status: 200, body: result.assessment }
        : { status: 409, body: { error: 'The configuration changed since it was shown', ...result.assessment } };
    }
    return { status: 405, body: { error: 'Method not allowed' } };
  };

  return { assess, isTrusted, firstUntrusted, trust, refusalFor, handleRoute, forget, followLocations };
};
