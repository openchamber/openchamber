import type nodeFsPromises from 'node:fs/promises';
import type nodePath from 'node:path';

import { canonicalDirectoryPath } from './canonical-path.js';

type PathModule = typeof nodePath;
type RealPath = Pick<typeof nodeFsPromises, 'realpath'>;
type HomeSource = { homedir: () => string };
type ResolvedTarget = { base: string; resolved: string };
type TargetDeps = { fsPromises: RealPath; path: PathModule; os: HomeSource };

const isMissingPathError = (error: unknown): error is { code: 'ENOENT' } => (
  error !== null && (typeof error === 'object' || typeof error === 'function')
  && 'code' in error && error.code === 'ENOENT'
);

export const isPathWithinRoot = (resolvedPath: string, rootPath: string | null | undefined, path: PathModule, os: HomeSource) => {
  const resolvedRoot = path.resolve(rootPath || os.homedir());
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  return true;
};

export const canonicalizeFinishedPath = async (targetPath: string, fsPromises: RealPath, path: PathModule) => (
  path.join(
    await canonicalDirectoryPath(path.dirname(targetPath), fsPromises, path),
    path.basename(targetPath),
  )
);

const canonicalBasePath = (base: string, fsPromises: RealPath, path: PathModule) => (
  canonicalDirectoryPath(base, fsPromises, path).catch(() => path.resolve(base))
);

export const containedPath = async (resolved: ResolvedTarget, { fsPromises, path, os }: TargetDeps) => {
  const canonicalBase = await canonicalBasePath(resolved.base, fsPromises, path);
  const target = await canonicalizeFinishedPath(resolved.resolved, fsPromises, path);
  return isPathWithinRoot(target, canonicalBase, path, os) ? target : null;
};

export const containedMkdirPath = async (resolved: ResolvedTarget, deps: TargetDeps) => (
  deps.path.resolve(resolved.resolved) === deps.path.resolve(resolved.base)
    ? canonicalBasePath(resolved.base, deps.fsPromises, deps.path)
    : containedPath(resolved, deps)
);

export const containedWritePath = async (resolved: ResolvedTarget, { fsPromises, path, os }: TargetDeps) => {
  const canonicalBase = await canonicalBasePath(resolved.base, fsPromises, path);
  const writePath = await fsPromises.realpath(resolved.resolved).catch(async (error) => {
    if (isMissingPathError(error)) {
      return canonicalizeFinishedPath(resolved.resolved, fsPromises, path);
    }
    throw error;
  });
  return isPathWithinRoot(writePath, canonicalBase, path, os) ? writePath : null;
};

export const containedRenamePaths = async (source: ResolvedTarget, destination: ResolvedTarget, deps: TargetDeps) => {
  const [sourcePath, destinationPath] = await Promise.all([
    containedPath(source, deps),
    containedPath(destination, deps),
  ]);
  return sourcePath && destinationPath ? { sourcePath, destinationPath } : null;
};
