import { z } from 'zod';

import { normalizePath } from '@/lib/pathNormalization';
import { runtimeFetch } from '@/lib/runtime-fetch';

const pageSchema = z.object({
  title: z.string().min(1).nullable().catch(null),
  icon: z.string().startsWith('data:image/').nullable().catch(null),
});

const discoveredServerSchema = z.object({
  port: z.number().int().positive(),
  url: z.string().min(1),
  command: z.string(),
  directory: z.string().min(1).optional(),
  page: pageSchema.nullable().optional(),
});

type DevServerPage = z.infer<typeof pageSchema>;

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
  readonly announced: boolean;
  readonly command?: string;
  readonly directory?: string;
  readonly page?: DevServerPage | null;
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
        command: server.command,
        directory: server.directory,
        page: server.page,
      };
    })
    .sort((left, right) => {
      if (left.announced !== right.announced) return left.announced ? -1 : 1;
      return left.port - right.port;
    });
};

export type WorkFolder = {
  readonly path: string;
  readonly projectPath: string;
};

type PlacedDevServer = DevServerCandidate & {
  readonly folderName: string | null;
  readonly outsideWork: boolean;
  readonly notWebPage: boolean;
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
        notWebPage: candidate.page === null && !candidate.announced,
      },
      rank,
    };
  });

  return placed
    .sort((left, right) => left.rank - right.rank || left.server.port - right.server.port)
    .map((entry) => entry.server);
};
