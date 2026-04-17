import path from 'path';
import { IS_WIN } from './platform.js';

const trimTrailingSlash = (value) => {
  if (value === '/') {
    return value;
  }
  if (/^[A-Za-z]:[\\/]?$/.test(value)) {
    return value;
  }
  return value.replace(/[\\/]+$/, '');
};

const expandHomePath = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed === '~') {
    return process.env.HOME || process.env.USERPROFILE || trimmed;
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    const home = process.env.HOME || process.env.USERPROFILE;
    return home ? path.join(home, trimmed.slice(2)) : trimmed;
  }

  return trimmed;
};

export const canonicalPath = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const expanded = expandHomePath(value);
  if (typeof expanded !== 'string' || !expanded) {
    return expanded;
  }

  const nativeInput = IS_WIN && /^\/[A-Za-z](?:\/|$)/.test(expanded)
    ? expanded.replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive) => `${drive.toUpperCase()}:`)
    : expanded;

  let resolved = path.resolve(nativeInput).replace(/\\/g, '/');
  resolved = resolved.replace(/\/+/g, '/');

  if (IS_WIN) {
    resolved = resolved.replace(/^([A-Za-z]):(?=\/|$)/, (_, drive) => `/${drive.toLowerCase()}`);
  }

  return trimTrailingSlash(resolved) || '/';
};

export const toNativePath = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (!IS_WIN) {
    return trimmed;
  }

  return trimmed
    .replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive) => `${drive.toUpperCase()}:`)
    .replace(/\//g, '\\');
};

export const toDisplayPath = (value) => toNativePath(value);

export const pathsEqual = (left, right) => {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  if (typeof a !== 'string' || typeof b !== 'string') {
    return a === b;
  }
  return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
};

export const isSubpath = (candidate, parent) => {
  const childCanonical = canonicalPath(candidate);
  const parentCanonical = canonicalPath(parent);

  if (typeof childCanonical !== 'string' || typeof parentCanonical !== 'string') {
    return false;
  }

  if (pathsEqual(childCanonical, parentCanonical)) {
    return true;
  }

  const normalizedParent = parentCanonical === '/' ? '/' : `${parentCanonical}/`;
  const normalizedChild = childCanonical === '/' ? '/' : `${childCanonical}/`;
  const left = IS_WIN ? normalizedChild.toLowerCase() : normalizedChild;
  const right = IS_WIN ? normalizedParent.toLowerCase() : normalizedParent;
  return left.startsWith(right);
};

export const joinPosix = (...parts) => {
  const filtered = parts
    .filter((part) => typeof part === 'string' && part.length > 0)
    .map((part) => part.replace(/\\/g, '/'));

  if (filtered.length === 0) {
    return '';
  }

  return path.posix.join(...filtered);
};

export const longPathPrefix = (value) => {
  if (!IS_WIN || typeof value !== 'string' || !value.trim()) {
    return value;
  }

  const nativePath = path.resolve(toNativePath(value));
  return nativePath.startsWith('\\\\?\\') ? nativePath : `\\\\?\\${nativePath}`;
};
