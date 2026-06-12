import { createRealpathCache } from '../path-realpath-cache.js';
import nodeFsPromises from 'node:fs/promises';
import nodePath from 'node:path';

const EXEC_JOB_TTL_MS = 30 * 60 * 1000;
const OUTSIDE_FILE_GRANT_TTL_MS = 10 * 60 * 1000;

const outsideFileGrants = new Map();

const pruneOutsideFileGrants = () => {
  const now = Date.now();
  for (const [token, grant] of outsideFileGrants.entries()) {
    if (!grant || grant.expiresAt <= now) {
      outsideFileGrants.delete(token);
    }
  }
};

export const mintOutsideFileGrant = async (targetPath, {
  scopes = ['stat', 'read', 'raw'],
  fsPromises = nodeFsPromises,
  path = nodePath,
  crypto = globalThis.crypto,
} = {}) => {
  const raw = typeof targetPath === 'string' ? targetPath.trim() : '';
  if (!raw) {
    throw new Error('Path is required');
  }
  const canonicalPath = await fsPromises.realpath(raw);
  const stats = await fsPromises.stat(canonicalPath);
  if (!stats.isFile()) {
    throw new Error('Outside file grants require a file path');
  }
  pruneOutsideFileGrants();
  const token = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const normalizedScopes = new Set(
    (Array.isArray(scopes) ? scopes : [])
      .filter((scope) => typeof scope === 'string' && scope.trim())
      .map((scope) => scope.trim())
  );
  if (normalizedScopes.size === 0) {
    normalizedScopes.add('read');
  }
  const grant = {
    canonicalPath,
    base: path.dirname(canonicalPath),
    scopes: normalizedScopes,
    expiresAt: Date.now() + OUTSIDE_FILE_GRANT_TTL_MS,
  };
  outsideFileGrants.set(token, grant);
  return {
    path: canonicalPath,
    outsideFileGrant: token,
    expiresAt: grant.expiresAt,
  };
};

const resolveOutsideFileGrant = async ({ token, targetPath, scope, fsPromises }) => {
  pruneOutsideFileGrants();
  if (typeof token !== 'string' || !token.trim()) {
    return { ok: false, error: 'Outside workspace file access requires a grant' };
  }
  const grant = outsideFileGrants.get(token.trim());
  if (!grant) {
    return { ok: false, error: 'Outside workspace file grant is invalid or expired' };
  }
  if (!grant.scopes.has(scope)) {
    return { ok: false, error: 'Outside workspace file grant does not allow this operation' };
  }
  const canonicalPath = await fsPromises.realpath(targetPath);
  if (canonicalPath !== grant.canonicalPath) {
    return { ok: false, error: 'Outside workspace file grant does not match requested path' };
  }
  return { ok: true, base: grant.base, resolved: canonicalPath, granted: true };
};

const createCommandTimeoutMs = () => {
  const raw = Number(process.env.OPENCHAMBER_FS_EXEC_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 5 * 60 * 1000;
};

// How long a cached git-read result stays fresh. The location of a repo's git
// directory is effectively static while the app runs, so a short TTL safely
// absorbs the burst of identical lookups a fresh client (e.g. right after a
// page reload) fires for every project. Set to 0 to disable caching.
const createGitReadCacheTtlMs = () => {
  const raw = Number(process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 30 * 1000;
};

const createGitCheckIgnoreTimeoutMs = () => {
  const raw = Number(process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 2500;
};

// Only deterministic, side-effect-free git plumbing path queries are cacheable.
// Anything outside this allowlist (including any non-git command) runs normally
// — we never cache arbitrary exec.
const normalizeCommand = (command) =>
  typeof command === 'string' ? command.trim().replace(/\s+/g, ' ') : '';

const isCacheableGitReadCommand = (command) => {
  const normalized = normalizeCommand(command);
  return /^git rev-parse(?: --(?:absolute-git-dir|git-common-dir|show-toplevel)){1,3}$/.test(normalized);
};

// Dual-constraint bound per the project's caching policy (count + bytes). Git
// rev-parse outputs are tiny, so these ceilings are generous and only guard
// against pathological growth on long-lived, many-directory deployments.
const GIT_READ_CACHE_MAX_ENTRIES = 500;
const GIT_READ_CACHE_MAX_BYTES = 1024 * 1024;

const gitReadEntryBytes = (key, result) =>
  key.length + (result?.stdout?.length || 0) + (result?.stderr?.length || 0);

const isPathWithinRoot = (resolvedPath, rootPath, path, os) => {
  const resolvedRoot = path.resolve(rootPath || os.homedir());
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  return true;
};

const resolveWorkspacePath = ({ targetPath, baseDirectory, path, os, normalizeDirectoryPath, openchamberUserConfigRoot }) => {
  const normalized = normalizeDirectoryPath(targetPath);
  if (!normalized || typeof normalized !== 'string') {
    return { ok: false, error: 'Path is required' };
  }

  const resolved = path.resolve(normalized);
  const resolvedBase = path.resolve(baseDirectory || os.homedir());

  if (isPathWithinRoot(resolved, resolvedBase, path, os)) {
    return { ok: true, base: resolvedBase, resolved };
  }

  if (isPathWithinRoot(resolved, openchamberUserConfigRoot, path, os)) {
    return { ok: true, base: path.resolve(openchamberUserConfigRoot), resolved };
  }

  return { ok: false, error: 'Path is outside of active workspace' };
};

const resolveWorkspacePathFromWorktrees = async ({ targetPath, baseDirectory, path, os, normalizeDirectoryPath }) => {
  const normalized = normalizeDirectoryPath(targetPath);
  if (!normalized || typeof normalized !== 'string') {
    return { ok: false, error: 'Path is required' };
  }

  const resolved = path.resolve(normalized);
  const resolvedBase = path.resolve(baseDirectory || os.homedir());

  try {
    const { getWorktrees } = await import('../git/index.js');
    const worktrees = await getWorktrees(resolvedBase);

    for (const worktree of worktrees) {
      const candidatePath = typeof worktree?.path === 'string'
        ? worktree.path
        : (typeof worktree?.worktree === 'string' ? worktree.worktree : '');
      const candidate = normalizeDirectoryPath(candidatePath);
      if (!candidate) {
        continue;
      }
      const candidateResolved = path.resolve(candidate);
      if (isPathWithinRoot(resolved, candidateResolved, path, os)) {
        return { ok: true, base: candidateResolved, resolved };
      }
    }
  } catch (error) {
    console.warn('Failed to resolve worktree roots:', error);
  }

  return { ok: false, error: 'Path is outside of active workspace' };
};

const resolveWorkspacePathFromContext = async ({ req, targetPath, resolveProjectDirectory, path, os, normalizeDirectoryPath, openchamberUserConfigRoot }) => {
  const resolvedProject = await resolveProjectDirectory(req);
  if (!resolvedProject.directory) {
    return { ok: false, error: resolvedProject.error || 'Active workspace is required' };
  }

  const resolved = resolveWorkspacePath({
    targetPath,
    baseDirectory: resolvedProject.directory,
    path,
    os,
    normalizeDirectoryPath,
    openchamberUserConfigRoot,
  });
  if (resolved.ok || resolved.error !== 'Path is outside of active workspace') {
    return resolved;
  }

  return resolveWorkspacePathFromWorktrees({
    targetPath,
    baseDirectory: resolvedProject.directory,
    path,
    os,
    normalizeDirectoryPath,
  });
};

const deriveCloneDirectoryName = (remoteUrl) => {
  const remote = typeof remoteUrl === 'string' ? remoteUrl.trim() : '';
  if (!remote) return '';
  const withoutQuery = remote.split(/[?#]/, 1)[0] || remote;
  const match = withoutQuery.match(/([^/:]+?)(?:\.git)?\/?$/);
  return match?.[1]?.trim() || '';
};

const resolveCloneGitIdentity = async (gitIdentityId) => {
  const id = typeof gitIdentityId === 'string' ? gitIdentityId.trim() : '';
  if (!id) return null;
  const { getProfile, getGlobalIdentity } = await import('../git/index.js');
  if (id === 'global') {
    const globalIdentity = await getGlobalIdentity();
    if (!globalIdentity?.userName || !globalIdentity?.userEmail) return null;
    return {
      id: 'global',
      name: 'Global Identity',
      userName: globalIdentity.userName,
      userEmail: globalIdentity.userEmail,
      sshKey: globalIdentity.sshCommand ? globalIdentity.sshCommand.replace('ssh -i ', '') : null,
    };
  }
  return getProfile(id) || null;
};

const escapeCloneSshKeyPath = (sshKeyPath) => {
  const raw = String(sshKeyPath || '').trim();
  if (!raw) return '';
  const normalized = process.platform === 'win32' ? raw.replace(/\\/g, '/') : raw;
  const dangerousChars = /[`$!"';&|<>(){}[\]*?#~]/;
  if (dangerousChars.test(normalized)) {
    throw new Error(`SSH key path contains invalid characters: ${raw}`);
  }
  if (process.platform === 'win32') {
    const driveMatch = normalized.match(/^([A-Za-z]):\//);
    const unixPath = driveMatch ? `/${driveMatch[1].toLowerCase()}${normalized.slice(2)}` : normalized;
    return `'${unixPath}'`;
  }
  return `'${normalized.replace(/'/g, "'\\''")}'`;
};

const resolveReadPathFromContext = async ({ req, targetPath, scope, resolveProjectDirectory, path, os, fsPromises, normalizeDirectoryPath, openchamberUserConfigRoot }) => {
  if (req.query?.allowOutsideWorkspace === 'true') {
    const normalized = normalizeDirectoryPath(targetPath);
    if (!normalized || typeof normalized !== 'string') {
      return { ok: false, error: 'Path is required' };
    }
    const resolved = path.resolve(normalized);
    return resolveOutsideFileGrant({
      token: req.query?.outsideFileGrant,
      targetPath: resolved,
      scope,
      fsPromises,
    });
  }

  return resolveWorkspacePathFromContext({
    req,
    targetPath,
    resolveProjectDirectory,
    path,
    os,
    normalizeDirectoryPath,
    openchamberUserConfigRoot,
  });
};

const runCommandInDirectory = ({ shell, shellFlag, command, resolvedCwd, spawn, buildAugmentedPath, commandTimeoutMs }) => {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const envPath = buildAugmentedPath();
    const execEnv = { ...process.env, PATH: envPath };

    const child = spawn(shell, [shellFlag, command], {
      cwd: resolvedCwd,
      env: execEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
      }
    }, commandTimeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({
        command,
        success: false,
        exitCode: undefined,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: (error && error.message) || 'Command execution failed',
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      const exitCode = typeof code === 'number' ? code : undefined;
      const base = {
        command,
        success: exitCode === 0 && !timedOut,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };

      if (timedOut) {
        resolve({
          ...base,
          success: false,
          error: `Command timed out after ${commandTimeoutMs}ms` + (signal ? ` (${signal})` : ''),
        });
        return;
      }

      resolve(base);
    });
  });
};

export const registerFsRoutes = (app, dependencies) => {
  const {
    os,
    path,
    fsPromises,
    spawn,
    crypto,
    normalizeDirectoryPath,
    resolveProjectDirectory,
    buildAugmentedPath,
    resolveGitBinaryForSpawn,
    openchamberUserConfigRoot,
  } = dependencies;
  const realpathCache = createRealpathCache({
    realpath: fsPromises.realpath.bind(fsPromises),
  });

  const execJobs = new Map();
  const commandTimeoutMs = createCommandTimeoutMs();
  const gitReadCacheTtlMs = createGitReadCacheTtlMs();
  const gitCheckIgnoreTimeoutMs = createGitCheckIgnoreTimeoutMs();
  const gitReadCache = new Map();
  const inFlightGitReadCache = new Map();

  const pruneExecJobs = () => {
    const now = Date.now();
    for (const [jobId, job] of execJobs.entries()) {
      if (!job || typeof job !== 'object') {
        execJobs.delete(jobId);
        continue;
      }
      const updatedAt = typeof job.updatedAt === 'number' ? job.updatedAt : 0;
      if (updatedAt && now - updatedAt > EXEC_JOB_TTL_MS) {
        execJobs.delete(jobId);
      }
    }
  };

  const pruneGitReadCache = () => {
    if (gitReadCacheTtlMs <= 0) {
      return;
    }
    const now = Date.now();
    for (const [key, entry] of gitReadCache.entries()) {
      if (!entry || now - entry.at > gitReadCacheTtlMs) {
        gitReadCache.delete(key);
      }
    }
  };

  // Insert with LRU (oldest-first) eviction enforcing both count and byte caps.
  // Map iteration order is insertion order, so deleting+re-setting a key moves
  // it to the most-recently-used position.
  const setGitReadCacheEntry = (key, result) => {
    gitReadCache.delete(key);
    gitReadCache.set(key, { result, at: Date.now() });

    let totalBytes = 0;
    for (const [k, entry] of gitReadCache) {
      totalBytes += gitReadEntryBytes(k, entry.result);
    }
    while (
      gitReadCache.size > GIT_READ_CACHE_MAX_ENTRIES ||
      (totalBytes > GIT_READ_CACHE_MAX_BYTES && gitReadCache.size > 1)
    ) {
      const oldest = gitReadCache.entries().next().value;
      if (!oldest) {
        break;
      }
      totalBytes -= gitReadEntryBytes(oldest[0], oldest[1].result);
      gitReadCache.delete(oldest[0]);
    }
  };

  // Runs a command, transparently serving/storing cacheable git-read results.
  // Non-cacheable commands always execute and are never stored.
  const runCommandWithGitReadCache = async ({ shell, shellFlag, command, resolvedCwd }) => {
    const cacheable = gitReadCacheTtlMs > 0 && isCacheableGitReadCommand(command);
    const cacheKey = cacheable ? `${resolvedCwd} ${normalizeCommand(command)}` : null;

    if (cacheKey) {
      const cached = gitReadCache.get(cacheKey);
      if (cached && Date.now() - cached.at < gitReadCacheTtlMs) {
        // Refresh recency for LRU without altering the entry's age/TTL.
        gitReadCache.delete(cacheKey);
        gitReadCache.set(cacheKey, cached);
        return { ...cached.result, command };
      }
      if (cached) {
        gitReadCache.delete(cacheKey);
      }

      const inFlight = inFlightGitReadCache.get(cacheKey);
      if (inFlight) {
        const result = await inFlight;
        return { ...result, command };
      }
    }

    const runPromise = runCommandInDirectory({
      shell,
      shellFlag,
      command,
      resolvedCwd,
      spawn,
      buildAugmentedPath,
      commandTimeoutMs,
    }).then((result) => {
      // Only cache successful results — failures may be transient.
      if (cacheKey && result && result.success) {
        setGitReadCacheEntry(cacheKey, result);
      }
      return result;
    }).finally(() => {
      if (cacheKey && inFlightGitReadCache.get(cacheKey) === runPromise) {
        inFlightGitReadCache.delete(cacheKey);
      }
    });

    if (cacheKey) {
      inFlightGitReadCache.set(cacheKey, runPromise);
    }

    return runPromise;
  };

  const runExecJob = async (job) => {
    job.status = 'running';
    job.updatedAt = Date.now();

    const results = [];
    for (const command of job.commands) {
      if (typeof command !== 'string' || !command.trim()) {
        results.push({ command, success: false, error: 'Invalid command' });
        continue;
      }

      try {
        const result = await runCommandWithGitReadCache({
          shell: job.shell,
          shellFlag: job.shellFlag,
          command,
          resolvedCwd: job.resolvedCwd,
        });
        results.push(result);
      } catch (error) {
        results.push({
          command,
          success: false,
          error: (error && error.message) || 'Command execution failed',
        });
      }

      job.results = results;
      job.updatedAt = Date.now();
    }

    job.results = results;
    job.success = results.every((r) => r.success);
    job.status = 'done';
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  };

  app.get('/api/fs/home', (_req, res) => {
    try {
      const home = os.homedir();
      if (!home || typeof home !== 'string' || home.length === 0) {
        return res.status(500).json({ error: 'Failed to resolve home directory' });
      }
      return res.json({ home });
    } catch (error) {
      console.error('Failed to resolve home directory:', error);
      return res.status(500).json({ error: (error && error.message) || 'Failed to resolve home directory' });
    }
  });

  app.post('/api/fs/mkdir', async (req, res) => {
    try {
      const { path: dirPath, allowOutsideWorkspace } = req.body ?? {};
      if (typeof dirPath !== 'string' || !dirPath.trim()) {
        return res.status(400).json({ error: 'Path is required' });
      }

      let resolvedPath = '';
      if (allowOutsideWorkspace) {
        console.warn('Rejected outside-workspace mkdir without trusted directory grant');
        return res.status(403).json({ error: 'Outside workspace directory creation requires a grant' });
      } else {
        const resolved = await resolveWorkspacePathFromContext({
          req,
          targetPath: dirPath,
          resolveProjectDirectory,
          path,
          os,
          normalizeDirectoryPath,
          openchamberUserConfigRoot,
        });
        if (!resolved.ok) {
          return res.status(400).json({ error: resolved.error });
        }
        resolvedPath = resolved.resolved;
      }

      await fsPromises.mkdir(resolvedPath, { recursive: true });
      return res.json({ success: true, path: resolvedPath });
    } catch (error) {
      console.error('Failed to create directory:', error);
      return res.status(500).json({ error: error.message || 'Failed to create directory' });
    }
  });

  app.post('/api/fs/clone', async (req, res) => {
    try {
      const { remoteUrl, destinationPath, gitIdentityId } = req.body ?? {};
      const remote = typeof remoteUrl === 'string' ? remoteUrl.trim() : '';
      const destination = typeof destinationPath === 'string' ? destinationPath.trim() : '';
      if (!remote) {
        return res.status(400).json({ error: 'Repository URL is required' });
      }
      if (!destination) {
        return res.status(400).json({ error: 'Destination path is required' });
      }

      let resolvedDestination = path.resolve(normalizeDirectoryPath(destination));
      let parentPath = path.dirname(resolvedDestination);
      let directoryName = path.basename(resolvedDestination);

      const cloneIntoDestinationDirectory = destination.endsWith('/') || destination.endsWith('\\');
      if (cloneIntoDestinationDirectory) {
        const inferredName = deriveCloneDirectoryName(remote);
        if (!inferredName) {
          return res.status(400).json({ error: 'Could not infer repository directory name from URL' });
        }
        parentPath = resolvedDestination;
        directoryName = inferredName;
        resolvedDestination = path.join(parentPath, directoryName);
      } else {
        try {
          const stat = await fsPromises.stat(resolvedDestination);
          if (stat.isDirectory()) {
            const inferredName = deriveCloneDirectoryName(remote);
            if (!inferredName) {
              return res.status(400).json({ error: 'Could not infer repository directory name from URL' });
            }
            parentPath = resolvedDestination;
            directoryName = inferredName;
            resolvedDestination = path.join(parentPath, directoryName);
          }
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            throw error;
          }
        }
      }
      if (!directoryName || directoryName === '.' || directoryName === '..') {
        return res.status(400).json({ error: 'Destination path must include a directory name' });
      }

      const identity = await resolveCloneGitIdentity(gitIdentityId);
      const gitArgs = ['clone', '--', remote, directoryName];
      const sshKeyPath = typeof identity?.sshKey === 'string' ? identity.sshKey.trim() : '';
      if (sshKeyPath) {
        gitArgs.unshift(`core.sshCommand=ssh -i ${escapeCloneSshKeyPath(sshKeyPath)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`);
        gitArgs.unshift('-c');
      }

      await fsPromises.mkdir(parentPath, { recursive: true });
      try {
        await fsPromises.access(resolvedDestination);
        return res.status(409).json({ error: 'Destination path already exists' });
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          throw error;
        }
      }

      const output = await new Promise((resolve, reject) => {
        const child = spawn(resolveGitBinaryForSpawn(), gitArgs, {
          cwd: parentPath,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: buildAugmentedPath ? buildAugmentedPath(process.env.PATH || '') : process.env.PATH,
            GIT_TERMINAL_PROMPT: '0',
          },
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
          const combined = `${stdout}\n${stderr}`.trim();
          if (code === 0) {
            resolve(combined);
            return;
          }
          const message = combined || `git clone failed with exit code ${code}`;
          reject(new Error(message));
        });
      });

      if (identity?.userName && identity?.userEmail) {
        try {
          const { setLocalIdentity } = await import('../git/index.js');
          await setLocalIdentity(resolvedDestination, identity);
        } catch (error) {
          console.warn('Failed to apply git identity after clone:', error);
        }
      }

      return res.json({ success: true, path: resolvedDestination, output });
    } catch (error) {
      console.error('Failed to clone repository:', error);
      return res.status(500).json({ error: error.message || 'Failed to clone repository' });
    }
  });

  app.get('/api/fs/stat', async (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveReadPathFromContext({
        req,
        targetPath: filePath,
        scope: 'stat',
        resolveProjectDirectory,
        path,
        os,
        fsPromises,
        normalizeDirectoryPath,
        openchamberUserConfigRoot,
      });
      if (!resolved.ok) {
        if (req.query?.allowOutsideWorkspace === 'true') {
          console.warn(`Rejected outside-workspace stat: ${resolved.error}`);
        }
        return res.status(400).json({ error: resolved.error });
      }

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase, path, os)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }

      return res.json({ path: canonicalPath, isFile: true, size: stats.size, mtimeMs: stats.mtimeMs });
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to stat file:', error);
      return res.status(500).json({ error: (error && error.message) || 'Failed to stat file' });
    }
  });

  app.get('/api/fs/read', async (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    const optional = req.query.optional === 'true';
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveReadPathFromContext({
        req,
        targetPath: filePath,
        scope: 'read',
        resolveProjectDirectory,
        path,
        os,
        fsPromises,
        normalizeDirectoryPath,
        openchamberUserConfigRoot,
      });
      if (!resolved.ok) {
        if (req.query?.allowOutsideWorkspace === 'true') {
          console.warn(`Rejected outside-workspace read: ${resolved.error}`);
        }
        return res.status(400).json({ error: resolved.error });
      }

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase, path, os)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }

      let content = await fsPromises.readFile(canonicalPath, 'utf8');
      // Retry empty reads — concurrent writer may have truncated the file
      // between our stat and read (O_TRUNC window). If the file existed with
      // content at stat time but we read nothing, the writer hasn't finished
      // writing yet.
      if (content.length === 0 && stats.size > 0) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          content = await fsPromises.readFile(canonicalPath, 'utf8');
          if (content.length > 0) break;
        }
        if (content.length === 0) {
          console.warn(`Read retry exhausted for ${canonicalPath}: stat reported ${stats.size} bytes but content is empty`);
        }
      }
      return res.type('text/plain').send(content);
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        if (optional) {
          return res.type('text/plain').send('');
        }
        return res.status(404).json({ error: 'File not found' });
      }
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to read file:', error);
      return res.status(500).json({ error: (error && error.message) || 'Failed to read file' });
    }
  });

  app.get('/api/fs/raw', async (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveReadPathFromContext({
        req,
        targetPath: filePath,
        scope: 'raw',
        resolveProjectDirectory,
        path,
        os,
        fsPromises,
        normalizeDirectoryPath,
        openchamberUserConfigRoot,
      });
      if (!resolved.ok) {
        if (req.query?.allowOutsideWorkspace === 'true') {
          console.warn(`Rejected outside-workspace raw read: ${resolved.error}`);
        }
        return res.status(400).json({ error: resolved.error });
      }

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase, path, os)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }

      const ext = path.extname(canonicalPath).toLowerCase();
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon',
        '.bmp': 'image/bmp',
        '.avif': 'image/avif',
      };
      const mimeType = mimeMap[ext] || 'application/octet-stream';

      const download = req.query.download === 'true';
      if (download) {
        const fileName = path.basename(canonicalPath);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      }

      const content = await fsPromises.readFile(canonicalPath);
      res.setHeader('Cache-Control', 'no-store');
      if (resolved.granted) {
        res.setHeader('Referrer-Policy', 'no-referrer');
      }
      return res.type(mimeType).send(content);
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to read raw file:', error);
      return res.status(500).json({ error: (error && error.message) || 'Failed to read file' });
    }
  });

  app.post('/api/fs/write', async (req, res) => {
    const { path: filePath, content } = req.body || {};
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'Path is required' });
    }
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'Content is required' });
    }

    try {
      const resolved = await resolveWorkspacePathFromContext({
        req,
        targetPath: filePath,
        resolveProjectDirectory,
        path,
        os,
        normalizeDirectoryPath,
        openchamberUserConfigRoot,
      });
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      const writePath = await fsPromises.realpath(resolved.resolved).catch((error) => {
        if (error && typeof error === 'object' && error.code === 'ENOENT') {
          return resolved.resolved;
        }
        throw error;
      });
      const canonicalBase = await fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base));
      if (!isPathWithinRoot(writePath, canonicalBase, path, os)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const existing = await fsPromises.readFile(writePath, 'utf8').catch(() => null);
      if (existing === content) {
        return res.json({ success: true, path: resolved.resolved });
      }

      await fsPromises.mkdir(path.dirname(writePath), { recursive: true });

      // Atomic write: write to temp then rename to avoid concurrent readers
      // seeing an empty file during the O_TRUNC window of direct writeFile.
      const tmp = `${writePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await fsPromises.writeFile(tmp, content, 'utf8');
        await fsPromises.rename(tmp, writePath);
      } catch (error) {
        await fsPromises.unlink(tmp).catch(() => {});
        throw error;
      }
      return res.json({ success: true, path: resolved.resolved });
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return res.status(403).json({ error: 'Access denied' });
      }
      console.error('Failed to write file:', error);
      return res.status(500).json({ error: (error && error.message) || 'Failed to write file' });
    }
  });

  app.post('/api/fs/delete', async (req, res) => {
    const { path: targetPath } = req.body || {};
    if (!targetPath || typeof targetPath !== 'string') {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveWorkspacePathFromContext({
        req,
        targetPath,
        resolveProjectDirectory,
        path,
        os,
        normalizeDirectoryPath,
        openchamberUserConfigRoot,
      });
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      await fsPromises.rm(resolved.resolved, { recursive: true, force: true });
      return res.json({ success: true, path: resolved.resolved });
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File or directory not found' });
      }
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return res.status(403).json({ error: 'Access denied' });
      }
      console.error('Failed to delete path:', error);
      return res.status(500).json({ error: (error && error.message) || 'Failed to delete path' });
    }
  });

  app.post('/api/fs/rename', async (req, res) => {
    const { oldPath, newPath } = req.body || {};
    if (!oldPath || typeof oldPath !== 'string') {
      return res.status(400).json({ error: 'oldPath is required' });
    }
    if (!newPath || typeof newPath !== 'string') {
      return res.status(400).json({ error: 'newPath is required' });
    }

    try {
      const resolvedOld = await resolveWorkspacePathFromContext({
        req,
        targetPath: oldPath,
        resolveProjectDirectory,
        path,
        os,
        normalizeDirectoryPath,
        openchamberUserConfigRoot,
      });
      if (!resolvedOld.ok) {
        return res.status(400).json({ error: resolvedOld.error });
      }

      const resolvedNew = await resolveWorkspacePathFromContext({
        req,
        targetPath: newPath,
        resolveProjectDirectory,
        path,
        os,
        normalizeDirectoryPath,
        openchamberUserConfigRoot,
      });
      if (!resolvedNew.ok) {
        return res.status(400).json({ error: resolvedNew.error });
      }

      if (resolvedOld.base !== resolvedNew.base) {
        return res.status(400).json({ error: 'Source and destination must share the same workspace root' });
      }

      await fsPromises.rename(resolvedOld.resolved, resolvedNew.resolved);
      return res.json({ success: true, path: resolvedNew.resolved });
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Source path not found' });
      }
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return res.status(403).json({ error: 'Access denied' });
      }
      console.error('Failed to rename path:', error);
      return res.status(500).json({ error: (error && error.message) || 'Failed to rename path' });
    }
  });

  app.post('/api/fs/reveal', async (req, res) => {
    const { path: targetPath } = req.body || {};
    if (!targetPath || typeof targetPath !== 'string') {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = path.resolve(targetPath.trim());
      await fsPromises.access(resolved);

      const platform = process.platform;
      if (platform === 'darwin') {
        const stat = await fsPromises.stat(resolved);
        if (stat.isDirectory()) {
          spawn('open', [resolved], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
        } else {
          spawn('open', ['-R', resolved], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
        }
      } else if (platform === 'win32') {
        const stat = await fsPromises.stat(resolved);
        const escapedPath = resolved.replace(/'/g, "''");
        const explorerArg = stat.isDirectory() ? escapedPath : `/select,${escapedPath}`;
        const command = `Start-Process -FilePath explorer.exe -ArgumentList '${explorerArg}'`;
        await new Promise((resolve, reject) => {
          const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
            windowsHide: true,
            stdio: 'ignore',
          });
          child.once('error', reject);
          child.once('exit', (code) => {
            if (code === 0) {
              resolve();
              return;
            }
            reject(new Error(`Explorer launch failed with code ${code ?? 'unknown'}`));
          });
        });
      } else {
        const stat = await fsPromises.stat(resolved);
        const dir = stat.isDirectory() ? resolved : path.dirname(resolved);
        spawn('xdg-open', [dir], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
      }

      return res.json({ success: true, path: resolved });
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Path not found' });
      }
      console.error('Failed to reveal path:', error);
      return res.status(500).json({ error: (error && error.message) || 'Failed to reveal path' });
    }
  });

  app.post('/api/fs/exec', async (req, res) => {
    const { commands, cwd, background } = req.body || {};
    if (!Array.isArray(commands) || commands.length === 0) {
      return res.status(400).json({ error: 'Commands array is required' });
    }
    if (!cwd || typeof cwd !== 'string') {
      return res.status(400).json({ error: 'Working directory (cwd) is required' });
    }

    pruneExecJobs();
    pruneGitReadCache();

    try {
      if (background === true) {
        console.warn('Rejected background /api/fs/exec request');
        return res.status(400).json({ error: 'Background command execution is not allowed' });
      }
      const resolvedCwdCandidate = path.resolve(normalizeDirectoryPath(cwd));
      const resolvedForWorkspace = await resolveWorkspacePathFromContext({
        req,
        targetPath: resolvedCwdCandidate,
        resolveProjectDirectory,
        path,
        os,
        normalizeDirectoryPath,
        openchamberUserConfigRoot,
      });
      if (!resolvedForWorkspace.ok) {
        console.warn(`Rejected /api/fs/exec outside workspace: ${resolvedForWorkspace.error}`);
        return res.status(403).json({ error: resolvedForWorkspace.error });
      }
      const resolvedCwd = resolvedForWorkspace.resolved;
      const stats = await fsPromises.stat(resolvedCwd);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Specified cwd is not a directory' });
      }

      const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
      const shellFlag = process.platform === 'win32' ? '/c' : '-c';

      const jobId = crypto.randomUUID();
      const job = {
        jobId,
        status: 'queued',
        success: null,
        commands,
        resolvedCwd,
        shell,
        shellFlag,
        results: [],
        startedAt: Date.now(),
        finishedAt: null,
        updatedAt: Date.now(),
      };

      execJobs.set(jobId, job);

      const isBackground = false;
      if (isBackground) {
        void runExecJob(job).catch((error) => {
          job.status = 'done';
          job.success = false;
          job.results = Array.isArray(job.results) ? job.results : [];
          job.results.push({
            command: '',
            success: false,
            error: (error && error.message) || 'Command execution failed',
          });
          job.finishedAt = Date.now();
          job.updatedAt = Date.now();
        });

        return res.status(202).json({
          jobId,
          status: 'running',
        });
      }

      await runExecJob(job);
      return res.json({
        jobId,
        status: job.status,
        success: job.success === true,
        results: job.results,
      });
    } catch (error) {
      console.error('Failed to execute commands:', error);
      return res.status(500).json({ error: (error && error.message) || 'Failed to execute commands' });
    }
  });

  app.get('/api/fs/exec/:jobId', (req, res) => {
    const jobId = typeof req.params?.jobId === 'string' ? req.params.jobId : '';
    if (!jobId) {
      return res.status(400).json({ error: 'Job id is required' });
    }

    pruneExecJobs();

    const job = execJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    job.updatedAt = Date.now();
    return res.json({
      jobId: job.jobId,
      status: job.status,
      success: job.success === true,
      results: Array.isArray(job.results) ? job.results : [],
    });
  });

  app.get('/api/fs/list', async (req, res) => {
    const rawPath = typeof req.query.path === 'string' && req.query.path.trim().length > 0
      ? req.query.path.trim()
      : os.homedir();
    const respectGitignore = req.query.respectGitignore === 'true';
    let resolvedPath = '';

    const isPlansDirectory = (value) => {
      if (!value || typeof value !== 'string') return false;
      const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
      return normalized.endsWith('/.opencode/plans') || normalized.endsWith('.opencode/plans');
    };

    try {
      resolvedPath = await realpathCache.resolve(path.resolve(normalizeDirectoryPath(rawPath)));

      const stats = await fsPromises.stat(resolvedPath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Specified path is not a directory' });
      }

      const dirents = await fsPromises.readdir(resolvedPath, { withFileTypes: true });
      let ignoredPaths = new Set();
      if (respectGitignore) {
        try {
          const pathsToCheck = dirents.map((d) => d.name);
          if (pathsToCheck.length > 0) {
            try {
              const result = await new Promise((resolve) => {
                const child = spawn(resolveGitBinaryForSpawn(), ['check-ignore', '--', ...pathsToCheck], {
                  cwd: resolvedPath,
                  windowsHide: true,
                  stdio: ['ignore', 'pipe', 'pipe'],
                });

                let stdout = '';
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

                child.stdout.on('data', (data) => { stdout += data.toString(); });
                child.on('close', () => finish(stdout));
                child.on('error', () => finish(''));
              });

              result.split('\n').filter(Boolean).forEach((name) => {
                const fullPath = path.join(resolvedPath, name.trim());
                ignoredPaths.add(fullPath);
              });
            } catch {
            }
          }
        } catch {
        }
      }

      const entries = await Promise.all(
        dirents.map(async (dirent) => {
          const entryPath = path.join(resolvedPath, dirent.name);
          if (respectGitignore && ignoredPaths.has(entryPath)) {
            return null;
          }

          let isDirectory = dirent.isDirectory();
          const isSymbolicLink = dirent.isSymbolicLink();

          if (!isDirectory && isSymbolicLink) {
            try {
              const linkStats = await fsPromises.stat(entryPath);
              isDirectory = linkStats.isDirectory();
            } catch {
              isDirectory = false;
            }
          }

          return {
            name: dirent.name,
            path: entryPath,
            isDirectory,
            isFile: dirent.isFile(),
            isSymbolicLink,
          };
        })
      );

      return res.json({
        path: resolvedPath,
        entries: entries.filter(Boolean),
      });
    } catch (error) {
      const err = error;
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      const isPlansPath = code === 'ENOENT' && (isPlansDirectory(resolvedPath) || isPlansDirectory(rawPath));
      if (code !== 'ENOENT') {
        console.error('Failed to list directory:', error);
      }
      if (code === 'ENOENT') {
        if (isPlansPath) {
          return res.json({ path: resolvedPath || rawPath, entries: [] });
        }
        return res.status(404).json({ error: 'Directory not found' });
      }
      if (code === 'EACCES') {
        return res.status(403).json({ error: 'Access to directory denied' });
      }
      return res.status(500).json({ error: (error && error.message) || 'Failed to list directory' });
    }
  });
};
