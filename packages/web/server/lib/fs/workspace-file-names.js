// Workspace files by name, for linking a bare file name an agent wrote
// (`Renderer.tsx:42`) to the one file it means.
//
// git is slow to start and, on Windows, slow to walk the working tree for
// untracked files, so one `git ls-files` per workspace serves every name for a
// short while, concurrent lookups share it, it has a deadline, and a listing
// too large to hold is dropped rather than kept. Outside a repository, or when
// git fails, every lookup answers no match.

import nodePath from 'node:path';

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
}) => {
  // directory -> { loadedAt, pending, byName: Map<name, relative[]> | null }
  const workspaces = new Map();

  const listFiles = (directory) => new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveGitBinary(), ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: directory,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (data) => {
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

  const buildIndex = (output) => {
    if (output === null) return null;
    const byName = new Map();
    for (const relative of output.split('\0')) {
      if (!relative) continue;
      const name = nodePath.posix.basename(relative);
      const list = byName.get(name);
      if (!list) byName.set(name, [relative]);
      else if (list.length < MAX_MATCHES && !list.includes(relative)) list.push(relative);
    }
    return byName;
  };

  const load = (directory) => {
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
      workspaces.delete(workspaces.keys().next().value);
    }
    return pending;
  };

  /** Absolute paths of the workspace files called `name`, at most 20. */
  const find = async (directory, name) => {
    const byName = await load(directory);
    return (byName?.get(name) ?? []).map((relative) => nodePath.join(directory, relative));
  };

  return { find };
};
