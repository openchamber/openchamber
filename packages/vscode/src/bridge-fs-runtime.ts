import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { StringDecoder } from 'node:string_decoder';
import type { BridgeResponse } from './bridge';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type FsAttachment = {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
};

type SkippedAttachment = {
  name: string;
  reason: string;
};

type DroppedReferenceParse =
  | { uri: vscode.Uri }
  | { skipped: SkippedAttachment };

type ReadUriAsAttachmentResult =
  | { file: FsAttachment }
  | { skipped: SkippedAttachment };

type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

type FsExecCommandResult = {
  command: string;
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

// An env value is judged by its whole text, not by what `Number(...)` can
// reinterpret: '' or ' ' must not read as 0, and '1e3', '0x10' or '5.9' must
// not become a number the user never wrote. The web copies of these readers
// judge the same variables this way (`packages/web/server/lib/fs/routes.js`).
const parsePlainDecimalInt = (raw: string | undefined): number | null => {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

export const createGitReadCacheTtlMs = () => {
  const raw = parsePlainDecimalInt(process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS);
  if (raw !== null && raw >= 0) return raw;
  return 30 * 1000;
};

export const createGitCheckIgnoreTimeoutMs = () => {
  const raw = parsePlainDecimalInt(process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS);
  // A delay above Node's timer maximum (2^31 - 1 ms) fires after ~1 ms
  // instead, so a larger configured timeout falls back to the default
  // rather than killing every check-ignore child immediately.
  if (raw !== null && raw >= 0 && raw <= 2_147_483_647) return raw;
  return 2500;
};

// Byte cap for the api:fs:read handler, matching the web twin
// (MAX_READ_BYTES in packages/web/server/lib/fs/routes.js) and the local-fs
// proxy twin (LOCAL_FS_READ_MAX_BYTES in bridge-localfs-proxy-runtime.ts).
export const FS_READ_MAX_BYTES = 16 * 1024 * 1024;

export const FS_EXEC_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

// Per-stream byte cap for api:fs:exec command output, the same cap and env
// var as the web twin in packages/web/server/lib/fs/routes.js. A verbose
// command otherwise grows extension-host memory for the full timeout.
export const createFsExecOutputMaxBytes = () => {
  const raw = parsePlainDecimalInt(process.env.OPENCHAMBER_FS_EXEC_OUTPUT_MAX_BYTES);
  if (raw !== null && raw > 0) return raw;
  return FS_EXEC_OUTPUT_MAX_BYTES;
};

const FS_EXEC_OUTPUT_LIMIT_BYTES = createFsExecOutputMaxBytes();

const normalizeCommand = (command: unknown): string =>
  typeof command === 'string' ? command.trim().replace(/\s+/g, ' ') : '';

const isCacheableGitReadCommand = (command: string): boolean => {
  const normalized = normalizeCommand(command);
  return /^git rev-parse(?: --(?:absolute-git-dir|git-common-dir|show-toplevel)){1,3}$/.test(normalized);
};

const GIT_READ_CACHE_TTL_MS = createGitReadCacheTtlMs();
const GIT_CHECK_IGNORE_TIMEOUT_MS = createGitCheckIgnoreTimeoutMs();
const GIT_READ_CACHE_MAX_ENTRIES = 500;
const GIT_READ_CACHE_MAX_BYTES = 1024 * 1024;
const gitReadCache = new Map<string, { result: FsExecCommandResult; at: number }>();
const inFlightGitReadCache = new Map<string, Promise<FsExecCommandResult>>();

const gitReadEntryBytes = (key: string, result: FsExecCommandResult): number =>
  key.length + (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0);

const setGitReadCacheEntry = (key: string, result: FsExecCommandResult): void => {
  gitReadCache.delete(key);
  gitReadCache.set(key, { result, at: Date.now() });

  let totalBytes = 0;
  for (const [entryKey, entry] of gitReadCache) {
    totalBytes += gitReadEntryBytes(entryKey, entry.result);
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

export const clearGitReadCacheForTests = (): void => {
  gitReadCache.clear();
  inFlightGitReadCache.clear();
};

type FsDeps = {
  resolveUserPath: (value: string, baseDirectory: string) => string;
  listDirectoryEntries: (directoryPath: string) => Promise<DirectoryEntry[]>;
  normalizeFsPath: (value: string) => string;
  execGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  searchDirectory: (
    directory: string,
    query: string,
    limit: number | undefined,
    includeHidden: boolean,
    respectGitignore: boolean,
  ) => Promise<Array<{ name: string; path: string; relativePath: string; extension: string | undefined }>>;
  resolveFileReadPath: (inputPath: string) => Promise<
    | { ok: true; resolvedPath: string }
    | { ok: false; status: number; error: string }
  >;
  parseDroppedFileReference: (rawReference: string) => DroppedReferenceParse;
  readUriAsAttachment: (uri: vscode.Uri, name: string) => Promise<ReadUriAsAttachmentResult>;
};

const runGitCheckIgnore = async (
  execGit: FsDeps['execGit'],
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number } | null> => {
  if (GIT_CHECK_IGNORE_TIMEOUT_MS <= 0) {
    return execGit(args, cwd);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execGit(args, cwd),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), GIT_CHECK_IGNORE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

export async function handleFsBridgeMessage(
  message: BridgeMessageInput,
  deps: FsDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'files:list': {
      const { path: dirPath } = payload as { path: string };
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      const resolvedPath = deps.resolveUserPath(dirPath, workspaceRoot);
      const uri = vscode.Uri.file(resolvedPath);
      const entries = await vscode.workspace.fs.readDirectory(uri);
      const result = entries.map(([name, fileType]) => ({
        name,
        path: vscode.Uri.joinPath(uri, name).fsPath,
        isDirectory: fileType === vscode.FileType.Directory,
      }));
      return { id, type, success: true, data: { directory: deps.normalizeFsPath(resolvedPath), entries: result } };
    }

    case 'files:search': {
      const { query, maxResults = 50 } = payload as { query: string; maxResults?: number };
      const pattern = `**/*${query}*`;
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxResults);
      const results = files.map((file) => ({
        path: file.fsPath,
      }));
      return { id, type, success: true, data: results };
    }

    case 'workspace:folder': {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      return { id, type, success: true, data: { folder } };
    }

    case 'config:get': {
      const { key } = payload as { key: string };
      const config = vscode.workspace.getConfiguration('openchamber');
      const value = config.get(key);
      return { id, type, success: true, data: { value } };
    }

    case 'api:fs:list': {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      const { path: targetPath, respectGitignore } = (payload || {}) as { path?: string; respectGitignore?: boolean };
      const target = targetPath || workspaceRoot;
      const resolvedPath = deps.resolveUserPath(target, workspaceRoot) || workspaceRoot;

      const entries = await deps.listDirectoryEntries(resolvedPath);
      const normalized = deps.normalizeFsPath(resolvedPath);

      if (!respectGitignore) {
        return { id, type, success: true, data: { entries, directory: normalized, path: normalized } };
      }

      const pathsToCheck = entries.map((entry) => entry.name).filter(Boolean);
      if (pathsToCheck.length === 0) {
        return { id, type, success: true, data: { entries, directory: normalized, path: normalized } };
      }

      try {
        const result = await runGitCheckIgnore(deps.execGit, ['check-ignore', '--', ...pathsToCheck], normalized);
        if (!result) {
          return { id, type, success: true, data: { entries, directory: normalized, path: normalized } };
        }
        const ignoredNames = new Set(
          result.stdout
            .split('\n')
            .map((name) => name.trim())
            .filter(Boolean)
        );

        const filteredEntries = entries.filter((entry) => !ignoredNames.has(entry.name));
        return { id, type, success: true, data: { entries: filteredEntries, directory: normalized, path: normalized } };
      } catch {
        return { id, type, success: true, data: { entries, directory: normalized, path: normalized } };
      }
    }

    case 'api:fs:search': {
      const { directory = '', query = '', limit, includeHidden, respectGitignore } = (payload || {}) as {
        directory?: string;
        query?: string;
        limit?: number;
        includeHidden?: boolean;
        respectGitignore?: boolean;
      };
      const files = await deps.searchDirectory(directory, query, limit, Boolean(includeHidden), respectGitignore !== false);
      return { id, type, success: true, data: { files } };
    }

    case 'api:fs:mkdir': {
      const target = (payload as { path: string })?.path;
      if (!target) {
        return { id, type, success: false, error: 'Path is required' };
      }
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      const resolvedPath = deps.resolveUserPath(target, workspaceRoot);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(resolvedPath));
      return { id, type, success: true, data: { success: true, path: deps.normalizeFsPath(resolvedPath) } };
    }

    case 'api:fs/home': {
      return { id, type, success: true, data: { home: deps.normalizeFsPath(os.homedir()) } };
    }

    case 'api:fs:read': {
      const target = (payload as { path: string })?.path;
      if (!target) {
        return { id, type, success: false, error: 'Path is required' };
      }

      const resolution = await deps.resolveFileReadPath(target);
      if (!resolution.ok) {
        return { id, type, success: false, error: resolution.error };
      }

      try {
        const stats = await fs.promises.stat(resolution.resolvedPath);
        if (stats.size > FS_READ_MAX_BYTES) {
          return { id, type, success: false, error: `File exceeds maximum size of ${FS_READ_MAX_BYTES} bytes` };
        }
        // Read at most one byte past the cap, so a file that grows between
        // the stat and the read is refused from a bounded buffer instead of
        // being buffered whole.
        const handle = await fs.promises.open(resolution.resolvedPath, 'r');
        let content: string;
        try {
          const buffer = Buffer.alloc(FS_READ_MAX_BYTES + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.length) {
            const { bytesRead: chunk } = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
            if (chunk === 0) break;
            bytesRead += chunk;
          }
          if (bytesRead > FS_READ_MAX_BYTES) {
            return { id, type, success: false, error: `File exceeds maximum size of ${FS_READ_MAX_BYTES} bytes` };
          }
          content = buffer.toString('utf8', 0, bytesRead);
        } finally {
          await handle.close();
        }
        return { id, type, success: true, data: { content, path: deps.normalizeFsPath(resolution.resolvedPath) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to read file';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:fs:stat': {
      const target = (payload as { path: string })?.path;
      if (!target) {
        return { id, type, success: false, error: 'Path is required' };
      }

      const resolution = await deps.resolveFileReadPath(target);
      if (!resolution.ok) {
        return { id, type, success: false, error: resolution.error };
      }

      try {
        const stats = await fs.promises.stat(resolution.resolvedPath);
        if (!stats.isFile()) {
          return { id, type, success: false, error: 'Specified path is not a file' };
        }

        return {
          id,
          type,
          success: true,
          data: {
            path: deps.normalizeFsPath(resolution.resolvedPath),
            isFile: true,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to stat file';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:fs:write': {
      const { path: targetPath, content } = (payload as { path: string; content: string }) || {};
      if (!targetPath) {
        return { id, type, success: false, error: 'Path is required' };
      }
      if (typeof content !== 'string') {
        return { id, type, success: false, error: 'Content is required' };
      }
      try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const resolvedPath = deps.resolveUserPath(targetPath, workspaceRoot);
        const uri = vscode.Uri.file(resolvedPath);
        const parentUri = vscode.Uri.file(path.dirname(resolvedPath));
        try {
          await vscode.workspace.fs.createDirectory(parentUri);
        } catch {
          // Directory may already exist
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        return { id, type, success: true, data: { success: true, path: deps.normalizeFsPath(resolvedPath) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to write file';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:fs:delete': {
      const targetPath = (payload as { path: string })?.path;
      if (!targetPath) {
        return { id, type, success: false, error: 'Path is required' };
      }
      try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const resolvedPath = deps.resolveUserPath(targetPath, workspaceRoot);
        const uri = vscode.Uri.file(resolvedPath);
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
        return { id, type, success: true, data: { success: true } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete file';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:fs:rename': {
      const { oldPath, newPath } = (payload as { oldPath: string; newPath: string }) || {};
      if (!oldPath) {
        return { id, type, success: false, error: 'oldPath is required' };
      }
      if (!newPath) {
        return { id, type, success: false, error: 'newPath is required' };
      }
      try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const resolvedOld = deps.resolveUserPath(oldPath, workspaceRoot);
        const resolvedNew = deps.resolveUserPath(newPath, workspaceRoot);
        const oldUri = vscode.Uri.file(resolvedOld);
        const newUri = vscode.Uri.file(resolvedNew);
        await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
        return { id, type, success: true, data: { success: true, path: deps.normalizeFsPath(resolvedNew) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to rename file';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:fs:exec': {
      const { commands, cwd } = (payload as { commands: string[]; cwd: string }) || {};
      if (!Array.isArray(commands) || commands.length === 0) {
        return { id, type, success: false, error: 'Commands array is required' };
      }
      if (!cwd) {
        return { id, type, success: false, error: 'Working directory (cwd) is required' };
      }
      try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const resolvedCwd = deps.resolveUserPath(cwd, workspaceRoot);
        const { spawn } = await import('child_process');
        const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
        const shellFlag = process.platform === 'win32' ? '/c' : '-c';

        const augmentedEnv = {
          ...process.env,
          PATH: process.env.PATH,
        };

        // Launch through argv spawn, the same form the web server uses
        // (packages/web/server/lib/fs/routes.js, runCommandInDirectory): the
        // command reaches the shell as a single argv entry and is parsed
        // exactly once. Interpolating it into an exec string instead let an
        // outer shell expand $VAR and $(...) inside the caller's quoting
        // before the intended shell ever ran. On Windows this is
        // spawn('cmd.exe', ['/c', cmd]): cmd.exe still receives the command
        // as one argument and there is no outer shell there either. The
        // timeout and the output cap kill the shell's whole process tree
        // (see killCommandTree below), so no grandchild can outlive it
        // while holding the result's pipes open.
        const runCommand = (cmd: string): Promise<FsExecCommandResult> =>
          new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let timedOut = false;
            let outputTooLarge = false;
            let stdoutTruncated = false;
            let stderrTruncated = false;
            // Decode incrementally per stream: a multi-byte character split
            // across pipe chunks has to survive, and chunk.toString() would
            // turn each half into U+FFFD in the returned output (#1590).
            // Mirrors the web twin in packages/web/server/lib/fs/routes.js
            // (runCommandInDirectory).
            const stdoutDecoder = new StringDecoder('utf8');
            const stderrDecoder = new StringDecoder('utf8');

            const killForOutputLimit = () => {
              if (outputTooLarge) return;
              outputTooLarge = true;
              killCommandTree();
            };

            // Overflow and timeout must end the whole command, not just
            // the shell: a descendant that inherited the pipes keeps them
            // open after the shell dies, and the result resolves on
            // 'close', which waits for pipe EOF -- so a shell-only kill
            // can leave the result unsettled until the descendant exits
            // on its own. The child is spawned detached (its own POSIX
            // process group, the owned-process.ts pattern) and the group
            // is signalled; on Windows taskkill /T ends the tree.
            // Destroying the pipes afterwards settles 'close' promptly
            // even if a descendant escaped the group while holding them.
            const killCommandTree = () => {
              const pid = child.pid;
              // A pid that is not an integer greater than 1 is never
              // group-signalled: kill(-1) would hit every process we
              // may signal, and pid 0 is our own process group.
              const treePid = pid !== undefined && Number.isInteger(pid) && pid > 1 ? pid : null;
              if (process.platform === 'win32') {
                if (treePid !== null) {
                  try {
                    const killer = spawn('taskkill.exe', ['/T', '/F', '/PID', String(treePid)], {
                      windowsHide: true,
                      stdio: 'ignore',
                    });
                    killer.once?.('error', () => {
                      try { child.kill('SIGKILL'); } catch { /* already exited */ }
                    });
                  } catch {
                    try { child.kill('SIGKILL'); } catch { /* already exited */ }
                  }
                } else {
                  try { child.kill('SIGKILL'); } catch { /* already exited */ }
                }
              } else if (treePid !== null) {
                try {
                  process.kill(-treePid, 'SIGKILL');
                } catch {
                  try { child.kill('SIGKILL'); } catch { /* already exited */ }
                }
              } else {
                try { child.kill('SIGKILL'); } catch { /* already exited */ }
              }
              try { child.stdout?.destroy?.(); } catch { /* no pipes to destroy */ }
              try { child.stderr?.destroy?.(); } catch { /* no pipes to destroy */ }
            };

            // Append at most the bytes left under the cap and report
            // overflow, so a capped stream stops at the cap. Bytes go to
            // the stream decoder, which holds a split character until the
            // rest arrives; on truncation the held tail is dropped rather
            // than flushed as a replacement character the cap did not ask
            // for.
            const appendCapped = (current: string, currentBytes: number, chunk: Buffer, decoder: StringDecoder) => {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
              if (currentBytes >= FS_EXEC_OUTPUT_LIMIT_BYTES) {
                return { value: current, bytes: currentBytes, exceeded: true };
              }
              const remaining = FS_EXEC_OUTPUT_LIMIT_BYTES - currentBytes;
              if (buffer.length <= remaining) {
                return { value: current + decoder.write(buffer), bytes: currentBytes + buffer.length, exceeded: false };
              }
              return { value: current + decoder.write(buffer.subarray(0, remaining)), bytes: FS_EXEC_OUTPUT_LIMIT_BYTES, exceeded: true };
            };

            // A stream that ended on its own flushes the decoder tail; a
            // truncated one keeps its last whole character and drops the
            // cut sequence.
            const flushDecoded = (value: string, decoder: StringDecoder, truncated: boolean) =>
              truncated ? value : value + decoder.end();

            let child: ReturnType<typeof spawn>;
            try {
              child = spawn(shell, [shellFlag, cmd], {
                cwd: resolvedCwd,
                env: augmentedEnv,
                windowsHide: true,
                // Own process group so killCommandTree can signal the
                // tree; never on Windows (owned-process.ts pattern).
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
              });
            } catch (error) {
              resolve({
                command: cmd,
                success: false,
                stdout: '',
                stderr: '',
                error: error instanceof Error ? error.message : 'Command execution failed',
              });
              return;
            }

            const timeout = setTimeout(() => {
              timedOut = true;
              killCommandTree();
            }, 300000);

            child.stdout?.on('data', (chunk) => {
              if (outputTooLarge) return;
              const appended = appendCapped(stdout, stdoutBytes, chunk, stdoutDecoder);
              stdout = appended.value;
              stdoutBytes = appended.bytes;
              stdoutTruncated = stdoutTruncated || appended.exceeded;
              if (appended.exceeded) killForOutputLimit();
            });
            child.stderr?.on('data', (chunk) => {
              if (outputTooLarge) return;
              const appended = appendCapped(stderr, stderrBytes, chunk, stderrDecoder);
              stderr = appended.value;
              stderrBytes = appended.bytes;
              stderrTruncated = stderrTruncated || appended.exceeded;
              if (appended.exceeded) killForOutputLimit();
            });

            child.on('error', (error) => {
              clearTimeout(timeout);
              resolve({
                command: cmd,
                success: false,
                stdout: flushDecoded(stdout, stdoutDecoder, stdoutTruncated).trim(),
                stderr: flushDecoded(stderr, stderrDecoder, stderrTruncated).trim(),
                error: error.message || 'Command execution failed',
              });
            });

            child.on('close', (code, signal) => {
              clearTimeout(timeout);
              const result: FsExecCommandResult = {
                command: cmd,
                success: code === 0 && !timedOut,
                stdout: flushDecoded(stdout, stdoutDecoder, stdoutTruncated).trim(),
                stderr: flushDecoded(stderr, stderrDecoder, stderrTruncated).trim(),
              };
              if (typeof code === 'number') {
                result.exitCode = code;
              }
              if (outputTooLarge) {
                result.success = false;
                result.error = `Command output exceeded the ${FS_EXEC_OUTPUT_LIMIT_BYTES} byte limit (output-too-large)`;
              } else if (timedOut) {
                result.error = `Command timed out after 300000ms` + (signal ? ` (${signal})` : '');
              }
              resolve(result);
            });
          });

        const runCommandWithGitReadCache = async (cmd: string): Promise<FsExecCommandResult> => {
          const cacheable = GIT_READ_CACHE_TTL_MS > 0 && isCacheableGitReadCommand(cmd);
          const cacheKey = cacheable ? `${resolvedCwd}\0${normalizeCommand(cmd)}` : null;

          if (cacheKey) {
            const cached = gitReadCache.get(cacheKey);
            if (cached && Date.now() - cached.at < GIT_READ_CACHE_TTL_MS) {
              gitReadCache.delete(cacheKey);
              gitReadCache.set(cacheKey, cached);
              return { ...cached.result, command: cmd };
            }
            if (cached) {
              gitReadCache.delete(cacheKey);
            }

            const inFlight = inFlightGitReadCache.get(cacheKey);
            if (inFlight) {
              const result = await inFlight;
              return { ...result, command: cmd };
            }
          }

          const runPromise = runCommand(cmd).then((result) => {
            if (cacheKey && result.success) {
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

        const results: FsExecCommandResult[] = [];

        for (const cmd of commands) {
          if (typeof cmd !== 'string' || !cmd.trim()) {
            results.push({ command: cmd, success: false, error: 'Invalid command' });
            continue;
          }
          results.push(await runCommandWithGitReadCache(cmd));
        }

        const allSucceeded = results.every((r) => r.success);
        return { id, type, success: true, data: { success: allSucceeded, results } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to execute commands';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:files/pick': {
      const options = payload as { allowMany?: boolean; extensions?: unknown };
      const allowMany = options?.allowMany !== false;
      const extensions = Array.isArray(options?.extensions)
        ? options.extensions.filter((extension): extension is string => typeof extension === 'string' && extension.length > 0)
        : [];
      const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;

      const picks = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: allowMany,
        defaultUri,
        openLabel: 'Attach',
        filters: extensions.length > 0 ? { Files: extensions } : undefined,
      });

      if (!picks || picks.length === 0) {
        return { id, type, success: true, data: { files: [], skipped: [] } };
      }

      const files: FsAttachment[] = [];
      const skipped: SkippedAttachment[] = [];
      for (const uri of picks) {
        const result = await deps.readUriAsAttachment(uri, path.basename(uri.fsPath || uri.path || uri.toString()));
        if ('file' in result) {
          files.push(result.file);
        } else {
          skipped.push(result.skipped);
        }
      }

      return { id, type, success: true, data: { files, skipped } };
    }

    case 'api:files/drop': {
      const references = (payload as { uris?: string[] })?.uris;
      const sourceUris = Array.isArray(references) ? references.filter((entry) => typeof entry === 'string') : [];
      if (sourceUris.length === 0) {
        return { id, type, success: true, data: { files: [], skipped: [] } };
      }

      const files: FsAttachment[] = [];
      const skipped: SkippedAttachment[] = [];
      const dedupedUris = Array.from(new Set(sourceUris.map((entry) => entry.trim()).filter(Boolean)));

      for (const rawUri of dedupedUris) {
        const parsed = deps.parseDroppedFileReference(rawUri);
        if ('skipped' in parsed) {
          skipped.push(parsed.skipped);
          continue;
        }

        const uri = parsed.uri;
        const name = path.basename(uri.fsPath || uri.path || rawUri);

        const result = await deps.readUriAsAttachment(uri, name);
        if ('file' in result) {
          files.push(result.file);
        } else {
          skipped.push(result.skipped);
        }
      }

      return { id, type, success: true, data: { files, skipped } };
    }

    case 'api:files/save-image': {
      const rawFileName = (payload as { fileName?: unknown })?.fileName;
      const rawDataUrl = (payload as { dataUrl?: unknown })?.dataUrl;
      const dataUrl = typeof rawDataUrl === 'string' ? rawDataUrl.trim() : '';
      if (!dataUrl.startsWith('data:image/')) {
        return { id, type, success: false, error: 'Invalid image payload' };
      }

      const defaultFileName = typeof rawFileName === 'string' && rawFileName.trim().length > 0
        ? rawFileName.trim()
        : `message-${Date.now()}.png`;

      const saveUri = await vscode.window.showSaveDialog({
        saveLabel: 'Save image',
        defaultUri: vscode.workspace.workspaceFolders?.[0]
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultFileName)
          : undefined,
        filters: { Images: ['png'] },
      });

      if (!saveUri) {
        return { id, type, success: true, data: { saved: false, canceled: true } };
      }

      const commaIndex = dataUrl.indexOf(',');
      if (commaIndex === -1) {
        return { id, type, success: false, error: 'Invalid image data URL' };
      }

      const base64 = dataUrl.slice(commaIndex + 1);
      const bytes = Buffer.from(base64, 'base64');
      await vscode.workspace.fs.writeFile(saveUri, bytes);

      return { id, type, success: true, data: { saved: true, path: saveUri.fsPath || saveUri.toString() } };
    }

    case 'api:files/save-markdown': {
      const rawFileName = (payload as { fileName?: unknown })?.fileName;
      const rawContent = (payload as { content?: unknown })?.content;
      const content = typeof rawContent === 'string' ? rawContent : '';
      if (!content) {
        return { id, type, success: false, error: 'Invalid markdown payload' };
      }

      const defaultFileName = typeof rawFileName === 'string' && rawFileName.trim().length > 0
        ? rawFileName.trim()
        : `session-${Date.now()}.md`;

      const saveUri = await vscode.window.showSaveDialog({
        saveLabel: 'Export session',
        defaultUri: vscode.workspace.workspaceFolders?.[0]
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultFileName)
          : undefined,
        filters: { Markdown: ['md'] },
      });

      if (!saveUri) {
        return { id, type, success: true, data: { saved: false, canceled: true } };
      }

      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));

      return { id, type, success: true, data: { saved: true, path: saveUri.fsPath || saveUri.toString() } };
    }

    case 'api:fs:reveal': {
      const targetPath = (payload as { path?: unknown })?.path;
      const value = typeof targetPath === 'string' ? targetPath.trim() : '';
      if (!value) {
        return { id, type, success: false, error: 'Path is required' };
      }

      try {
        const uri = value.includes('://') ? vscode.Uri.parse(value) : vscode.Uri.file(value);
        await vscode.commands.executeCommand('revealFileInOS', uri);
        return { id, type, success: true, data: { success: true } };
      } catch {
        return { id, type, success: false, error: 'Failed to reveal path' };
      }
    }

    default:
      return null;
  }
}
