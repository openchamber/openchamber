
import { GIT_LAUNCH_DIRECTORY, gitArgsIn } from '../git/git-launch.js';
import nodePath from 'node:path';
import type { spawn as nodeSpawn, ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

interface WorkspaceFileNameIndexOptions {
  spawn: typeof nodeSpawn;
  resolveGitBinary: () => string;
  ttlMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => number;
}

interface WorkspaceListing {
  loadedAt: number;
  pending: Promise<Map<string, string[]> | null> | null;
  byName: Map<string, string[]> | null;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_WORKSPACES = 8;
const MAX_MATCHES = 20;

export const createWorkspaceFileNameIndex = ({
  spawn,
  resolveGitBinary,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  now = () => Date.now(),
}: WorkspaceFileNameIndexOptions) => {
  const workspaces = new Map<string, WorkspaceListing>();

  const listFiles = (directory: string) => new Promise<string | null>((resolve) => {
    let child: ChildProcessByStdio<null, Readable, null>;
    try {
      child = spawn(resolveGitBinary(), gitArgsIn(directory, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']), {
        cwd: GIT_LAUNCH_DIRECTORY,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > maxOutputBytes) {
        child.kill();
        finish(null);
        return;
      }
      chunks.push(data);
    });
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
    child.on('error', () => finish(null));
  });

  const buildIndex = (output: string | null) => {
    if (output === null) return null;
    const byName = new Map<string, string[]>();
    for (const relative of output.split('\0')) {
      if (!relative) continue;
      const name = nodePath.posix.basename(relative);
      const list = byName.get(name);
      if (!list) byName.set(name, [relative]);
      else if (list.length < MAX_MATCHES && !list.includes(relative)) list.push(relative);
    }
    return byName;
  };

  const load = (directory: string) => {
    const existing = workspaces.get(directory);
    if (existing?.pending) return existing.pending;
    if (existing && now() - existing.loadedAt < ttlMs) return Promise.resolve(existing.byName);
    const pending = listFiles(directory).then((output) => {
      const byName = buildIndex(output);
      workspaces.set(directory, { loadedAt: now(), pending: null, byName });
      return byName;
    });
    workspaces.delete(directory);
    workspaces.set(directory, { loadedAt: 0, pending, byName: null });
    while (workspaces.size > MAX_WORKSPACES) {
      const oldest = workspaces.keys().next();
      if (oldest.done) break;
      workspaces.delete(oldest.value);
    }
    return pending;
  };

  const find = async (directory: string, name: string) => {
    const byName = await load(directory);
    return (byName?.get(name) ?? []).map((relative) => nodePath.join(directory, relative));
  };

  return { find };
};
