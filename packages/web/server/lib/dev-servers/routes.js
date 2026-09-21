/**
 * Dev-server discovery.
 *
 * Answers "what is listening on this machine that I could preview". The old
 * approach guessed from `package.json` scripts, which told us what *could* be
 * started, never what was actually running — so it was wrong exactly when the
 * user needed it. Enumerating listening sockets reports the truth.
 *
 * Discovery is advisory. A failed scan reports failure; it never reports an
 * empty list, because a caller cannot tell "nothing is running" from "the scan
 * broke" and would render the wrong empty state.
 */
import fsPromises from 'node:fs/promises';

import {
  parseLsofListeners,
  parseNetstatListeners,
  parseProcNetTcpListeners,
  selectDevServerCandidates,
} from './parse.js';

const SCAN_TIMEOUT_MS = 2_500;
/** Enumeration is cheap but not free; a short cache absorbs panel re-renders. */
const CACHE_TTL_MS = 3_000;

const runCommand = (spawn, command, args, timeoutMs) => new Promise((resolve) => {
  let child;
  try {
    child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    resolve(null);
    return;
  }

  let stdout = '';
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { child.kill(); } catch { /* already exited */ }
    resolve(value);
  };

  const timer = setTimeout(() => finish(null), timeoutMs);
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.on('error', () => finish(null));
  child.on('close', (code) => finish(code === 0 || stdout ? stdout : null));
});

/**
 * Reads the kernel's socket tables. Containers routinely ship without `lsof`,
 * and a deployed OpenChamber is precisely where discovery has to work, so this
 * is tried whenever the command is unavailable.
 */
const readProcListeners = async (readFile) => {
  const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(
    (path) => readFile(path, 'utf8').catch(() => null),
  ));
  if (tables.every((table) => table === null)) return null;
  const byPort = new Map();
  for (const table of tables) {
    if (table === null) continue;
    for (const entry of parseProcNetTcpListeners(table)) {
      if (!byPort.has(entry.port)) byPort.set(entry.port, entry);
    }
  }
  return [...byPort.values()].sort((left, right) => left.port - right.port);
};

export const createDevServerScanner = ({ spawn, platform, readFile = fsPromises.readFile }) => {
  let cache = null;

  const scan = async () => {
    const isWindows = platform === 'win32';
    if (isWindows) {
      const output = await runCommand(spawn, 'netstat', ['-ano', '-p', 'TCP'], SCAN_TIMEOUT_MS);
      if (output === null) return { ok: false, reason: 'netstat-unavailable' };
      return { ok: true, listeners: parseNetstatListeners(output) };
    }

    const output = await runCommand(spawn, 'lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn'], SCAN_TIMEOUT_MS);
    if (output !== null) return { ok: true, listeners: parseLsofListeners(output) };

    const procListeners = await readProcListeners(readFile);
    if (procListeners !== null) return { ok: true, listeners: procListeners };

    return { ok: false, reason: 'no-listener-source' };
  };

  return {
    /**
     * @param {{ ownPorts?: number[] }} options
     * @returns {Promise<{ ok: true, servers: Array<{ port: number, pid: number|null, command: string, url: string }> } | { ok: false, reason: string }>}
     */
    async discover({ ownPorts = [] } = {}) {
      const now = Date.now();
      if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

      const result = await scan();
      if (!result.ok) {
        // Not cached: a transient failure should not suppress the next attempt.
        return result;
      }

      const servers = selectDevServerCandidates(result.listeners, {
        ownPorts,
        ownPids: [process.pid],
      }).map((entry) => ({
        ...entry,
        url: `http://localhost:${entry.port}/`,
      }));

      const value = { ok: true, servers };
      cache = { at: now, value };
      return value;
    },
  };
};

export function registerDevServerRoutes(app, { scanner, getOwnPorts }) {
  app.get('/api/dev-servers', async (req, res) => {
    try {
      const ownPorts = typeof getOwnPorts === 'function' ? getOwnPorts() : [];
      const result = await scanner.discover({ ownPorts: Array.isArray(ownPorts) ? ownPorts : [] });
      if (!result.ok) {
        res.status(503).json({ error: 'Port discovery is unavailable', reason: result.reason });
        return;
      }
      res.json({ servers: result.servers });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Port discovery failed' });
    }
  });
}
