import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execGit } from './bridge-git-process-runtime';

const MAX_FILE_ATTACH_SIZE_BYTES = 10 * 1024 * 1024;

const guessMimeTypeFromExtension = (ext: string) => {
  switch (ext) {
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.bmp':
    case '.webp':
      return `image/${ext.replace('.', '')}`;
    case '.pdf':
      return 'application/pdf';
    case '.txt':
    case '.log':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.md':
    case '.markdown':
      return 'text/markdown';
    default:
      return 'application/octet-stream';
  }
};

const hasUriScheme = (value: string): boolean => /^[A-Za-z][A-Za-z\d+.-]*:/.test(value);

export const parseDroppedFileReference = (rawReference: string):
  | { uri: vscode.Uri }
  | { skipped: { name: string; reason: string } } => {
  const trimmed = rawReference.trim().replace(/^['"]+|['"]+$/g, '');
  if (!trimmed) {
    return { skipped: { name: rawReference, reason: 'Empty drop reference' } };
  }

  if (hasUriScheme(trimmed)) {
    try {
      const parsed = vscode.Uri.parse(trimmed, true);
      if (parsed.scheme !== 'file') {
        return {
          skipped: {
            name: trimmed,
            reason: `Unsupported URI scheme: ${parsed.scheme || 'unknown'}`,
          },
        };
      }
      return { uri: parsed };
    } catch (error) {
      return {
        skipped: {
          name: trimmed,
          reason: error instanceof Error ? error.message : 'Invalid URI',
        },
      };
    }
  }

  if (!path.isAbsolute(trimmed)) {
    return {
      skipped: {
        name: trimmed,
        reason: 'Drop reference is not an absolute file path',
      },
    };
  }

  return { uri: vscode.Uri.file(trimmed) };
};

export const readUriAsAttachment = async (
  uri: vscode.Uri,
  fallbackName?: string,
): Promise<
  | { file: { name: string; mimeType: string; size: number; dataUrl: string } }
  | { skipped: { name: string; reason: string } }
> => {
  const name = path.basename(uri.fsPath || uri.path || fallbackName || 'file');

  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      return { skipped: { name, reason: 'Folders are not supported' } };
    }

    const size = stat.size ?? 0;
    if (size > MAX_FILE_ATTACH_SIZE_BYTES) {
      return { skipped: { name, reason: 'File exceeds 10MB limit' } };
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    const ext = path.extname(name).toLowerCase();
    const mimeType = guessMimeTypeFromExtension(ext);
    const base64 = Buffer.from(bytes).toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return { file: { name, mimeType, size, dataUrl } };
  } catch (error) {
    return { skipped: { name, reason: error instanceof Error ? error.message : 'Failed to read file' } };
  }
};

const isPathInside = (candidatePath: string, parentPath: string): boolean => {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedParent = path.resolve(parentPath);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
};

export const normalizeFsPath = (value: string) => value.replace(/\\/g, '/');

const gitCheckIgnoreNames = async (cwd: string, names: string[]): Promise<Set<string>> => {
  if (names.length === 0) {
    return new Set();
  }

  const result = await execGit(['check-ignore', '--', ...names], cwd);
  if (result.exitCode !== 0 || !result.stdout) {
    return new Set();
  }

  return new Set(
    result.stdout
      .split('\n')
      .map((name: string) => name.trim())
      .filter(Boolean),
  );
};

const gitCheckIgnorePaths = async (cwd: string, paths: string[]): Promise<Set<string>> => {
  if (paths.length === 0) {
    return new Set();
  }

  const result = await execGit(['check-ignore', '--', ...paths], cwd);
  if (result.exitCode !== 0 || !result.stdout) {
    return new Set();
  }

  return new Set(
    result.stdout
      .split('\n')
      .map((name: string) => name.trim())
      .filter(Boolean),
  );
};

const expandTildePath = (value: string) => {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed === '~') {
    return os.homedir();
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return trimmed;
};

export const resolveUserPath = (value: string, baseDirectory: string) => {
  const expanded = expandTildePath(value);
  if (!expanded) {
    return expanded;
  }
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(baseDirectory, expanded);
};

export const listDirectoryEntries = async (dirPath: string) => {
  const uri = vscode.Uri.file(dirPath);
  const entries = await vscode.workspace.fs.readDirectory(uri);
  return entries.map(([name, fileType]) => ({
    name,
    path: normalizeFsPath(vscode.Uri.joinPath(uri, name).fsPath),
    isDirectory: fileType === vscode.FileType.Directory,
  }));
};

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

const shouldSkipSearchDirectory = (name: string, includeHidden: boolean) => {
  if (!name) {
    return false;
  }
  if (!includeHidden && name.startsWith('.')) {
    return true;
  }
  return FILE_SEARCH_EXCLUDED_DIRS.has(name.toLowerCase());
};

const fuzzyMatchScore = (query: string, candidate: string): number | null => {
  if (!query) return 0;

  const q = query.toLowerCase();
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

  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (!ch || ch === ' ') continue;

    const idx = c.indexOf(ch, lastIndex + 1);
    if (idx === -1) {
      return null;
    }

    const gap = idx - lastIndex - 1;
    if (gap === 0) {
      consecutive++;
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

const searchFilesystemFiles = async (
  rootPath: string,
  query: string,
  limit: number,
  includeHidden: boolean,
  respectGitignore: boolean,
  timeBudgetMs?: number,
) => {
  const normalizedQuery = (query || '').trim().toLowerCase();
  const matchAll = normalizedQuery.length === 0;
  const deadline = typeof timeBudgetMs === 'number' && timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;

  const rootUri = vscode.Uri.file(rootPath);
  const queue: vscode.Uri[] = [rootUri];
  const visited = new Set<string>([normalizeFsPath(rootUri.fsPath)]);
  const collectLimit = matchAll ? limit : Math.max(limit * 3, 200);
  const candidates: Array<{ name: string; path: string; relativePath: string; extension?: string; score: number }> = [];
  const MAX_CONCURRENCY = 10;

  while (queue.length > 0 && candidates.length < collectLimit) {
    if (deadline && Date.now() > deadline) {
      break;
    }
    const batch = queue.splice(0, MAX_CONCURRENCY);
    const dirLists = await Promise.all(
      batch.map((dir) => Promise.resolve(vscode.workspace.fs.readDirectory(dir)).catch(() => [] as [string, vscode.FileType][])),
    );

    for (let index = 0; index < batch.length; index += 1) {
      if (deadline && Date.now() > deadline) {
        break;
      }
      const currentDir = batch[index];
      const dirents = dirLists[index];

      const ignoredNames = respectGitignore
        ? await gitCheckIgnoreNames(normalizeFsPath(currentDir.fsPath), dirents.map(([name]) => name))
        : new Set<string>();

      for (const [entryName, entryType] of dirents) {
        if (!entryName || (!includeHidden && entryName.startsWith('.'))) {
          continue;
        }

        if (respectGitignore && ignoredNames.has(entryName)) {
          continue;
        }

        const entryUri = vscode.Uri.joinPath(currentDir, entryName);
        const absolute = normalizeFsPath(entryUri.fsPath);

        if (entryType === vscode.FileType.Directory) {
          if (shouldSkipSearchDirectory(entryName, includeHidden)) {
            continue;
          }
          if (!visited.has(absolute)) {
            visited.add(absolute);
            queue.push(entryUri);
          }
          continue;
        }

        if (entryType !== vscode.FileType.File) {
          continue;
        }

        const relativePath = normalizeFsPath(path.relative(rootPath, absolute) || path.basename(absolute));
        const extension = entryName.includes('.') ? entryName.split('.').pop()?.toLowerCase() : undefined;

        if (matchAll) {
          candidates.push({
            name: entryName,
            path: absolute,
            relativePath,
            extension,
            score: 0,
          });
        } else {
          const score = fuzzyMatchScore(normalizedQuery, relativePath);
          if (score !== null) {
            candidates.push({
              name: entryName,
              path: absolute,
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

export const searchDirectory = async (
  directory: string,
  query: string,
  limit = 60,
  includeHidden = false,
  respectGitignore = true,
) => {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  const rootPath = directory
    ? resolveUserPath(directory, workspaceRoot)
    : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (!rootPath) return [];

  const sanitizedQuery = query?.trim() || '';
  if (!sanitizedQuery) {
    return searchFilesystemFiles(rootPath, '', limit, includeHidden, respectGitignore);
  }

  const escapeGlob = (value: string) => value
    .replace(/[\\{}()?*]/g, '\\$&')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
  const exclude = '**/{node_modules,.git,dist,build,.next,.turbo,.cache,coverage,tmp,logs}/**';
  const mapResults = (results: vscode.Uri[]) => results.map((file) => {
    const absolute = normalizeFsPath(file.fsPath);
    const relative = normalizeFsPath(path.relative(rootPath, absolute));
    const name = path.basename(absolute);
    return {
      name,
      path: absolute,
      relativePath: relative || name,
      extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined,
    };
  });
  const filterGitIgnored = async (results: vscode.Uri[]) => {
    if (!respectGitignore || results.length === 0) {
      return results;
    }

    const relativePaths = results.map((file) => {
      const relative = normalizeFsPath(path.relative(rootPath, file.fsPath));
      return relative || path.basename(file.fsPath);
    });

    const ignored = await gitCheckIgnorePaths(rootPath, relativePaths);
    if (ignored.size === 0) {
      return results;
    }

    return results.filter((_, index) => !ignored.has(relativePaths[index]));
  };

  try {
    const escapedQuery = escapeGlob(sanitizedQuery);
    const pattern = `**/*${escapedQuery}*`;
    const results = await vscode.workspace.findFiles(
      new vscode.RelativePattern(vscode.Uri.file(rootPath), pattern),
      exclude,
      limit,
    );

    if (Array.isArray(results) && results.length > 0) {
      const visible = includeHidden ? results : results.filter((file) => !path.basename(file.fsPath).startsWith('.'));
      const filtered = await filterGitIgnored(visible);
      if (filtered.length > 0) {
        return mapResults(filtered);
      }
    }

    if (sanitizedQuery.length >= 2 && sanitizedQuery.length <= 32) {
      const fuzzyPattern = `**/*${escapedQuery.split('').join('*')}*`;
      const fuzzyResults = await vscode.workspace.findFiles(
        new vscode.RelativePattern(vscode.Uri.file(rootPath), fuzzyPattern),
        exclude,
        limit,
      );

      if (Array.isArray(fuzzyResults) && fuzzyResults.length > 0) {
        const visible = includeHidden ? fuzzyResults : fuzzyResults.filter((file) => !path.basename(file.fsPath).startsWith('.'));
        const filtered = await filterGitIgnored(visible);
        if (filtered.length > 0) {
          return mapResults(filtered);
        }
      }
    }
  } catch {
    // Fall through to filesystem traversal.
  }

  return searchFilesystemFiles(rootPath, sanitizedQuery, limit, includeHidden, respectGitignore, 1500);
};

export const fetchModelsMetadata = async () => {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), 8000) : undefined;
  try {
    const response = await fetch('https://models.dev/api.json', {
      signal: controller?.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`models.dev responded with ${response.status}`);
    }
    return await response.json();
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const getFsAccessRoot = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();

export const getFsMimeType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.markdown': 'text/markdown; charset=utf-8',
    '.mmd': 'text/plain; charset=utf-8',
    '.mermaid': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.pdf': 'application/pdf',
  };
  return mimeMap[ext] || 'application/octet-stream';
};

export type FsReadPathResolution =
  | { ok: true; resolvedPath: string }
  | { ok: false; status: number; error: string };

export const resolveFileReadPath = async (targetPath: string): Promise<FsReadPathResolution> => {
  const trimmed = targetPath.trim();
  if (!trimmed) {
    return { ok: false, status: 400, error: 'Path is required' };
  }

  const baseRoot = getFsAccessRoot();
  const resolved = resolveUserPath(trimmed, baseRoot);
  if (!resolved) {
    return { ok: false, status: 400, error: 'Path is required' };
  }

  try {
    const [canonicalPath, canonicalBase] = await Promise.all([
      fs.promises.realpath(resolved),
      fs.promises.realpath(baseRoot).catch(() => path.resolve(baseRoot)),
    ]);

    if (!isPathInside(canonicalPath, canonicalBase)) {
      return { ok: false, status: 403, error: 'Access to file denied' };
    }

    return { ok: true, resolvedPath: canonicalPath };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      return { ok: false, status: 404, error: 'File not found' };
    }
    return { ok: false, status: 500, error: 'Failed to resolve file path' };
  }
};
