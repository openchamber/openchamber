import os from 'node:os';
import path from 'node:path';

const pathForPlatform = (platform) => platform === 'win32' ? path.win32 : path;

/**
 * Return the key used for filesystem identity comparisons. Windows paths are
 * case-insensitive, but the path values returned to callers keep their original
 * casing so this helper is only for maps, guards, and reservations.
 */
export const canonicalPathKey = (value, platform = process.platform) => {
  if (String(value) !== value) return value;
  const pathApi = pathForPlatform(platform);
  const normalized = pathApi.normalize(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
};

/**
 * A repository rooted at the user's home directory or a filesystem root
 * covers too much of the filesystem for OpenChamber Git operations. Treat it
 * as unsupported at the shared repository-context boundary so every runtime
 * makes the same decision before admitting work or falling back to raw Git.
 */
export const unsupportedRepositoryRootReason = (repoRoot, home = os.homedir(), platform = process.platform) => {
  if (String(repoRoot) !== repoRoot || !repoRoot.trim()) return null;
  const pathApi = pathForPlatform(platform);
  const resolved = pathApi.resolve(repoRoot.trim());
  if (canonicalPathKey(pathApi.parse(resolved).root, platform) === canonicalPathKey(resolved, platform)) {
    return 'filesystem-root';
  }
  if (
    String(home) === home
    && home.trim()
    && canonicalPathKey(pathApi.resolve(home.trim()), platform) === canonicalPathKey(resolved, platform)
  ) return 'home';
  return null;
};

export const isUnsupportedRepositoryContext = (context) => (
  context?.isRepository === false
  && context?.reason === 'unsupported-repository-root'
);
