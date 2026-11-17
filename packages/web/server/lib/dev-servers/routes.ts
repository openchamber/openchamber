import fsPromises from 'node:fs/promises';
import type { spawn as nodeSpawn, ChildProcess } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import type { DevServerExclusions, DevServerListener } from './parse.js';

import {
  parseLsofCwds,
  parseLsofListeners,
  parseNetstatListeners,
  parseProcNetTcpListeners,
  selectDevServerCandidates,
} from './parse.js';

const SCAN_TIMEOUT_MS = 2_500;
const CACHE_TTL_MS = 3_000;

export interface DevServer extends DevServerListener {
  url: string;
}

type ScanFailure = { ok: false; reason: 'netstat-unavailable' | 'no-listener-source' };
type ScanResult = { ok: true; listeners: DevServerListener[] } | ScanFailure;
export type DevServerDiscoveryResult = { ok: true; servers: DevServer[] } | ScanFailure;

type DiscoverOptions = Pick<DevServerExclusions, 'ownPorts'>;

export interface DevServerScannerOptions {
  spawn: typeof nodeSpawn;
  platform: NodeJS.Platform;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
}

export interface DevServerScanner {
  discover: (options?: DiscoverOptions) => Promise<DevServerDiscoveryResult>;
}

export interface DevServerRouteOptions {
  scanner: DevServerScanner;
  getOwnPorts: () => number[];
}

interface DevServerResponse {
  status: (code: number) => DevServerResponse;
  json: (body: { servers: DevServer[] } | { error: unknown; reason?: ScanFailure['reason'] }) => void;
}

export interface DevServerRouteApp {
  get: (path: string, handler: (req: IncomingMessage, res: DevServerResponse) => Promise<void>) => void;
}

const runCommand = (spawn: typeof nodeSpawn, command: string, args: string[], timeoutMs: number) => new Promise<string | null>((resolve) => {
  let child: ChildProcess;
  try {
    child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    resolve(null);
    return;
  }

  let stdout = '';
  let settled = false;
  const finish = (value: string | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { child.kill(); } catch { resolve(value); return; }
    resolve(value);
  };

  const timer = setTimeout(() => finish(null), timeoutMs);
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.on('error', () => finish(null));
  child.on('close', (code) => finish(code === 0 || stdout ? stdout : null));
});

const readProcListeners = async (readFile: NonNullable<DevServerScannerOptions['readFile']>) => {
  const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(
    (path) => readFile(path, 'utf8').catch(() => null),
  ));
  if (tables.every((table) => table === null)) return null;
  return tables.flatMap((table) => (table === null ? [] : parseProcNetTcpListeners(table)));
};

const mergeListenersByPort = (listeners: DevServerListener[]) => {
  const byPort = new Map<number, DevServerListener>();
  for (const entry of listeners) {
    if (!byPort.has(entry.port)) byPort.set(entry.port, entry);
  }
  return [...byPort.values()].sort((left, right) => left.port - right.port);
};

const withProcessDirectories = async (spawn: typeof nodeSpawn, listeners: DevServerListener[]) => {
  const pids = [...new Set(listeners.map((entry) => entry.pid).filter((pid) => Number.isInteger(pid)))];
  if (pids.length === 0) return listeners;
  const output = await runCommand(spawn, 'lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-F', 'pn'], SCAN_TIMEOUT_MS);
  if (output === null) return listeners;
  const cwdByPid = parseLsofCwds(output);
  return listeners.map((entry) => {
    const directory = entry.pid === null ? undefined : cwdByPid.get(entry.pid);
    return directory ? { ...entry, directory } : entry;
  });
};

export const createDevServerScanner = ({ spawn, platform, readFile = fsPromises.readFile }: DevServerScannerOptions): DevServerScanner => {
  let cache: { at: number; value: DevServerDiscoveryResult } | null = null;

  const scan = async (): Promise<ScanResult> => {
    const isWindows = platform === 'win32';
    if (isWindows) {
      const output = await runCommand(spawn, 'netstat', ['-ano', '-p', 'TCP'], SCAN_TIMEOUT_MS);
      if (output === null) return { ok: false, reason: 'netstat-unavailable' };
      return { ok: true, listeners: parseNetstatListeners(output) };
    }

    const [lsofOutput, procListeners] = await Promise.all([
      runCommand(spawn, 'lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn'], SCAN_TIMEOUT_MS),
      readProcListeners(readFile),
    ]);
    if (lsofOutput === null && procListeners === null) return { ok: false, reason: 'no-listener-source' };

    const lsofListeners = lsofOutput === null ? [] : parseLsofListeners(lsofOutput);
    const listeners = mergeListenersByPort([...lsofListeners, ...(procListeners ?? [])]);
    return { ok: true, listeners: await withProcessDirectories(spawn, listeners) };
  };

  return {
    async discover({ ownPorts = [] }: DiscoverOptions = {}): Promise<DevServerDiscoveryResult> {
      const now = Date.now();
      if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

      const result = await scan();
      if (!result.ok) {
        return result;
      }

      const servers = selectDevServerCandidates(result.listeners, {
        ownPorts,
        ownPids: [process.pid],
      }).map((entry) => ({
        ...entry,
        url: `http://localhost:${entry.port}/`,
      }));

      const value: DevServerDiscoveryResult = { ok: true, servers };
      cache = { at: now, value };
      return value;
    },
  };
};

const canReadErrorMessage = (value: unknown): value is { message?: unknown } =>
  value !== null && value !== undefined;

export function registerDevServerRoutes(app: DevServerRouteApp, { scanner, getOwnPorts }: DevServerRouteOptions) {
  app.get('/api/dev-servers', async (req, res) => {
    try {
      const ownPorts = getOwnPorts();
      const result = await scanner.discover({ ownPorts });
      if (!result.ok) {
        res.status(503).json({ error: 'Port discovery is unavailable', reason: result.reason });
        return;
      }
      res.json({ servers: result.servers });
    } catch (error) {
      const message = canReadErrorMessage(error) ? error.message : undefined;
      res.status(500).json({ error: message || 'Port discovery failed' });
    }
  });
}
