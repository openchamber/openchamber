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
  const raw = Number(process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 2500;
};

export const createFsSearchRuntime = ({ fsPromises, path, spawn, resolveGitBinaryForSpawn, workspaceSearch = false }) => {
  const gitCheckIgnoreTimeoutMs = createGitCheckIgnoreTimeoutMs();
  const readDirectory = (directory) => workspaceSearch
    ? fsPromises.readdir(directory, { withFileTypes: true })
    : listDirectoryEntries(directory, fsPromises);

  const readIgnoredPaths = async (directory, names, signal) => {
    if ((!workspaceSearch && names.length === 0) || signal?.aborted) return new Set();
    try {
      const result = await new Promise((resolve) => {
        const args = workspaceSearch
          ? ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']
          : ['check-ignore', '--stdin', '-z'];
        const child = spawn(resolveGitBinaryForSpawn(), args, {
          cwd: directory,
          windowsHide: true,
          // Diagnostics are unused here. An unread pipe can block Git forever.
          stdio: [workspaceSearch ? 'ignore' : 'pipe', 'pipe', 'ignore'],
        });

        let stdout = '';
        let settled = false;
        let timeout = null;
        const finish = (value) => {
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
          }
          finish('');
        };

        if (gitCheckIgnoreTimeoutMs > 0) {
          timeout = setTimeout(stop, gitCheckIgnoreTimeoutMs);
        }
        signal?.addEventListener('abort', stop, { once: true });

        child.stdout.setEncoding?.('utf8');
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.on('close', () => finish(stdout));
        child.on('error', () => finish(''));
        if (!workspaceSearch) {
          child.stdin.on('error', () => {});
          child.stdin.end(`${names.join('\0')}\0`);
        }
      });
      return new Set(String(result).split('\0').filter(Boolean));
    } catch {
      return new Set();
    }
  };

  const searchFilesystemFiles = async (rootPath, options) => {
    const { limit, query, includeHidden, respectGitignore, signal } = options;
    const includeHiddenEntries = Boolean(includeHidden);
    const normalizedQuery = query.trim().toLowerCase();
    const matchAll = normalizedQuery.length === 0;
    const deadline = workspaceSearch ? Date.now() + 30_000 : null;
    const queue = [{ dir: rootPath, gitRoot: rootPath }];
    const visited = new Set([rootPath]);
    const shouldRespectGitignore = respectGitignore !== false;
    // Shared only within this search; later queries re-read Git's ignore state.
    const ignoredByRoot = new Map();
    // An empty query stops at `limit` candidates: any file serves. A query
    // must keep walking until the tree or the icon-search ceiling is
    // reached: weak shallow matches otherwise exhaust a candidate budget
    // before exact deeper matches are ever visited.
    const candidates = [];
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
        // A nested checkout has its own index and ignore rules.
        if (!workspaceSearch || dirents.some((entry) => entry.name === '.git')) gitRoot = dir;
        if (workspaceSearch && shouldRespectGitignore && !ignoredByRoot.has(gitRoot)) {
          ignoredByRoot.set(gitRoot, readIgnoredPaths(gitRoot, dirents.map((entry) => entry.name).filter(Boolean), signal));
        }
        const ignoredPaths = !shouldRespectGitignore ? new Set() : workspaceSearch
          ? await ignoredByRoot.get(gitRoot)
          : await readIgnoredPaths(dir, dirents.map((entry) => entry.name).filter(Boolean), signal);
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
          // Git collapses a wholly ignored search root without tracked files to './'.
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

    // A stopped Git read filtered nothing, so this answer must not reach anyone.
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
