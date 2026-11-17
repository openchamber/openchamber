import fs from 'fs';
import os from 'os';
import path from 'path';

export const unsupportedRepositoryRootReason = (repoRoot, home = os.homedir()) => {
  const root = String(repoRoot ?? '').trim();
  if (!root) return null;
  const resolved = path.resolve(root);
  if (path.resolve(path.parse(resolved).root) === resolved) return 'filesystem-root';
  const homeRoot = String(home ?? '').trim();
  if (homeRoot && path.resolve(homeRoot) === resolved) return 'home';
  return null;
};

export const primaryWorktreeRootFromGitDir = (gitDir) => {
  if (!gitDir) return null;
  if (gitDir.endsWith('/.git')) {
    return gitDir.slice(0, -'/.git'.length) || null;
  }
  const markerIndex = gitDir.indexOf('/.git/worktrees/');
  if (markerIndex > 0) {
    return gitDir.slice(0, markerIndex) || null;
  }
  return null;
};

const decodeOnce = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

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

export const vcsInitRefusalBody = (message) => ({ _tag: 'InvalidRequestError', message, field: 'location' });
