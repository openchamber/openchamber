const FILE_SEARCH_MAX_CONCURRENCY = 5;
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

export const createFsSearchRuntime = ({ fsPromises, path, spawn, resolveGitBinaryForSpawn }) => {
  const searchFilesystemFiles = async (rootPath, options) => {
    const { limit, query, includeHidden, respectGitignore } = options;
    const includeHiddenEntries = Boolean(includeHidden);
    const normalizedQuery = query.trim().toLowerCase();
    const matchAll = normalizedQuery.length === 0;
    const queue = [rootPath];
    const visited = new Set([rootPath]);
    const shouldRespectGitignore = respectGitignore !== false;
    const collectLimit = matchAll ? limit : Math.max(limit * 3, 200);
    const candidates = [];

    while (queue.length > 0 && candidates.length < collectLimit) {
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
                stdio: ['ignore', 'pipe', 'pipe'],
              });

              let stdout = '';
              child.stdout.on('data', (data) => { stdout += data.toString(); });
              child.on('close', () => resolve(stdout));
              child.on('error', () => resolve(''));
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
            if (!visited.has(entryPath)) {
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

          if (candidates.length >= collectLimit) {
            queue.length = 0;
            break;
          }
        }

        if (candidates.length >= collectLimit) {
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
