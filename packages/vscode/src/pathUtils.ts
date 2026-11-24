import * as path from 'path';

export const normalizeWindowsDriveLetter = (p: string): string =>
  p.replace(/^([a-z]):/, (_, letter: string) => letter.toUpperCase() + ':');

export const pathsEqualWithNormalizedDriveLetter = (left: string, right: string): boolean =>
  normalizeWindowsDriveLetter(left) === normalizeWindowsDriveLetter(right);

export const isPathInside = (candidatePath: string, parentPath: string, pathApi: path.PlatformPath = path): boolean => {
  const candidate = normalizeWindowsDriveLetter(pathApi.resolve(candidatePath));
  const parent = normalizeWindowsDriveLetter(pathApi.resolve(parentPath));
  const prefix = parent.endsWith(pathApi.sep) ? parent : `${parent}${pathApi.sep}`;
  return candidate === parent || candidate.startsWith(prefix);
};