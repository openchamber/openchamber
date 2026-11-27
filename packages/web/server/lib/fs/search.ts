import { GIT_LAUNCH_DIRECTORY, gitArgsIn } from '../git/git-launch.js';
import type nodeFsPromises from 'node:fs/promises';
import type nodePath from 'node:path';
import type { spawn as nodeSpawn } from 'node:child_process';

interface FsSearchOptions {
  fsPromises: Pick<typeof nodeFsPromises, 'readdir'>;
  path: typeof nodePath;
  spawn: typeof nodeSpawn;
  resolveGitBinaryForSpawn: () => string;
  workspaceSearch?: boolean;
}

export interface FileSearchOptions {
  limit: number;
  query: string;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  signal?: AbortSignal;
}

export interface FilesystemFile {
  name: string;
  path: string;
  relativePath: string;
  extension: string | undefined;
}

const FILE_SEARCH_MAX_CONCURRENCY = 5;
const FILE_SEARCH_MAX_VISITED_FILES = 10_000;
const FILE_SEARCH_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'tmp',
  'logs',
]);

const normalizeRelativeSearchPath = (rootPath: string, targetPath: string, path: typeof nodePath) => {
  const relative = path.relative(rootPath, targetPath) || path.basename(targetPath);
  return relative.split(path.sep).join('/') || targetPath;
};

const shouldSkipSearchDirectory = (name: string, includeHidden: boolean) => {
  if (!name) {
    return false;
  }
  if (!includeHidden && name.startsWith('.')) {
    return true;
  }
  return FILE_SEARCH_EXCLUDED_DIRS.has(name.toLowerCase());
};

const listDirectoryEntries = async (dirPath: string, fsPromises: FsSearchOptions['fsPromises']) => {
  try {
    return await fsPromises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
};

const fuzzyMatchScoreNormalized = (normalizedQuery: string, candidate: string) => {
  if (!normalizedQuery) return 0;

  const q = normalizedQuery;
  const c = candidate.toLowerCase();
  if (c.includes(q)) {
    const idx = c.indexOf(q);
    let bonus = 0;
    if (idx === 0) {
      bonus = 20;
    } else {
      const prev = c[idx - 1];
      if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
        bonus = 15;
      }
    }
    return 100 + bonus - Math.min(idx, 20) - Math.floor(c.length / 5);
  }

  let score = 0;
  let lastIndex = -1;
  let consecutive = 0;

  for (let i = 0; i < q.length; i += 1) {
    const ch = q[i];
    if (!ch || ch === ' ') continue;

    const idx = c.indexOf(ch, lastIndex + 1);
    if (idx === -1) {
      return null;
    }

    const gap = idx - lastIndex - 1;
    if (gap === 0) {
      consecutive += 1;
    } else {
      consecutive = 0;
    }

    score += 10;
    score += Math.max(0, 18 - idx);
    score -= Math.min(gap, 10);

    if (idx === 0) {
      score += 12;
    } else {
      const prev = c[idx - 1];
      if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
        score += 10;
      }
    }

    score += consecutive > 0 ? 12 : 0;
    lastIndex = idx;
  }

  score += Math.max(0, 24 - Math.floor(c.length / 3));
  return score;
};

export const createGitCheckIgnoreTimeoutMs = () => {
  const raw = Number(process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 2500;
};

export const createFsSearchRuntime = ({ fsPromises, path, spawn, resolveGitBinaryForSpawn, workspaceSearch = false }: FsSearchOptions) => {
  const gitCheckIgnoreTimeoutMs = createGitCheckIgnoreTimeoutMs();
  const readDirectory = (directory: string) => workspaceSearch
    ? fsPromises.readdir(directory, { withFileTypes: true })
    : listDirectoryEntries(directory, fsPromises);

  const readIgnoredPaths = async (directory: string, names: string[], signal: AbortSignal | undefined) => {
    if ((!workspaceSearch && names.length === 0) || signal?.aborted) return new Set<string>();
    try {
      const result = await new Promise<string>((resolve) => {
        const args = workspaceSearch
          ? ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']
          : ['check-ignore', '--stdin', '-z'];
        const child = spawn(resolveGitBinaryForSpawn(), gitArgsIn(directory, args), {
          cwd: GIT_LAUNCH_DIRECTORY,
          windowsHide: true,
          stdio: [workspaceSearch ? 'ignore' : 'pipe', 'pipe', 'ignore'],
        });

        let stdout = '';
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const finish = (value: string) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          signal?.removeEventListener('abort', stop);
          resolve(value);
        };
        const stop = () => {
          try {
            child.kill('SIGKILL');
          } catch {
            void 0;
          }
          finish('');
        };

        if (gitCheckIgnoreTimeoutMs > 0) {
          timeout = setTimeout(stop, gitCheckIgnoreTimeoutMs);
        }
        signal?.addEventListener('abort', stop, { once: true });

        if (!child.stdout) throw new Error('Git stdout is unavailable');
        child.stdout.setEncoding?.('utf8');
        child.stdout.on('data', (data: string) => { stdout += data.toString(); });
        child.on('close', () => finish(stdout));
        child.on('error', () => finish(''));
        if (!workspaceSearch) {
          if (!child.stdin) throw new Error('Git stdin is unavailable');
          child.stdin.on('error', () => {});
          child.stdin.end(`${names.join('\0')}\0`);
        }
      });
      return new Set(String(result).split('\0').filter(Boolean));
    } catch {
      return new Set<string>();
    }
  };

  const searchFilesystemFiles = async (rootPath: string, options: FileSearchOptions): Promise<FilesystemFile[]> => {
    const { limit, query, includeHidden, respectGitignore, signal } = options;
    const includeHiddenEntries = Boolean(includeHidden);
    const normalizedQuery = query.trim().toLowerCase();
    const matchAll = normalizedQuery.length === 0;
    const deadline = workspaceSearch ? Date.now() + 30_000 : null;
    const queue = [{ dir: rootPath, gitRoot: rootPath }];
    const visited = new Set([rootPath]);
    const shouldRespectGitignore = respectGitignore !== false;
    const ignoredByRoot = new Map<string, Promise<Set<string>>>();
    const candidates: (FilesystemFile & { score: number })[] = [];
    let inspectedFiles = 0;
    const reachedSearchStop = () => (matchAll
      ? candidates.length >= limit
      : !workspaceSearch && inspectedFiles >= FILE_SEARCH_MAX_VISITED_FILES);

    while (queue.length > 0 && !reachedSearchStop()) {
      signal?.throwIfAborted();
      if (deadline && Date.now() > deadline) {
        throw new Error('File search exceeded its time limit');
      }
      const batch = queue.splice(0, FILE_SEARCH_MAX_CONCURRENCY);

      const dirResults = await Promise.all(batch.map(async ({ dir, gitRoot }) => {
        const dirents = await readDirectory(dir);
        if (!workspaceSearch || dirents.some((entry) => entry.name === '.git')) gitRoot = dir;
        if (workspaceSearch && shouldRespectGitignore && !ignoredByRoot.has(gitRoot)) {
          ignoredByRoot.set(gitRoot, readIgnoredPaths(gitRoot, dirents.map((entry) => entry.name).filter(Boolean), signal));
        }
        const ignoredPaths = !shouldRespectGitignore ? new Set<string>() : workspaceSearch
          ? await ignoredByRoot.get(gitRoot)
          : await readIgnoredPaths(dir, dirents.map((entry) => entry.name).filter(Boolean), signal);
        if (!ignoredPaths) throw new Error('Git ignore read is missing');
        return { dir, gitRoot, dirents, ignoredPaths };
      }));

      for (const { dir: currentDir, gitRoot, dirents, ignoredPaths } of dirResults) {
        for (const dirent of dirents) {
          const entryName = dirent.name;
          if (!entryName || (!includeHiddenEntries && entryName.startsWith('.'))) {
            continue;
          }

          const entryPath = path.join(currentDir, entryName);
          const gitPath = path.relative(gitRoot, entryPath).split(path.sep).join('/');
          if (ignoredPaths.has('./') || ignoredPaths.has(gitPath) || ignoredPaths.has(`${gitPath}/`)) {
            continue;
          }

          if (dirent.isDirectory()) {
            if (workspaceSearch
              ? ['.git', 'node_modules'].includes(entryName.toLowerCase())
              : shouldSkipSearchDirectory(entryName, includeHiddenEntries)) {
              continue;
            }
            if (!visited.has(entryPath)) {
              visited.add(entryPath);
              queue.push({ dir: entryPath, gitRoot });
            }
            continue;
          }

          if (!dirent.isFile()) {
            continue;
          }

          const relativePath = normalizeRelativeSearchPath(rootPath, entryPath, path);
          const extension = entryName.includes('.') ? entryName.split('.').pop()?.toLowerCase() : undefined;
          inspectedFiles += 1;

          if (matchAll) {
            candidates.push({
              name: entryName,
              path: entryPath,
              relativePath,
              extension,
              score: 0,
            });
          } else {
            const score = fuzzyMatchScoreNormalized(normalizedQuery, relativePath);
            if (score !== null) {
              candidates.push({
                name: entryName,
                path: entryPath,
                relativePath,
                extension,
                score,
              });
            }
          }

          if (reachedSearchStop()) {
            queue.length = 0;
            break;
          }
        }

        if (reachedSearchStop()) {
          break;
        }
      }
    }

    signal?.throwIfAborted();
    if (deadline && Date.now() > deadline) {
      throw new Error('File search exceeded its time limit');
    }

    if (!matchAll) {
      candidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.relativePath.length !== b.relativePath.length) {
          return a.relativePath.length - b.relativePath.length;
        }
        return a.relativePath.localeCompare(b.relativePath);
      });
    }

    return candidates.slice(0, limit).map(({ name, path: filePath, relativePath, extension }) => ({
      name,
      path: filePath,
      relativePath,
      extension,
    }));
  };

  return {
    searchFilesystemFiles,
  };
};
