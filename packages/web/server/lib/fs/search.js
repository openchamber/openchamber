import { StringDecoder } from 'node:string_decoder';

import { parseBoundedIntWithDefault } from '../shared/parse-int.js';
import { createTraversalBudget } from '../shared/traversal-budget.js';

const FILE_SEARCH_MAX_CONCURRENCY = 5;
const FILE_SEARCH_MAX_VISITED_FILES = 10_000;
const FILE_SEARCH_MAX_VISITED_DIRS = 50_000;
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

const normalizeRelativeSearchPath = (rootPath, targetPath, path) => {
  const relative = path.relative(rootPath, targetPath) || path.basename(targetPath);
  return relative.split(path.sep).join('/') || targetPath;
};

const shouldSkipSearchDirectory = (name, includeHidden) => {
  if (!name) {
    return false;
  }
  if (!includeHidden && name.startsWith('.')) {
    return true;
  }
  return FILE_SEARCH_EXCLUDED_DIRS.has(name.toLowerCase());
};

const listDirectoryEntries = async (dirPath, fsPromises) => {
  try {
    return await fsPromises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
};

const fuzzyMatchScoreNormalized = (normalizedQuery, candidate) => {
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
  // The strict plain-decimal judgement lives in shared/parse-int.js (design
  // #802 phase 2, #804): a bare Number(...) would silently honour '' and ' '
  // as 0 (disarming the check-ignore kill timeout), '1e3' as 1000, '0x10' as
  // 16, and '5.9' as a fractional timeout. An explicit '0' still disables
  // the timeout.
  // The upper bound is Node's timer maximum (2^31 - 1 ms): a larger delay
  // fires after ~1 ms instead, which would kill every check-ignore child
  // immediately rather than giving it the configured time.
  return parseBoundedIntWithDefault(process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS, 2500, 0, 2_147_483_647);
};

export const createFsSearchRuntime = ({ fsPromises, path, spawn, resolveGitBinaryForSpawn }) => {
  const gitCheckIgnoreTimeoutMs = createGitCheckIgnoreTimeoutMs();

  const searchFilesystemFiles = async (rootPath, options) => {
    const { limit, query, includeHidden, respectGitignore } = options;
    const includeHiddenEntries = Boolean(includeHidden);
    const normalizedQuery = query.trim().toLowerCase();
    const matchAll = normalizedQuery.length === 0;
    const queue = [rootPath];
    const visited = new Set([rootPath]);
    // The shared traversal budget (design #1391, #1393) owns this walk's
    // counting: directories admitted and files inspected. The root is the
    // first directory the walk enters, so it is consulted first, matching
    // the visited set it seeds.
    const budget = createTraversalBudget({
      maxDirs: FILE_SEARCH_MAX_VISITED_DIRS,
      maxEntries: FILE_SEARCH_MAX_VISITED_FILES,
    });
    budget.visitDir();
    const shouldRespectGitignore = respectGitignore !== false;
    // An empty query stops at `limit` candidates: any file serves. A query
    // must keep walking until the tree or the inspected-file ceiling is
    // reached: weak shallow matches otherwise exhaust a candidate budget
    // before exact deeper matches are ever visited.
    const candidates = [];
    const reachedSearchStop = () => (matchAll
      ? candidates.length >= limit
      : budget.visitedEntries >= FILE_SEARCH_MAX_VISITED_FILES);
    // The budget holds every directory that will ever be read, so
    // refusing enqueues at its directory ceiling bounds the whole walk: a
    // directory-heavy tree cannot grow the queue or the visited set past
    // it, while directories already queued are still read, so results
    // collected up to the ceiling stay complete for the directories that
    // were visited. The visited set itself only dedupes now.

    while (queue.length > 0 && !reachedSearchStop()) {
      const batch = queue.splice(0, FILE_SEARCH_MAX_CONCURRENCY);

      const dirResults = await Promise.all(
        batch.map(async (dir) => {
          if (!shouldRespectGitignore) {
            return { dir, dirents: await listDirectoryEntries(dir, fsPromises), ignoredPaths: new Set() };
          }

          try {
            const dirents = await listDirectoryEntries(dir, fsPromises);
            const pathsToCheck = dirents.map((dirent) => dirent.name).filter(Boolean);
            if (pathsToCheck.length === 0) {
              return { dir, dirents, ignoredPaths: new Set() };
            }

            const result = await new Promise((resolve) => {
              const child = spawn(resolveGitBinaryForSpawn(), ['check-ignore', '--', ...pathsToCheck], {
                cwd: dir,
                windowsHide: true,
                // Diagnostics are unused here. An unread pipe can block Git forever.
                stdio: ['ignore', 'pipe', 'ignore'],
              });

              let stdout = '';
              const stdoutDecoder = new StringDecoder('utf8');
              let settled = false;
              let timeout = null;
              const finish = (value) => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                resolve(value);
              };

              if (gitCheckIgnoreTimeoutMs > 0) {
                timeout = setTimeout(() => {
                  try {
                    child.kill('SIGKILL');
                  } catch {
                  }
                  finish('');
                }, gitCheckIgnoreTimeoutMs);
              }

              child.stdout.on('data', (data) => { stdout += stdoutDecoder.write(data); });
              child.on('close', () => finish(stdout + stdoutDecoder.end()));
              child.on('error', () => finish(''));
            });

            const ignoredNames = new Set(
              String(result)
                .split('\n')
                .map((name) => name.trim())
                .filter(Boolean)
            );

            return { dir, dirents, ignoredPaths: ignoredNames };
          } catch {
            return { dir, dirents: await listDirectoryEntries(dir, fsPromises), ignoredPaths: new Set() };
          }
        })
      );

      for (const { dir: currentDir, dirents, ignoredPaths } of dirResults) {
        for (const dirent of dirents) {
          const entryName = dirent.name;
          if (!entryName || (!includeHiddenEntries && entryName.startsWith('.'))) {
            continue;
          }

          if (shouldRespectGitignore && ignoredPaths.has(entryName)) {
            continue;
          }

          const entryPath = path.join(currentDir, entryName);

          if (dirent.isDirectory()) {
            if (shouldSkipSearchDirectory(entryName, includeHiddenEntries)) {
              continue;
            }
            if (!visited.has(entryPath) && budget.visitDir()) {
              visited.add(entryPath);
              queue.push(entryPath);
            }
            continue;
          }

          if (!dirent.isFile()) {
            continue;
          }

          const relativePath = normalizeRelativeSearchPath(rootPath, entryPath, path);
          const extension = entryName.includes('.') ? entryName.split('.').pop()?.toLowerCase() : undefined;
          // Count the inspected file against the budget's entries
          // dimension; reachedSearchStop reads that counter, so the
          // consultation is the count, not a second gate.
          budget.visitEntry();

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
