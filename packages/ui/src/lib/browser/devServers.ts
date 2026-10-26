/**
 * Client for dev-server discovery.
 *
 * The result is a tagged union rather than an array, because "no dev server is
 * running" and "we could not look" lead to different UI and must not collapse
 * into the same empty list.
 */
import { z } from 'zod';

import { normalizePath } from '@/lib/pathNormalization';
import { runtimeFetch } from '@/lib/runtime-fetch';

const discoveredServerSchema = z.object({
  port: z.number().int().positive(),
  url: z.string().min(1),
  command: z.string(),
  /** The folder the process runs in; absent where the server could not tell. */
  directory: z.string().min(1).optional(),
});

type DiscoveredDevServer = z.infer<typeof discoveredServerSchema>;

export type DevServerDiscovery =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly servers: ReadonlyArray<DiscoveredDevServer> }
  | { readonly kind: 'unavailable' };

const parseServers = (value: unknown): DiscoveredDevServer[] | null => {
  const body = z.object({ servers: z.array(z.unknown()) }).safeParse(value);
  if (!body.success) return null;
  return body.data.servers.flatMap((entry) => {
    const server = discoveredServerSchema.safeParse(entry);
    return server.success ? [server.data] : [];
  });
};

/**
 * The servers listening where this directory's code runs: on the host, or
 * inside the isolated space that owns the directory, which the request is
 * addressed to by its directory.
 */
export const fetchDevServers = async (signal: AbortSignal | undefined, directory: string): Promise<DevServerDiscovery> => {
  try {
    const response = await runtimeFetch('/api/dev-servers', { signal, directory });
    if (!response.ok) return { kind: 'unavailable' };

    const servers = parseServers(await response.json());
    return servers ? { kind: 'ready', servers } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
};

/**
 * Asks the server for the HTTP status a loopback URL currently returns.
 *
 * A dev server fronted by a gateway answers requests before the app behind it
 * is up, returning a 5xx page. That is a successful load as far as the browser
 * is concerned, so it produces no navigation failure — the status is the only
 * honest signal, short of reading the page and guessing from its contents.
 *
 * Returns null when the status could not be established.
 */
export const probeLoopbackStatus = async (url: string): Promise<number | null> => {
  try {
    const response = await runtimeFetch('/api/system/probe-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') return null;
    const status = (body as { status?: unknown }).status;
    return typeof status === 'number' && Number.isFinite(status) ? status : null;
  } catch {
    return null;
  }
};

type DevServerCandidate = {
  readonly url: string;
  readonly port: number;
  /** Present when a server announced this address itself. */
  readonly announced: boolean;
  /** The folder the process runs in, when discovery could tell. */
  readonly directory?: string;
};

const portOf = (url: string): number | null => {
  try {
    const parsed = new URL(url);
    const port = Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
};

/**
 * Combines what servers said with what is actually listening.
 *
 * Each source knows something the other cannot. An announcement carries the base
 * path an app is served under, which a socket cannot reveal. A listening port is
 * ground truth, which an announcement is not: terminals wrap long lines, and a
 * URL split mid-port reads as a perfectly plausible address on a port where
 * nothing is running.
 *
 * So discovery decides which servers exist and announcements supply their paths.
 * When discovery is unavailable the announcements stand on their own — offering
 * something unverified beats offering nothing.
 */
export const mergeDevServerCandidates = ({
  announced,
  discovered,
}: {
  announced: ReadonlyArray<string>;
  discovered: ReadonlyArray<DiscoveredDevServer> | null;
}): DevServerCandidate[] => {
  const announcedByPort = new Map<number, string>();
  for (const url of announced) {
    const port = portOf(url);
    if (port !== null && !announcedByPort.has(port)) announcedByPort.set(port, url);
  }

  if (!discovered) {
    return [...announcedByPort.entries()]
      .map(([port, url]) => ({ url, port, announced: true }))
      .sort((left, right) => left.port - right.port);
  }

  return discovered
    .map((server) => {
      const announcedUrl = announcedByPort.get(server.port);
      return {
        url: announcedUrl ?? server.url,
        port: server.port,
        announced: announcedUrl !== undefined,
        directory: server.directory,
      };
    })
    .sort((left, right) => {
      // Servers this run announced come first: they are the ones just started.
      if (left.announced !== right.announced) return left.announced ? -1 : 1;
      return left.port - right.port;
    });
};

/** A folder the user works in: a project, or one of its worktrees. */
export type WorkFolder = {
  readonly path: string;
  /** The project the folder belongs to; a project's own folder names itself. */
  readonly projectPath: string;
};

type PlacedDevServer = DevServerCandidate & {
  /** Name of the project or worktree folder the server runs from. */
  readonly folderName: string | null;
  /** Started outside every project and worktree: an OS service, an app's helper. */
  readonly outsideWork: boolean;
};

const contains = (folder: string, path: string): boolean => (
  path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`)
);

const innermostFolder = (folders: ReadonlyArray<WorkFolder>, path: string | null): WorkFolder | null => {
  if (!path) return null;
  let best: WorkFolder | null = null;
  for (const folder of folders) {
    if (contains(folder.path, path) && (!best || folder.path.length > best.path.length)) best = folder;
  }
  return best;
};

const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1) || path;

/**
 * Says where each server was started from and orders the list around the
 * folder the panel belongs to.
 *
 * Discovery lists everything listening on the machine, and most of it is not
 * the user's: AirPlay, OpenCode, extension helpers. The folder a process runs
 * in separates those from the user's dev servers. A server is marked outside
 * only when its folder is known and lies in no project or worktree; one whose
 * folder is unknown (Windows, a container) stays in, as it always did, and so
 * does one that announced itself.
 *
 * Order: servers that announced themselves, then those from the panel's own
 * folder, then from its project's other worktrees, then the rest by port.
 */
export const placeDevServerCandidates = ({
  candidates,
  folders,
  directory,
}: {
  candidates: ReadonlyArray<DevServerCandidate>;
  folders: ReadonlyArray<WorkFolder>;
  directory: string;
}): PlacedDevServer[] => {
  const knownFolders = folders.flatMap((folder) => {
    const path = normalizePath(folder.path);
    const projectPath = normalizePath(folder.projectPath);
    return path && projectPath ? [{ path, projectPath }] : [];
  });
  // The panel's own folder counts even before the worktree list has it.
  const panelPath = normalizePath(directory);
  const current = panelPath
    ? { path: panelPath, projectPath: innermostFolder(knownFolders, panelPath)?.projectPath ?? panelPath }
    : null;
  const normalizedFolders = current ? [...knownFolders, current] : knownFolders;

  const placed = candidates.map((candidate) => {
    const serverDirectory = normalizePath(candidate.directory);
    const folder = innermostFolder(normalizedFolders, serverDirectory);
    const rank = candidate.announced ? 0
      : folder && current && folder.path === current.path ? 1
        : folder && current && folder.projectPath === current.projectPath ? 2
          : 3;
    return {
      server: {
        ...candidate,
        folderName: folder ? lastSegment(folder.path) : null,
        outsideWork: serverDirectory !== null && folder === null && !candidate.announced,
      },
      rank,
    };
  });

  return placed
    .sort((left, right) => left.rank - right.rank || left.server.port - right.server.port)
    .map((entry) => entry.server);
};
