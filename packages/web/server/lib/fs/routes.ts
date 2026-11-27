import { createRealpathCache } from '../path-realpath-cache.js';
import { GIT_LAUNCH_DIRECTORY, gitArgsIn } from '../git/git-launch.js';
import { whileReachable } from '../directory-reachability/while-reachable.js';
import { canonicalDirectoryPath } from './canonical-path.js';
import { containedMkdirPath, containedPathOrChatFolder, containedRenamePaths, containedWritePath, isPathWithinRoot } from './workspace-target.js';
import { redactGitText } from '../git/redaction.js';
import { resolveByteRange } from './byte-range.js';
import { createKeyedSerializer, createTextFileWriter, DanglingLinkError } from './text-write.js';
import { injectPreviewBridge } from './preview-bridge.js';
import { openWindowsFolder, selectInWindowsExplorer } from './windows-shell-open.js';
import { createWorkspaceFileNameIndex } from './workspace-file-names.js';
import { runCommandInDirectory, type CapturedCommandResult, type CommandOptions } from './exec-command.js';
import { createFsSearchRuntime, createGitCheckIgnoreTimeoutMs } from './search.js';
import { createExecJobStore, type CommandResult } from './exec-jobs.js';
import { EXEC_JOB_MAX_OUTPUT_BYTES } from './exec-output.js';
import {
  CONTENT_SEARCH_DEFAULT_LIMIT,
  CONTENT_SEARCH_MAX_LIMIT,
  CONTENT_SEARCH_MAX_QUERY_LENGTH,
  createContentSearchRuntime,
} from './content-search.js';
import { isString } from '../shared/guards.js';
import nodeFsPromises from 'node:fs/promises';
import nodePath from 'node:path';
import type nodeOs from 'node:os';
import type { spawn as nodeSpawn, ChildProcess } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import type { Application, Request, Response } from '../shared/http-contracts.js';
import type { EnvironmentRuntime } from '../environment/runtime.js';
import type { createNetworkOperations } from '../git/network-operations.js';

interface FsBody {
  path?: unknown;
  allowOutsideWorkspace?: unknown;
  unverifiedConfirmed?: unknown;
  remoteUrl?: unknown;
  destinationPath?: unknown;
  gitIdentityId?: unknown;
  paths?: unknown;
  content?: unknown;
  oldPath?: unknown;
  newPath?: unknown;
  commands?: unknown;
  cwd?: unknown;
  background?: unknown;
}

const hasBodyFields = (value: unknown): value is FsBody => value !== null && value !== undefined;
const hasErrorFields = (value: unknown): value is {
  message?: unknown; code?: unknown; status?: unknown; uploadTooLarge?: unknown;
} => value !== null && value !== undefined;
const errorFields = (cause: unknown) => hasErrorFields(cause) ? cause : undefined;
const isStringInput = (value: unknown): value is string => typeof value === 'string';
const isOptionalFileMiss = (value: unknown): value is { code: string } => {
  const code = errorFields(value)?.code;
  return isStringInput(code) && ['ENOENT', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG'].includes(code);
};
const isErrorObject = (value: unknown): value is { code?: unknown; uploadTooLarge?: unknown } =>
  Boolean(value && typeof value === 'object');
const isCallable = (value: unknown): value is (...args: never[]) => void => typeof value === 'function';

interface DirectoryNormalizer {
  (value: string): string;
  <Value>(value: Value): Value | string;
}
const isBoxedString = (value: unknown): value is { trim(): string } =>
  Object.prototype.toString.call(value) === '[object String]';

export interface FsRouteDependencies {
  os: Pick<typeof nodeOs, 'homedir'>;
  path: typeof nodePath;
  fsPromises: typeof nodeFsPromises;
  spawn: typeof nodeSpawn;
  platform?: NodeJS.Platform;
  crypto: Pick<Crypto, 'randomUUID'>;
  normalizeDirectoryPath: DirectoryNormalizer;
  resolveProjectDirectory: (req: Request) => Promise<{
    directory: string | null;
    requestedDirectory?: string | null;
    error?: string | null;
  }>;
  buildAugmentedPath: () => string;
  resolveGitBinaryForSpawn: () => string;
  resolveRipgrepBinary?: () => Promise<string | null>;
  openchamberUserConfigRoot: string;
  managedChatsRoot?: string;
  cloneRepository?: ReturnType<typeof createNetworkOperations>['cloneRepository'];
  environmentRuntime?: EnvironmentRuntime | null;
  projectRealpath?: (value: string) => Promise<string>;
}

interface WorkspacePathOptions {
  targetPath: unknown;
  baseDirectory?: string | null;
  path: typeof nodePath;
  os: FsRouteDependencies['os'];
  normalizeDirectoryPath: FsRouteDependencies['normalizeDirectoryPath'];
}

type WorkspacePathResult = { ok: true; base: string; resolved: string } | { ok: false; error: string };
interface WorkspaceContextOptions extends Omit<WorkspacePathOptions, 'baseDirectory'> {
  req: Request;
  resolveProjectDirectory: FsRouteDependencies['resolveProjectDirectory'];
  fsPromises: typeof nodeFsPromises;
  managedRoots: string[];
  chatsRoots: string[];
  scope?: string;
}

interface PreviewRoot { base: string; readRoot: string }
interface DirectoryStatResult { path: string; isDirectory: boolean; realPath?: string }
interface OutsideFileGrant {
  canonicalPath: string;
  base: string;
  scopes: Set<string>;
  expiresAt: number;
}

const OUTSIDE_FILE_GRANT_TTL_MS = 10 * 60 * 1000;

const outsideFileGrants = new Map<string, OutsideFileGrant>();

const pruneOutsideFileGrants = () => {
  const now = Date.now();
  for (const [token, grant] of outsideFileGrants.entries()) {
    if (!grant || grant.expiresAt <= now) {
      outsideFileGrants.delete(token);
    }
  }
};

const PREVIEW_GRANT_IDLE_TTL_MS = 10 * 60 * 1000;
const PREVIEW_GRANT_MAX_ENTRIES = 256;
const PREVIEW_SANDBOX_POLICY = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';

const createPreviewGrants = ({ crypto = globalThis.crypto, now = () => Date.now() }: {
  crypto?: Pick<Crypto, 'randomUUID'>; now?: () => number;
} = {}) => {
  const grants = new Map<string, PreviewRoot & { expiresAt: number }>();

  const prune = () => {
    const at = now();
    for (const [id, grant] of grants.entries()) {
      if (grant.expiresAt <= at) grants.delete(id);
    }
    while (grants.size >= PREVIEW_GRANT_MAX_ENTRIES) {
      for (const key of grants.keys()) {
        grants.delete(key);
        break;
      }
    }
  };

  return {
    mint: ({ base, readRoot }: PreviewRoot) => {
      prune();
      const grant = crypto.randomUUID();
      const expiresAt = now() + PREVIEW_GRANT_IDLE_TTL_MS;
      grants.set(grant, { base, readRoot, expiresAt });
      return { grant, expiresAt };
    },
    use: (id: string) => {
      const grant = grants.get(id);
      if (!grant) return null;
      if (grant.expiresAt <= now()) {
        grants.delete(id);
        return null;
      }
      grant.expiresAt = now() + PREVIEW_GRANT_IDLE_TTL_MS;
      return grant;
    },
  };
};

const isOsPermissionError = (error: unknown): error is { code: 'EACCES' | 'EPERM' } => Boolean(
  error
  && typeof error === 'object'
  && (errorFields(error)?.code === 'EACCES' || errorFields(error)?.code === 'EPERM')
);

const sendOsPermissionDenied = (res: Response, message: string) => (
  res.status(403).json({ error: message, reason: 'os-permission' })
);

export const mintOutsideFileGrant = async (targetPath: string, {
  scopes = ['stat', 'read', 'raw'],
  fsPromises = nodeFsPromises,
  path = nodePath,
  crypto = globalThis.crypto,
}: {
  scopes?: string[];
  fsPromises?: Pick<typeof nodeFsPromises, 'realpath' | 'stat'>;
  path?: typeof nodePath;
  crypto?: Pick<Crypto, 'randomUUID'>;
} = {}) => {
  const raw = isStringInput(targetPath) ? targetPath.trim() : '';
  if (!raw) {
    throw new Error('Path is required');
  }
  const canonicalPath = await fsPromises.realpath(raw);
  const stats = await fsPromises.stat(canonicalPath);
  if (!stats.isFile()) {
    throw new Error('Outside file grants require a file path');
  }
  pruneOutsideFileGrants();
  const token = isCallable(crypto?.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const normalizedScopes = new Set(
    (Array.isArray(scopes) ? scopes : [])
      .filter((scope) => isStringInput(scope) && scope.trim())
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

const createCommandTimeoutMs = () => {
  const raw = Number(process.env.OPENCHAMBER_FS_EXEC_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 5 * 60 * 1000;
};

const createGitReadCacheTtlMs = () => {
  const raw = Number(process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 30 * 1000;
};

const createUploadMaxBytes = () => {
  const raw = Number(process.env.OPENCHAMBER_FS_UPLOAD_MAX_BYTES);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 100 * 1024 * 1024;
};

const FILE_MIME_MAP: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.mmd': 'text/plain',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
});

const MAX_SERVE_BYTES = 100 * 1024 * 1024;

const streamUploadBody = async (req: Request, handle: FileHandle, maxBytes: number) => {
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > maxBytes) {
      req.resume?.();
      throw Object.assign(new Error('Upload exceeds the maximum allowed size'), { uploadTooLarge: true });
    }

    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
      if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) {
        throw new Error('Failed to write upload');
      }
      offset += bytesWritten;
    }
  }
};

const CACHEABLE_GIT_READ_COMMAND = /^git rev-parse(?: --(?:absolute-git-dir|git-common-dir|show-toplevel)){1,3}$/;
const GIT_READ_CACHE_MAX_ENTRIES = 500;
const GIT_READ_CACHE_MAX_BYTES = 1024 * 1024;

const gitReadEntryBytes = (key: string, result: CommandResult) =>
  key.length + (result?.stdout?.length || 0) + (result?.stderr?.length || 0);

const resolveWorkspacePath = ({ targetPath, baseDirectory, path, os, normalizeDirectoryPath, managedRoots }: WorkspacePathOptions & { managedRoots: string[] }): WorkspacePathResult => {
  const normalized = normalizeDirectoryPath(targetPath);
  if (!normalized || !isStringInput(normalized)) {
    return { ok: false, error: 'Path is required' };
  }

  const resolved = path.resolve(normalized);
  const resolvedBase = path.resolve(baseDirectory || os.homedir());

  if (isPathWithinRoot(resolved, resolvedBase, path, os)) {
    return { ok: true, base: resolvedBase, resolved };
  }

  for (const root of managedRoots) {
    if (isPathWithinRoot(resolved, root, path, os)) {
      return { ok: true, base: path.resolve(root), resolved };
    }
  }

  return { ok: false, error: 'Path is outside of active workspace' };
};

const resolveWorkspacePathFromWorktrees = async ({ targetPath, baseDirectory, path, os, normalizeDirectoryPath }: WorkspacePathOptions): Promise<WorkspacePathResult> => {
  const normalized = normalizeDirectoryPath(targetPath);
  if (!normalized || !isStringInput(normalized)) {
    return { ok: false, error: 'Path is required' };
  }

  const resolved = path.resolve(normalized);
  const resolvedBase = path.resolve(baseDirectory || os.homedir());

  try {
    const { getWorktrees } = await import('../git/index.js');
    const worktrees = await getWorktrees(resolvedBase);

    for (const worktree of worktrees) {
      const candidatePath = worktree.path;
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

const resolveChatsPathWithoutProject = async ({ targetPath, chatsRoots, path, os, fsPromises, normalizeDirectoryPath }: Omit<WorkspaceContextOptions, 'req' | 'resolveProjectDirectory' | 'managedRoots'>) => {
  const resolveIn = (baseDirectory: string) => resolveWorkspacePath({ targetPath, baseDirectory, path, os, normalizeDirectoryPath, managedRoots: [] });
  for (const root of chatsRoots) {
    const lexical = resolveIn(root);
    if (lexical.ok) return lexical;
    if (lexical.error !== 'Path is outside of active workspace') return null;
  }
  for (const root of chatsRoots) {
    try {
      const canonical = resolveIn(await canonicalDirectoryPath(root, fsPromises, path));
      if (canonical.ok) return canonical;
    } catch (error) {
      console.warn('Failed to resolve chats root:', error);
    }
  }
  return null;
};

const resolveWorkspacePathFromContext = async ({ req, targetPath, resolveProjectDirectory, path, os, fsPromises, normalizeDirectoryPath, managedRoots, chatsRoots }: WorkspaceContextOptions): Promise<WorkspacePathResult> => {
  const resolvedProject = await resolveProjectDirectory(req);
  if (!resolvedProject.directory) {
    const chatsPath = await resolveChatsPathWithoutProject({ targetPath, chatsRoots, path, os, fsPromises, normalizeDirectoryPath });
    return chatsPath ?? { ok: false, error: resolvedProject.error || 'Active workspace is required' };
  }

  const resolved = resolveWorkspacePath({
    targetPath,
    baseDirectory: resolvedProject.directory,
    path,
    os,
    normalizeDirectoryPath,
    managedRoots,
  });
  if (resolved.ok || resolved.error !== 'Path is outside of active workspace') {
    return resolved;
  }

  const requestedBase = resolvedProject.requestedDirectory;
  if (requestedBase && requestedBase !== resolvedProject.directory) {
    const lexical = resolveWorkspacePath({
      targetPath,
      baseDirectory: requestedBase,
      path,
      os,
      normalizeDirectoryPath,
      managedRoots,
    });
    if (lexical.ok) {
      return lexical;
    }
  }

  let resolutionError;
  for (const root of managedRoots) {
    try {
      const canonicalRoot = await canonicalDirectoryPath(root, fsPromises, path);
      const normalizedTarget = normalizeDirectoryPath(targetPath);
      if (!isStringInput(normalizedTarget)) return { ok: false, error: 'Path is required' };
      const resolvedPath = path.resolve(normalizedTarget);
      if (isPathWithinRoot(resolvedPath, canonicalRoot, path, os)) {
        return { ok: true, base: canonicalRoot, resolved: resolvedPath };
      }
    } catch (error) {
      resolutionError ??= error;
    }
  }
  const worktree = await resolveWorkspacePathFromWorktrees({
    targetPath,
    baseDirectory: resolvedProject.directory,
    path,
    os,
    normalizeDirectoryPath,
  });
  if (worktree.ok) return worktree;
  if (resolutionError) throw resolutionError;
  return worktree;
};

const GIT_DIRS_MAX_DEPTH = 3;
const GIT_DIRS_MAX_DIRS = 100;
const GIT_DIRS_SKIP_LIST = new Set(['node_modules', 'dist', 'build', '.venv', 'target', '.next']);

const findGitDirectories = async ({ rootPath, fsPromises, path: pathModule, maxDepth, maxDirs }: {
  rootPath: string; fsPromises: typeof nodeFsPromises; path: typeof nodePath; maxDepth: number; maxDirs: number;
}) => {
  const results: string[] = [];
  const walkedRealPaths = new Set<string>();
  const queue = [{ dir: rootPath, depth: 0 }];
  let visited = 0;

  const scanDirectory = async (dir: string, depth: number) => {
    let realPath;
    try {
      realPath = await fsPromises.realpath(dir);
    } catch (error) {
      if (dir === rootPath) {
        throw error;
      }
      return;
    }
    if (walkedRealPaths.has(realPath)) {
      return;
    }
    walkedRealPaths.add(realPath);

    let dirents;
    try {
      dirents = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (dir === rootPath) {
        throw error;
      }
      return;
    }
    visited += 1;

    let isRepoBoundary = false;
    const subdirectories = [];
    for (const dirent of dirents) {
      if (dirent.name === '.git') {
        isRepoBoundary = true;
        continue;
      }
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) {
        continue;
      }
      if (GIT_DIRS_SKIP_LIST.has(dirent.name)) {
        continue;
      }
      if (depth >= maxDepth) {
        continue;
      }
      if (dirent.isSymbolicLink()) {
        const target = await fsPromises.stat(pathModule.join(dir, dirent.name)).catch(() => null);
        if (!target?.isDirectory()) {
          continue;
        }
      }
      subdirectories.push(dirent.name);
    }

    if (isRepoBoundary && dir !== rootPath) {
      results.push(dir);
      return;
    }

    subdirectories.sort();
    for (const name of subdirectories) {
      queue.push({ dir: pathModule.join(dir, name), depth: depth + 1 });
    }
  };

  for (let index = 0; index < queue.length && visited < maxDirs; index += 1) {
    const entry = queue[index];
    if (!entry) break;
    const { dir, depth } = entry;
    await scanDirectory(dir, depth);
  }
  return results;
};

const deriveCloneDirectoryName = (remoteUrl: string) => {
  const remote = remoteUrl.trim();
  if (!remote) return '';
  const withoutQuery = remote.split(/[?#]/, 1)[0] || remote;
  const match = withoutQuery.match(/([^/:]+?)(?:\.git)?\/?$/);
  return match?.[1]?.trim() || '';
};

const resolveReadPathFromContext = async ({ req, targetPath, resolveProjectDirectory, path, os, fsPromises, normalizeDirectoryPath, managedRoots, chatsRoots }: WorkspaceContextOptions): Promise<WorkspacePathResult> => {
  const normalizeReadPath: DirectoryNormalizer = <Value>(value: Value) => (
    value === targetPath && isStringInput(value) && path.isAbsolute(value)
      ? value
      : normalizeDirectoryPath(value)
  );
  if (req.query?.allowOutsideWorkspace === 'true') {
    const normalized = normalizeReadPath(targetPath);
    if (!normalized || !isStringInput(normalized)) {
      return { ok: false, error: 'Path is required' };
    }
    const resolved = path.resolve(normalized);
    return { ok: true, base: path.dirname(resolved), resolved };
  }

  return resolveWorkspacePathFromContext({
    req,
    targetPath,
    resolveProjectDirectory,
    path,
    os,
    fsPromises,
    normalizeDirectoryPath: normalizeReadPath,
    managedRoots,
    chatsRoots,
  });
};

export const registerFsRoutes = (app: Application, dependencies: FsRouteDependencies) => {
  const {
    os,
    path,
    fsPromises,
    spawn,
    platform = process.platform,
    crypto,
    normalizeDirectoryPath,
    resolveProjectDirectory,
    buildAugmentedPath,
    resolveGitBinaryForSpawn,
    resolveRipgrepBinary = async () => null,
    openchamberUserConfigRoot,
    managedChatsRoot,
    cloneRepository,
    environmentRuntime = null,
    projectRealpath = fsPromises.realpath.bind(fsPromises),
  } = dependencies;
  const chatsRoot = managedChatsRoot && managedChatsRoot.trim()
    ? path.resolve(managedChatsRoot.trim())
    : path.join(openchamberUserConfigRoot, 'chats');
  const managedRoots = [path.resolve(openchamberUserConfigRoot), chatsRoot];
  const chatsRoots = [...new Set([chatsRoot, path.join(openchamberUserConfigRoot, 'chats')])];
  const previewGrants = createPreviewGrants({ crypto });
  const realpathCache = createRealpathCache({ realpath: fsPromises.realpath.bind(fsPromises) });
  const writeTextFile = createTextFileWriter(fsPromises);
  const inArrivalOrder = createKeyedSerializer();
  const resolveWorkspaceTarget = (req: Request, targetPath: string) => resolveWorkspacePathFromContext({ fsPromises, req, targetPath, resolveProjectDirectory, path, os, normalizeDirectoryPath, managedRoots, chatsRoots });

  const spawnDetached = (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: 'ignore', detached: true });
    } catch (error) {
      reject(new Error('Failed to launch file browser', { cause: error }));
      return;
    }
    const onError = (error: Error) => {
      child.removeListener('spawn', onSpawn);
      reject(new Error('Failed to launch file browser', { cause: error }));
    };
    const onSpawn = () => {
      child.removeListener('error', onError);
      child.unref();
      resolve();
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });

  const execJobs = createExecJobStore();
  const commandTimeoutMs = createCommandTimeoutMs();
  const gitReadCacheTtlMs = createGitReadCacheTtlMs();
  const gitCheckIgnoreTimeoutMs = createGitCheckIgnoreTimeoutMs();
  const gitReadCache = new Map<string, { result: CapturedCommandResult; at: number; sequence: number }>();
  const inFlightGitReadCache = new Map<string, Promise<CapturedCommandResult>>();
  let gitReadSequence = 0;

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

  const setGitReadCacheEntry = (key: string, result: CapturedCommandResult, sequence: number) => {
    if ((gitReadCache.get(key)?.sequence ?? -1) > sequence) return;
    gitReadCache.delete(key);
    gitReadCache.set(key, { result, at: Date.now(), sequence });

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

  const runCommandWithGitReadCache = async (options: CommandOptions) => {
    const { command, resolvedCwd, maxOutputBytes } = options;
    const normalizedCommand = command.trim().replace(/\s+/g, ' ');
    const gitRead = CACHEABLE_GIT_READ_COMMAND.test(normalizedCommand);
    const run = async () => runCommandInDirectory({
      ...options,
      spawn,
      execEnv: environmentRuntime
        ? await environmentRuntime.applyToDirectory(resolvedCwd, { ...process.env, PATH: buildAugmentedPath() }, { refresh: !gitRead })
        : { ...process.env, PATH: buildAugmentedPath() },
      commandTimeoutMs,
    });
    if (!gitRead || gitReadCacheTtlMs <= 0) return run();

    const cacheKey = `${resolvedCwd}${normalizedCommand}`;
    const cached = gitReadCache.get(cacheKey);
    if (cached) {
      if (Date.now() - cached.at >= gitReadCacheTtlMs) {
        gitReadCache.delete(cacheKey);
      } else if (cached.result.capturedBytes <= maxOutputBytes) {
        gitReadCache.delete(cacheKey);
        gitReadCache.set(cacheKey, cached);
        return { ...cached.result, command };
      }
    }

    const inFlightKey = `${maxOutputBytes}:${cacheKey}`;
    const inFlight = inFlightGitReadCache.get(inFlightKey);
    if (inFlight) {
      const result = await inFlight;
      return { ...result, command };
    }

    const sequence = ++gitReadSequence;
    const runPromise = run().then((result) => {
      if (result.success && !result.outputTruncated) {
        setGitReadCacheEntry(cacheKey, result, sequence);
      }
      return result;
    }).finally(() => {
      inFlightGitReadCache.delete(inFlightKey);
    });
    inFlightGitReadCache.set(inFlightKey, runPromise);
    return runPromise;
  };

  const runExecJob = async (commands: unknown[], options: Omit<CommandOptions, 'command' | 'maxOutputBytes'>) => {
    const results: CommandResult[] = [];
    let maxOutputBytes = EXEC_JOB_MAX_OUTPUT_BYTES;
    for (const command of commands) {
      if (!isStringInput(command) || !command.trim()) {
        results.push({ command, success: false, error: 'Invalid command' });
        continue;
      }

      try {
        const { capturedBytes, ...result } = await runCommandWithGitReadCache({ ...options, command, maxOutputBytes });
        maxOutputBytes -= capturedBytes;
        results.push(result);
      } catch (error) {
        results.push({
          command,
          success: false,
          error: (error && errorFields(error)?.message) || 'Command execution failed',
        });
      }
    }
    return results;
  };

  app.get('/api/fs/home', async (_req, res) => {
    try {
      const home = os.homedir();
      if (!home || home.length === 0) {
        return res.status(500).json({ error: 'Failed to resolve home directory' });
      }
      const [canonicalChatsRoot, canonicalLegacyChatsRoot] = await Promise.all([
        canonicalDirectoryPath(chatsRoot, fsPromises, path),
        canonicalDirectoryPath(path.join(home, '.config', 'openchamber', 'chats'), fsPromises, path).catch((error) => {
          console.warn('Failed to resolve legacy chats root:', error);
          return undefined;
        }),
      ]);
      return res.json({ home, chatsRoot, canonicalChatsRoot, canonicalLegacyChatsRoot });
    } catch (error) {
      console.error('Failed to resolve home directory:', error);
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to resolve home directory' });
    }
  });

  app.post('/api/fs/mkdir', async (req, res) => {
    try {
      const { path: dirPath, allowOutsideWorkspace } = hasBodyFields(req.body) ? req.body : {};
      if (!isStringInput(dirPath) || !dirPath.trim()) {
        return res.status(400).json({ error: 'Path is required' });
      }

      if (allowOutsideWorkspace) {
        console.warn('Rejected outside-workspace mkdir without trusted directory grant');
        return res.status(403).json({ error: 'Outside workspace directory creation requires a grant' });
      }
      const resolved = await resolveWorkspaceTarget(req, dirPath);
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }
      const mkdirPath = await containedMkdirPath(resolved, chatsRoots, { fsPromises, path, os });
      if (!mkdirPath) {
        return res.status(403).json({ error: 'Access denied' });
      }

      await fsPromises.mkdir(mkdirPath, { recursive: true });
      return res.json({ success: true, path: resolved.resolved });
    } catch (error) {
      if (isOsPermissionError(error)) {
        return sendOsPermissionDenied(res, 'Access denied');
      }
      console.error('Failed to create directory:', error);
      return res.status(500).json({ error: errorFields(error)?.message || 'Failed to create directory' });
    }
  });

  app.post('/api/fs/clone', async (req, res) => {
    if (!hasBodyFields(req.body) || req.body.unverifiedConfirmed !== true) {
      return res.status(409).json({ code: 'GIT_NETWORK_OPERATION_REQUIRED',
        error: 'Use a planned clone with explicit transport selection, or explicitly confirm unverified System Git.' });
    }
    try {
      const { remoteUrl, destinationPath, gitIdentityId } = req.body;
      const remote = isStringInput(remoteUrl) ? remoteUrl.trim() : '';
      const destination = isStringInput(destinationPath) ? destinationPath.trim() : '';
      const selectedGitIdentityId = isBoxedString(gitIdentityId)
        ? gitIdentityId.trim() || undefined
        : undefined;
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
          if (!error || errorFields(error)?.code !== 'ENOENT') {
            throw error;
          }
        }
      }
      if (!directoryName || directoryName === '.' || directoryName === '..') {
        return res.status(400).json({ error: 'Destination path must include a directory name' });
      }

      try {
        await fsPromises.access(resolvedDestination);
        return res.status(409).json({ error: 'Destination path already exists' });
      } catch (error) {
        if (!error || errorFields(error)?.code !== 'ENOENT') {
          throw error;
        }
      }

      if (!(cloneRepository instanceof Function)) {
        return res.status(501).json({ error: 'Repository cloning is unavailable' });
      }
      const result = await cloneRepository({
        remoteUrl: remote,
        destinationPath: resolvedDestination,
        gitIdentityId: selectedGitIdentityId,
        unverifiedConfirmed: true,
      });
      if (result.state === 'partial' && result.completedSteps?.includes('checked-out')) {
        return res.status(200).json({ success: false, state: 'partial', setupRequired: true,
          path: resolvedDestination, operationId: result.operationId,
          error: 'Checkout retained. Open Git setup to finish; do not clone again.' });
      }
      if (result.state !== 'succeeded') {
        const conflict = result.error?.code === 'CONFLICT';
        const message = conflict
          ? 'Destination path already exists'
          : redactGitText(result.error?.message || 'Failed to clone repository', {
            secrets: [remote, resolvedDestination],
          });
        return res.status(conflict ? 409 : 500).json({ error: message });
      }

      return res.json({
        success: true,
        path: resolvedDestination,
        output: redactGitText(result.output || '', { secrets: [remote, resolvedDestination] }),
      });
    } catch (error) {
      if (errorFields(error)?.code === 'INVALID_GIT_IDENTITY') {
        return res.status(400).json({ error: 'Selected Git identity is unavailable' });
      }
      if (errorFields(error)?.status === 400 || errorFields(error)?.code === 'INVALID_GIT_NETWORK_OPERATION') {
        return res.status(400).json({ error: 'Repository URL is invalid' });
      }
      if (errorFields(error)?.code === 'CONFLICT' || errorFields(error)?.status === 409) {
        return res.status(409).json({ error: 'Destination path already exists' });
      }
      return res.status(500).json({ error: 'Failed to clone repository' });
    }
  });

  app.get('/api/fs/directory-stat', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const paths = new URL(String(req.url), 'http://openchamber.local').searchParams.getAll('path');
    const directoryPath = paths.length === 1 ? paths[0]?.trim() : '';
    if (!directoryPath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolvedPath = path.resolve(normalizeDirectoryPath(directoryPath));
      const stats = await whileReachable(resolvedPath, () => fsPromises.stat(resolvedPath));
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Specified path is not a directory', reason: 'not-directory' });
      }
      return res.json({ isDirectory: true });
    } catch (error) {
      if (errorFields(error)?.code === 'ENOENT' || errorFields(error)?.code === 'ENOTDIR') {
        return res.status(errorFields(error)?.code === 'ENOENT' ? 404 : 400).json({
          error: errorFields(error)?.code === 'ENOENT' ? 'Directory not found' : 'Specified path is not a directory',
          reason: errorFields(error)?.code === 'ENOENT' ? 'not-found' : 'not-directory',
        });
      }
      if (isOsPermissionError(error)) {
        return sendOsPermissionDenied(res, 'Access to directory denied');
      }
      return res.status(500).json({ error: 'Failed to stat directory' });
    }
  });

  const workspaceFileNames = createWorkspaceFileNameIndex({ spawn, resolveGitBinary: resolveGitBinaryForSpawn });
  app.get('/api/fs/find-by-name', async (req, res) => {
    const name = isStringInput(req.query.name) ? req.query.name.trim() : '';
    if (!name || name.length > 255 || name === '.' || name === '..' || /[/\\*?[\]:]/.test(name)) {
      return res.status(400).json({ error: 'A plain file name is required' });
    }
    const project = await resolveProjectDirectory(req);
    if (!project.directory) {
      return res.status(400).json({ error: project.error || 'Active workspace is required' });
    }
    return res.json({ paths: await workspaceFileNames.find(project.directory, name) });
  });

  app.get('/api/fs/search', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const query = isString(req.query.query) ? String(req.query.query) : '';
    const requestedLimit = isString(req.query.limit) ? Number.parseInt(String(req.query.limit), 10) : Number.NaN;
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(1, requestedLimit), 500)
      : 60;
    const includeHidden = req.query.includeHidden === 'true';
    const respectGitignore = req.query.respectGitignore !== 'false';

    const rawPath = isStringInput(req.query.directory) && req.query.directory.trim().length > 0
      ? req.query.directory.trim()
      : '';
    let requestedPath = '';
    let resolvedPath = '';
    try {
      if (rawPath) {
        requestedPath = path.resolve(normalizeDirectoryPath(rawPath));
      } else {
        const project = await resolveProjectDirectory(req);
        if (!project.directory) {
          return res.status(400).json({ error: project.error || 'Active workspace is required' });
        }
        requestedPath = path.resolve(normalizeDirectoryPath(project.requestedDirectory || project.directory));
      }
      resolvedPath = await realpathCache.resolve(requestedPath);
      const stats = await fsPromises.stat(resolvedPath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Specified path is not a directory', reason: 'not-directory' });
      }
    } catch (error) {
      const err = error;
      const code = isErrorObject(err) && 'code' in err ? err.code : undefined;
      if (code === 'ENOENT') {
        return res.status(404).json({ error: 'Directory not found', reason: 'not-found' });
      }
      if (isOsPermissionError(err)) {
        return sendOsPermissionDenied(res, 'Access to directory denied');
      }
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to search files' });
    }

    const fsSearch = createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn, workspaceSearch: true });
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    if (res.destroyed) abort.abort();
    let results;
    try {
      results = await fsSearch.searchFilesystemFiles(resolvedPath, {
        query,
        limit,
        includeHidden,
        respectGitignore,
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) return undefined;
      throw error;
    }

    const mapped = results.map((file) => ({
      name: file.name,
      path: path.join(requestedPath, file.relativePath),
      relativePath: file.relativePath,
      extension: file.extension,
    }));

    return res.json({ files: mapped });
  });

  const contentSearch = createContentSearchRuntime({ spawn, path, resolveRipgrepBinary });
  app.get('/api/fs/find-in-files', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const query = isString(req.query.query) ? String(req.query.query) : '';
    if (!query.trim() || query.length > CONTENT_SEARCH_MAX_QUERY_LENGTH) {
      return res.status(400).json({ error: 'A search query is required' });
    }
    const requestedLimit = isString(req.query.limit) ? Number.parseInt(String(req.query.limit), 10) : Number.NaN;
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(1, requestedLimit), CONTENT_SEARCH_MAX_LIMIT)
      : CONTENT_SEARCH_DEFAULT_LIMIT;
    const project = await resolveProjectDirectory(req);
    if (!project.directory) {
      return res.status(400).json({ error: project.error || 'Active workspace is required' });
    }

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const result = await contentSearch.searchFileContents(project.directory, {
      resultRoot: project.requestedDirectory,
      query,
      regex: req.query.regex === 'true',
      limit,
      includeHidden: req.query.includeHidden === 'true',
      respectGitignore: req.query.respectGitignore !== 'false',
      signal: abort.signal,
    });
    switch (result.status) {
      case 'ok':
        return res.json({ matches: result.matches, stopped: result.stopped });
      case 'unavailable':
        return res.status(501).json({ error: 'ripgrep is not available on this server', reason: 'search-unavailable' });
      case 'invalid-pattern':
        return res.status(400).json({ error: result.message, reason: 'invalid-pattern' });
      case 'aborted':
        return undefined;
      default:
        return res.status(500).json({ error: result.message, reason: 'search-failed' });
    }
  });

  app.post('/api/fs/directory-stats', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const paths = hasBodyFields(req.body) ? req.body.paths : undefined;
    const requested: unknown[] | null = Array.isArray(paths) ? paths : null;
    const directoryPaths = requested
      ? requested
          .filter((value) => value !== null && value !== undefined)
          .map((value) => String(value).trim())
          .filter((value) => value.length > 0)
      : [];
    if (directoryPaths.length === 0) {
      return res.status(400).json({ error: 'paths array is required' });
    }
    if (directoryPaths.length > 200) {
      return res.status(400).json({ error: 'Too many paths' });
    }

    const results = await Promise.all(directoryPaths.map(async (directoryPath) => {
      try {
        const resolvedPath = path.resolve(normalizeDirectoryPath(directoryPath));
        const stats = await whileReachable(resolvedPath, () => fsPromises.stat(resolvedPath));
        if (!stats.isDirectory()) {
          return { path: directoryPath, isDirectory: false, reason: 'not-directory' };
        }
        const realPath = await whileReachable(resolvedPath, () => projectRealpath(resolvedPath)).catch(() => null);
        const result: DirectoryStatResult = { path: directoryPath, isDirectory: true };
        if (realPath) result.realPath = realPath;
        return result;
      } catch (error) {
        if (errorFields(error)?.code === 'ENOENT' || errorFields(error)?.code === 'ENOTDIR') {
          return { path: directoryPath, isDirectory: false, reason: errorFields(error)?.code === 'ENOENT' ? 'not-found' : 'not-directory' };
        }
        if (isOsPermissionError(error)) {
          return { path: directoryPath, isDirectory: false, reason: 'denied' };
        }
        return { path: directoryPath, isDirectory: false, reason: 'unknown' };
      }
    }));

    return res.json({ results });
  });

  app.get('/api/fs/stat', async (req, res) => {
    const filePath = isStringInput(req.query.path) ? req.query.path : '';
    const optional = req.query.optional === 'true';
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
        managedRoots,
        chatsRoots,
      });
      if (!resolved.ok) {
        if (req.query?.allowOutsideWorkspace === 'true') {
          console.warn(`Rejected outside-workspace stat: ${resolved.error}`);
        }
        return res.status(400).json({ error: resolved.error });
      }

      let canonicalPath;
      let stats;
      try {
        canonicalPath = await fsPromises.realpath(resolved.resolved);
        stats = await fsPromises.stat(canonicalPath);
      } catch (error) {
        if (optional && isOptionalFileMiss(error)) {
          return res.json({ path: filePath, exists: false });
        }
        throw error;
      }
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }

      return res.json({ path: canonicalPath, isFile: true, size: stats.size, mtimeMs: stats.mtimeMs });
    } catch (error) {
      const err = error;
      if (isErrorObject(err) && err.code === 'ENOENT') {
        if (optional) {
          return res.json({ path: filePath, exists: false });
        }
        return res.status(404).json({ error: 'File not found' });
      }
      if (isOsPermissionError(err)) {
        return sendOsPermissionDenied(res, 'Access to file denied');
      }
      console.error('Failed to stat file:', error);
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to stat file' });
    }
  });

  app.get('/api/fs/read', async (req, res) => {
    const filePath = isStringInput(req.query.path) ? req.query.path : '';
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
        managedRoots,
        chatsRoots,
      });
      if (!resolved.ok) {
        if (req.query?.allowOutsideWorkspace === 'true') {
          console.warn(`Rejected outside-workspace read: ${resolved.error}`);
        }
        return res.status(400).json({ error: resolved.error });
      }

      const canonicalPath = await fsPromises.realpath(resolved.resolved);

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }

      let content = await fsPromises.readFile(canonicalPath, 'utf8');
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
      if (isErrorObject(err) && err.code === 'ENOENT') {
        if (optional) {
          return res.type('text/plain').send('');
        }
        return res.status(404).json({ error: 'File not found' });
      }
      if (isOsPermissionError(err)) {
        return sendOsPermissionDenied(res, 'Access to file denied');
      }
      console.error('Failed to read file:', error);
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to read file' });
    }
  });

  app.get('/api/fs/raw', async (req, res) => {
    const filePath = isStringInput(req.query.path) ? req.query.path : '';
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
        managedRoots,
        chatsRoots,
      });
      if (!resolved.ok) {
        if (req.query?.allowOutsideWorkspace === 'true') {
          console.warn(`Rejected outside-workspace raw read: ${resolved.error}`);
        }
        return res.status(400).json({ error: resolved.error });
      }

      const canonicalPath = await fsPromises.realpath(resolved.resolved);

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }

      const ext = path.extname(canonicalPath).toLowerCase();
      const mimeType = FILE_MIME_MAP[ext] || 'application/octet-stream';

      const download = req.query.download === 'true';
      if (download) {
        const fileName = path.basename(canonicalPath);
        const asciiOnly = fileName.replace(/[^\p{ASCII}]/gu, '');
        const fallback = asciiOnly || 'file';
        const encoded = encodeURIComponent(fileName);
        res.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
      }

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Accept-Ranges', 'bytes');

      const range = resolveByteRange(req.headers?.range, stats.size);
      if (range.kind === 'unsatisfiable') {
        res.setHeader('Content-Range', `bytes */${stats.size}`);
        return res.status(416).end();
      }
      res.type(mimeType);
      if (stats.size === 0) {
        res.setHeader('Content-Length', '0');
        return res.end();
      }
      const handle = await fsPromises.open(canonicalPath, 'r');
      const span = range.kind === 'range' ? range : { start: 0, end: stats.size - 1 };
      if (range.kind === 'range') {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${span.start}-${span.end}/${stats.size}`);
      }
      res.setHeader('Content-Length', String(span.end - span.start + 1));
      try {
        const stream = handle.createReadStream({ start: span.start, end: span.end });
        const onResponseClose = () => stream.destroy();
        res.once('close', onResponseClose);
        stream.once('close', () => res.removeListener('close', onResponseClose));
        stream.on('error', (error) => {
          console.error('Failed to stream raw file:', error);
          res.destroy(error);
        });
        if (res.destroyed) {
          stream.destroy();
        } else {
          stream.pipe(res);
        }
      } catch (error) {
        await handle.close();
        throw error;
      }
      return undefined;
    } catch (error) {
      const err = error;
      if (isErrorObject(err) && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      if (isOsPermissionError(err)) {
        return sendOsPermissionDenied(res, 'Access to file denied');
      }
      console.error('Failed to read raw file:', error);
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to read file' });
    }
  });

  app.post('/api/fs/preview', async (req, res) => {
    try {
      const resolved = await resolveReadPathFromContext({
        req,
        targetPath: hasBodyFields(req.body) ? req.body.path : undefined,
        resolveProjectDirectory,
        path,
        os,
        fsPromises,
        normalizeDirectoryPath,
        managedRoots,
        chatsRoots,
      });
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }
      const canonicalPage = await fsPromises.realpath(resolved.resolved);
      const stats = await fsPromises.stat(canonicalPage);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }
      const isManagedBase = managedRoots.some((root) => path.resolve(root) === resolved.base);
      const readRoot = isManagedBase
        ? path.dirname(canonicalPage)
        : await fsPromises.realpath(resolved.base);
      return res.json(previewGrants.mint({ base: resolved.base, readRoot }));
    } catch (error) {
      if (error instanceof Error && errorFields(error)?.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      if (isOsPermissionError(error)) {
        return sendOsPermissionDenied(res, 'Access to file denied');
      }
      console.error('Failed to grant file preview:', error);
      return res.status(500).json({ error: 'Failed to grant file preview' });
    }
  });

  app.get<unknown, { 0: string; 1: string }>(/^\/api\/fs\/preview\/([^/]+)\/(.+)$/, async (req, res) => {
    const grant = previewGrants.use(req.params[0]);
    if (!grant) {
      return res.status(403).json({ error: 'Preview grant is invalid or expired' });
    }

    try {
      const resolved = resolveWorkspacePath({
        targetPath: path.resolve('/', req.params[1]),
        baseDirectory: grant.base,
        path,
        os,
        normalizeDirectoryPath,
        managedRoots,
      });
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      const canonicalPath = await fsPromises.realpath(resolved.resolved);

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }
      if (stats.size > MAX_SERVE_BYTES) {
        return res.status(413).json({ error: 'File too large to serve' });
      }

      const withinReadRoot = isPathWithinRoot(canonicalPath, grant.readRoot, path, os);
      if (req.query?.inline === '1' && !withinReadRoot) return res.status(403).json({ error: 'File is outside preview read root' });
      const ext = path.extname(canonicalPath).toLowerCase();
      const mimeType = FILE_MIME_MAP[ext] || 'application/octet-stream';
      const bytes = await fsPromises.readFile(canonicalPath);
      const content = mimeType === 'text/html' ? injectPreviewBridge(bytes) : bytes;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', PREVIEW_SANDBOX_POLICY);
      if (withinReadRoot && !res.getHeader('Access-Control-Allow-Origin')) res.setHeader('Access-Control-Allow-Origin', 'null');
      return res.type(mimeType).send(content);
    } catch (error) {
      const err = error;
      if (isErrorObject(err) && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      if (isOsPermissionError(err)) {
        return sendOsPermissionDenied(res, 'Access to file denied');
      }
      console.error('Failed to serve file:', error);
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to serve file' });
    }
  });

  app.post('/api/fs/write', async (req, res) => {
    const { path: filePath, content } = hasBodyFields(req.body) ? req.body : {};
    if (!filePath || !isStringInput(filePath)) {
      return res.status(400).json({ error: 'Path is required' });
    }
    if (!isStringInput(content)) {
      return res.status(400).json({ error: 'Content is required' });
    }

    return inArrivalOrder(filePath, async () => {
      try {
        const resolved = await resolveWorkspaceTarget(req, filePath);
        if (!resolved.ok) {
          return res.status(400).json({ error: resolved.error });
        }

        const writePath = await containedWritePath(resolved, { fsPromises, path, os });
        if (!writePath) {
          return res.status(403).json({ error: 'Access denied' });
        }

        await fsPromises.mkdir(path.dirname(writePath), { recursive: true });

        await writeTextFile(writePath, content);
        return res.json({ success: true, path: resolved.resolved });
      } catch (error) {
        const err = error;
        if (err instanceof DanglingLinkError) {
          return res.status(403).json({ error: 'Access denied' });
        }
        if (isOsPermissionError(err)) {
          return sendOsPermissionDenied(res, 'Access denied');
        }
        console.error('Failed to write file:', error);
        return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to write file' });
      }
    });
  });

  app.post('/api/fs/upload', async (req, res) => {
    const filePath = isStringInput(req.query?.path) ? req.query.path.trim() : '';
    const overwrite = req.query?.overwrite === 'true';
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }
    if (!String(req.headers?.['content-type'] || '').toLowerCase().startsWith('application/octet-stream')) {
      return res.status(415).json({ error: 'Content-Type must be application/octet-stream' });
    }

    const maxUploadBytes = createUploadMaxBytes();
    const declaredSize = Number(req.headers?.['content-length']);
    if (Number.isFinite(declaredSize) && declaredSize > maxUploadBytes) {
      req.resume?.();
      return res.status(413).json({
        error: `File exceeds maximum size of ${maxUploadBytes} bytes`,
        reason: 'too-large',
        maxBytes: maxUploadBytes,
      });
    }

    try {
      const resolved = await resolveWorkspaceTarget(req, filePath);
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      const canonicalBase = await fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base));
      const requestedParent = path.dirname(resolved.resolved);
      const canonicalParent = await fsPromises.realpath(requestedParent);
      if (!isPathWithinRoot(canonicalParent, canonicalBase, path, os)) {
        return res.status(403).json({ error: 'Access denied', reason: 'outside-workspace' });
      }

      const existingPath = await fsPromises.realpath(resolved.resolved).catch((error) => {
        if (isErrorObject(error) && error.code === 'ENOENT') {
          return null;
        }
        throw error;
      });
      const writePath = existingPath || path.join(canonicalParent, path.basename(resolved.resolved));
      if (!isPathWithinRoot(writePath, canonicalBase, path, os)) {
        return res.status(403).json({ error: 'Access denied', reason: 'outside-workspace' });
      }

      if (existingPath) {
        const stats = await fsPromises.stat(existingPath);
        if (stats.isDirectory()) {
          return res.status(400).json({ error: 'Specified path is a directory' });
        }
        if (!overwrite) {
          req.resume?.();
          return res.status(409).json({ error: 'File already exists', reason: 'already-exists' });
        }
      }

      const tmp = `${writePath}.upload-${crypto.randomUUID()}`;
      let tempExists = false;
      try {
        const handle = await fsPromises.open(tmp, 'wx');
        tempExists = true;
        let streamError = null;
        try {
          await streamUploadBody(req, handle, maxUploadBytes);
        } catch (error) {
          streamError = error;
        }
        try {
          await handle.close();
        } catch (error) {
          if (!streamError) throw error;
        }
        if (streamError) throw streamError;

        if (overwrite) {
          await fsPromises.rename(tmp, writePath);
        } else {
          await fsPromises.link(tmp, writePath);
          await fsPromises.unlink(tmp).catch(() => {});
        }
        tempExists = false;
      } catch (error) {
        if (tempExists) {
          await fsPromises.unlink(tmp).catch(() => {});
        }
        throw error;
      }

      return res.json({ success: true, path: resolved.resolved });
    } catch (error) {
      const err = error;
      if (isErrorObject(err) && err.code === 'EEXIST') {
        return res.status(409).json({ error: 'File already exists', reason: 'already-exists' });
      }
      if (isErrorObject(err) && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Destination directory not found', reason: 'not-found' });
      }
      if (isErrorObject(err) && err.uploadTooLarge) {
        return res.status(413).json({
          error: `File exceeds maximum size of ${maxUploadBytes} bytes`,
          reason: 'too-large',
          maxBytes: maxUploadBytes,
        });
      }
      if (isErrorObject(err) && (err.code === 'EISDIR' || err.code === 'ENOTDIR')) {
        return res.status(400).json({ error: 'Specified path is a directory' });
      }
      if (isOsPermissionError(err)) {
        return sendOsPermissionDenied(res, 'Access denied');
      }
      console.error('Failed to upload file:', error);
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to upload file' });
    }
  });

  app.post('/api/fs/delete', async (req, res) => {
    const { path: targetPath } = hasBodyFields(req.body) ? req.body : {};
    if (!targetPath || !isStringInput(targetPath)) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveWorkspacePathFromContext({
        fsPromises,
        req,
        targetPath,
        resolveProjectDirectory,
        path,
        os,
        normalizeDirectoryPath,
        managedRoots,
        chatsRoots,
      });
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      const deletePath = await containedPathOrChatFolder(resolved, chatsRoots, { fsPromises, path, os });
      if (!deletePath) {
        return res.status(403).json({ error: 'Access denied' });
      }

      await fsPromises.rm(deletePath, { recursive: true, force: true });
      return res.json({ success: true, path: resolved.resolved });
    } catch (error) {
      const err = error;
      if (isErrorObject(err) && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File or directory not found' });
      }
      if (isOsPermissionError(err)) {
        return sendOsPermissionDenied(res, 'Access denied');
      }
      console.error('Failed to delete path:', error);
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to delete path' });
    }
  });

  app.post('/api/fs/rename', async (req, res) => {
    const { oldPath, newPath } = hasBodyFields(req.body) ? req.body : {};
    if (!oldPath || !isStringInput(oldPath)) {
      return res.status(400).json({ error: 'oldPath is required' });
    }
    if (!newPath || !isStringInput(newPath)) {
      return res.status(400).json({ error: 'newPath is required' });
    }

    try {
      const resolvedOld = await resolveWorkspaceTarget(req, oldPath);
      if (!resolvedOld.ok) {
        return res.status(400).json({ error: resolvedOld.error });
      }

      const resolvedNew = await resolveWorkspaceTarget(req, newPath);
      if (!resolvedNew.ok) {
        return res.status(400).json({ error: resolvedNew.error });
      }

      if (resolvedOld.base !== resolvedNew.base) {
        return res.status(400).json({ error: 'Source and destination must share the same workspace root' });
      }

      const renamePaths = await containedRenamePaths(resolvedOld, resolvedNew, { fsPromises, path, os });
      if (!renamePaths) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (
        resolvedOld.resolved !== resolvedNew.resolved
        && isPathWithinRoot(resolvedNew.resolved, resolvedOld.resolved, path, os)
      ) {
        return res.status(400).json({ error: 'Cannot move a folder into itself' });
      }

      const [sourceStats, destinationStats] = await Promise.all([
        fsPromises.lstat(renamePaths.sourcePath),
        fsPromises.lstat(renamePaths.destinationPath).catch((error) => {
          if (errorFields(error)?.code === 'ENOENT') return null;
          throw error;
        }),
      ]);
      if (destinationStats && (destinationStats.dev !== sourceStats.dev || destinationStats.ino !== sourceStats.ino)) {
        return res.status(409).json({ error: 'Destination path already exists', reason: 'already-exists' });
      }

      await fsPromises.rename(renamePaths.sourcePath, renamePaths.destinationPath);
      return res.json({ success: true, path: resolvedNew.resolved });
    } catch (error) {
      const err = error;
      if (isErrorObject(err) && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Source path not found', reason: 'not-found' });
      }
      if (isOsPermissionError(err)) {
        return sendOsPermissionDenied(res, 'Access denied');
      }
      console.error('Failed to rename path:', error);
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to rename path' });
    }
  });

  app.post('/api/fs/reveal', async (req, res) => {
    const { path: targetPath } = hasBodyFields(req.body) ? req.body : {};
    if (!targetPath || !isStringInput(targetPath)) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = path.resolve(targetPath.trim());
      await fsPromises.access(resolved);

      if (platform === 'darwin') {
        const stat = await fsPromises.stat(resolved);
        if (stat.isDirectory()) {
          await spawnDetached('open', [resolved]);
        } else {
          await spawnDetached('open', ['-R', resolved]);
        }
      } else if (platform === 'win32') {
        const stat = await fsPromises.stat(resolved);
        if (stat.isDirectory()) {
          await openWindowsFolder(spawn, resolved);
        } else {
          await selectInWindowsExplorer(spawn, resolved);
        }
      } else {
        const stat = await fsPromises.stat(resolved);
        const dir = stat.isDirectory() ? resolved : path.dirname(resolved);
        await spawnDetached('xdg-open', [dir]);
      }

      return res.json({ success: true, path: resolved });
    } catch (error) {
      const err = error;
      if (isErrorObject(err) && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Path not found' });
      }
      if (isOsPermissionError(err)) {
        return sendOsPermissionDenied(res, 'Access to path denied');
      }
      console.error('Failed to reveal path:', error);
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to reveal path' });
    }
  });

  app.post('/api/fs/exec', async (req, res) => {
    const { commands, cwd, background } = hasBodyFields(req.body) ? req.body : {};
    if (!Array.isArray(commands) || commands.length === 0) {
      return res.status(400).json({ error: 'Commands array is required' });
    }
    if (!cwd || !isStringInput(cwd)) {
      return res.status(400).json({ error: 'Working directory (cwd) is required' });
    }

    pruneGitReadCache();

    try {
      if (background === true) {
        console.warn('Rejected background /api/fs/exec request');
        return res.status(400).json({ error: 'Background command execution is not allowed' });
      }
      const resolvedCwdCandidate = path.resolve(normalizeDirectoryPath(cwd));
      const resolvedForWorkspace = await resolveWorkspaceTarget(req, resolvedCwdCandidate);
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
      const results = await runExecJob(commands, { shell, shellFlag, resolvedCwd });
      return res.type('application/json').send(execJobs.complete(jobId, results));
    } catch (error) {
      console.error('Failed to execute commands:', error);
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to execute commands' });
    }
  });

  app.get('/api/fs/exec/:jobId', (req, res) => {
    const jobId = isStringInput(req.params?.jobId) ? req.params.jobId : '';
    if (!jobId) {
      return res.status(400).json({ error: 'Job id is required' });
    }

    const body = execJobs.get(jobId);
    if (!body) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.type('application/json').send(body);
  });

  app.get('/api/fs/list', async (req, res) => {
    const rawPath = isStringInput(req.query.path) && req.query.path.trim().length > 0
      ? req.query.path.trim()
      : os.homedir();
    const respectGitignore = req.query.respectGitignore === 'true';
    let requestedPath = '';
    let resolvedPath = '';

    const isPlansDirectory = (value: string) => {
      if (!value) return false;
      const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
      return normalized.endsWith('/.opencode/plans') || normalized.endsWith('.opencode/plans');
    };

    try {
      requestedPath = path.resolve(normalizeDirectoryPath(rawPath));
      resolvedPath = await realpathCache.resolve(requestedPath);

      const stats = await fsPromises.stat(resolvedPath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Specified path is not a directory', reason: 'not-directory' });
      }

      const dirents = await fsPromises.readdir(resolvedPath, { withFileTypes: true });
      const ignoredPaths = new Set<string>();
      if (respectGitignore) {
        try {
          const pathsToCheck = dirents.map((d) => d.name);
          if (pathsToCheck.length > 0) {
            try {
              const result = await new Promise<string>((resolve) => {
                const child = spawn(resolveGitBinaryForSpawn(), gitArgsIn(resolvedPath, ['check-ignore', '--', ...pathsToCheck]), {
                  cwd: GIT_LAUNCH_DIRECTORY,
                  windowsHide: true,
                  stdio: ['ignore', 'pipe', 'ignore'],
                });

                let stdout = '';
                let settled = false;
                let timeout: ReturnType<typeof setTimeout> | null = null;
                const finish = (value: string) => {
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
                      void 0;
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
              void 0;
            }
          }
        } catch {
          void 0;
        }
      }

      const entries = await Promise.all(
        dirents.map(async (dirent) => {
          const physicalEntryPath = path.join(resolvedPath, dirent.name);
          if (respectGitignore && ignoredPaths.has(physicalEntryPath)) {
            return null;
          }

          let isDirectory = dirent.isDirectory();
          const isSymbolicLink = dirent.isSymbolicLink();

          if (!isDirectory && isSymbolicLink) {
            try {
              const linkStats = await fsPromises.stat(physicalEntryPath);
              isDirectory = linkStats.isDirectory();
            } catch {
              isDirectory = false;
            }
          }

          return {
            name: dirent.name,
            path: path.join(requestedPath, dirent.name),
            isDirectory,
            isFile: dirent.isFile(),
            isSymbolicLink,
          };
        })
      );

      return res.json({
        path: requestedPath,
        entries: entries.filter(Boolean),
      });
    } catch (error) {
      const err = error;
      const code = isErrorObject(err) && 'code' in err ? err.code : undefined;
      const isPlansPath = code === 'ENOENT' && (
        isPlansDirectory(resolvedPath)
        || isPlansDirectory(requestedPath)
        || isPlansDirectory(rawPath)
      );
      if (code !== 'ENOENT') {
        console.error('Failed to list directory:', error);
      }
      if (code === 'ENOENT') {
        if (isPlansPath) {
          return res.json({ path: requestedPath || resolvedPath || rawPath, entries: [] });
        }
        return res.status(404).json({ error: 'Directory not found', reason: 'not-found' });
      }
      if (isOsPermissionError(err)) {
        return sendOsPermissionDenied(res, 'Access to directory denied');
      }
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to list directory' });
    }
  });

  app.get('/api/fs/git-dirs', async (req, res) => {
    const rawPath = isStringInput(req.query.path) && req.query.path.trim().length > 0
      ? req.query.path.trim()
      : '';
    if (!rawPath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveWorkspaceTarget(req, rawPath);
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      const stats = await fsPromises.stat(resolved.resolved);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Specified path is not a directory', reason: 'not-directory' });
      }

      const repositories = await findGitDirectories({
        rootPath: resolved.resolved,
        fsPromises,
        path,
        maxDepth: GIT_DIRS_MAX_DEPTH,
        maxDirs: GIT_DIRS_MAX_DIRS,
      });

      return res.json({
        path: resolved.resolved,
        repositories: repositories.map((repoPath) => ({
          path: repoPath,
          name: path.basename(repoPath),
        })),
      });
    } catch (error) {
      const err = error;
      const code = isErrorObject(err) && 'code' in err ? err.code : undefined;
      if (code === 'ENOENT') {
        return res.status(404).json({ error: 'Directory not found', reason: 'not-found' });
      }
      if (isOsPermissionError(err)) {
        return sendOsPermissionDenied(res, 'Access to directory denied');
      }
      console.error('Failed to find git directories:', error);
      return res.status(500).json({ error: (error && errorFields(error)?.message) || 'Failed to find git directories' });
    }
  });
};
