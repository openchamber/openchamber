import type nodeFsPromises from 'node:fs/promises';
import type nodePath from 'node:path';

const isMissingPathError = (error: unknown): error is { code: 'ENOENT' } => (
  error !== null && (typeof error === 'object' || typeof error === 'function')
  && 'code' in error && error.code === 'ENOENT'
);

export const canonicalDirectoryPath = async (
  directory: string,
  fsPromises: Pick<typeof nodeFsPromises, 'realpath'>,
  path: Pick<typeof nodePath, 'resolve' | 'join' | 'dirname' | 'basename'>,
) => {
  let ancestor = path.resolve(directory);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await fsPromises.realpath(ancestor), ...missing);
    } catch (error) {
      const parent = path.dirname(ancestor);
      if (!isMissingPathError(error) || parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
};
