import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * A repository whose root is the user's home directory or a filesystem root
 * (`C:\`, `/`) covers the whole disk. Every status read walks Program Files
 * or the entire home tree, which is minutes of Git work per refresh and, on
 * Windows, the process pile-ups users report. Such a repository is nearly
 * always an accidental `git init` in the wrong place, so OpenChamber treats
 * it as no repository at all. Returns the reason or null for a normal root.
 */
export const unsupportedRepositoryRootReason = (repoRoot, home = os.homedir()) => {
  const root = String(repoRoot ?? '').trim();
  if (!root) return null;
  const resolved = path.resolve(root);
  if (path.resolve(path.parse(resolved).root) === resolved) return 'filesystem-root';
  const homeRoot = String(home ?? '').trim();
  if (homeRoot && path.resolve(homeRoot) === resolved) return 'home';
  return null;
};

// OpenCode decodes the header once and falls back to the raw value; a value
// the browser had to re-encode carries the `uri` hint and one more layer.
const decodeOnce = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// Split by hand: `new URL('//api/vcs/init', base)` would read `api` as a host.
const splitRequestUrl = (requestUrl) => {
  const raw = String(requestUrl).split('#')[0];
  const queryIndex = raw.indexOf('?');
  return queryIndex === -1
    ? { pathname: raw, query: new URLSearchParams() }
    : { pathname: raw.slice(0, queryIndex), query: new URLSearchParams(raw.slice(queryIndex + 1)) };
};

const isVcsInitPath = (pathname) => {
  const segments = pathname.split(/[\\/]/).filter(Boolean)
    .map((segment) => decodeOnce(segment.split(';')[0]).toLowerCase());
  return segments.length === 3 && segments[0] === 'api' && segments[1] === 'vcs' && segments[2] === 'init';
};

const requestDirectory = (query, headers) => {
  const fromQuery = query.get('location[directory]');
  if (fromQuery) return fromQuery;
  // Node hands a repeated header over as an array; OpenCode reads the first.
  const header = [headers?.['x-opencode-directory']].flat().find(Boolean);
  if (!header) return null;
  const unwrapped = headers['x-opencode-directory-encoding'] === 'uri' ? decodeOnce(String(header)) : String(header);
  return decodeOnce(unwrapped);
};

const realDirectory = (directory) => {
  try {
    return fs.realpathSync.native(directory);
  } catch {
    return path.resolve(directory);
  }
};

/**
 * OpenCode's `POST /api/vcs/init` runs `git init` in the directory the request
 * resolves to, and a request without one resolves to OpenCode's own working
 * directory, the user's home for a managed OpenCode. Returns the refusal
 * message for a request that would create a repository OpenChamber then
 * ignores (home, filesystem root, or no directory at all), or null when the
 * request is not a VCS init or may go through.
 */
export const vcsInitRefusal = (method, requestUrl, headers, home = os.homedir()) => {
  if (String(method).toUpperCase() !== 'POST') return null;
  const { pathname, query } = splitRequestUrl(requestUrl);
  if (!isVcsInitPath(pathname)) return null;
  const directory = requestDirectory(query, headers);
  if (!directory) return 'Choose a project directory before initializing Git.';
  const reason = unsupportedRepositoryRootReason(realDirectory(directory), home ? realDirectory(home) : home);
  if (reason === 'home') return 'Git is not initialized in the home directory: a repository there covers every file you own.';
  if (reason === 'filesystem-root') return 'Git is not initialized at the root of a disk.';
  return null;
};

/** The body OpenCode itself answers a refused request with, so clients read the message. */
export const vcsInitRefusalBody = (message) => ({ _tag: 'InvalidRequestError', message, field: 'location' });
