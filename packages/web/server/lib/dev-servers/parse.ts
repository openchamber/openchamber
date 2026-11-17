export interface DevServerListener {
  port: number;
  pid: number | null;
  command: string;
  directory?: string;
}

export interface DevServerExclusions {
  ownPorts?: number[];
  ownPids?: number[];
}

const LOOPBACK_TOKENS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const WILDCARD_TOKENS = new Set(['*', '0.0.0.0', '[::]', '::']);

const IGNORED_PORTS = new Set([
  22,
  53,
  445,
  631,
  5432,
  3306,
  6379,
  27017,
  9229,
]);

const splitHostPort = (value: string | undefined) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close === -1) return null;
    const host = raw.slice(0, close + 1);
    const rest = raw.slice(close + 1);
    if (!rest.startsWith(':')) return null;
    return { host, port: rest.slice(1) };
  }

  const separator = raw.lastIndexOf(':');
  if (separator === -1) return null;
  return { host: raw.slice(0, separator), port: raw.slice(separator + 1) };
};

const toPort = (value: string) => {
  const port = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
};

export const isLocallyReachableHost = (host: string) => {
  const value = String(host || '').trim().toLowerCase();
  return LOOPBACK_TOKENS.has(value) || WILDCARD_TOKENS.has(value);
};

const isIgnoredDevPort = (port: number) => IGNORED_PORTS.has(port);

export const parseLsofListeners = (output: string | null) => {
  const byPort = new Map<number, DevServerListener>();
  let pid: number | null = null;
  let command = '';

  for (const line of String(output || '').split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);

    if (tag === 'p') {
      const parsedPid = Number.parseInt(value, 10);
      pid = Number.isInteger(parsedPid) ? parsedPid : null;
      command = '';
      continue;
    }
    if (tag === 'c') {
      command = value.trim();
      continue;
    }
    if (tag !== 'n') continue;

    if (value.includes('->')) continue;

    const parsed = splitHostPort(value);
    if (!parsed) continue;
    const port = toPort(parsed.port);
    if (port === null) continue;
    if (!isLocallyReachableHost(parsed.host)) continue;

    const existing = byPort.get(port);
    if (existing && existing.pid !== null) continue;
    byPort.set(port, { port, pid, command });
  }

  return [...byPort.values()].sort((left, right) => left.port - right.port);
};

export const parseLsofCwds = (output: string | null) => {
  const byPid = new Map<number, string>();
  let pid: number | null = null;

  for (const line of String(output || '').split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);

    if (tag === 'p') {
      const parsedPid = Number.parseInt(value, 10);
      pid = Number.isInteger(parsedPid) ? parsedPid : null;
      continue;
    }
    if (tag !== 'n' || pid === null || !value.startsWith('/')) continue;
    if (!byPid.has(pid)) byPid.set(pid, value);
  }

  return byPid;
};

export const parseNetstatListeners = (output: string | null) => {
  const byPort = new Map<number, DevServerListener>();

  for (const line of String(output || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    if (!/^tcp$/i.test(parts[0] ?? '')) continue;
    if (!/^LISTENING$/i.test(parts[3] ?? '')) continue;

    const parsed = splitHostPort(parts[1]);
    if (!parsed) continue;
    const port = toPort(parsed.port);
    if (port === null) continue;
    if (!isLocallyReachableHost(parsed.host)) continue;

    const pid = Number.parseInt(parts[4] ?? '', 10);
    if (byPort.has(port)) continue;
    byPort.set(port, { port, pid: Number.isInteger(pid) ? pid : null, command: '' });
  }

  return [...byPort.values()].sort((left, right) => left.port - right.port);
};

export const selectDevServerCandidates = (listeners: DevServerListener[], { ownPorts = [], ownPids = [] }: DevServerExclusions = {}) => {
  const excludedPorts = new Set(ownPorts.filter((port) => Number.isInteger(port)));
  const excludedPids = new Set(ownPids.filter((pid) => Number.isInteger(pid)));

  return listeners.filter((entry) => {
    if (excludedPorts.has(entry.port)) return false;
    if (entry.pid !== null && excludedPids.has(entry.pid)) return false;
    if (isIgnoredDevPort(entry.port)) return false;
    return true;
  });
};

const PROC_STATE_LISTEN = '0A';
const PROC_WILDCARD_ADDRESSES = new Set(['00000000', '00000000000000000000000000000000']);
const PROC_LOOPBACK_ADDRESSES = new Set(['0100007F', '00000000000000000000000001000000']);

export const parseProcNetTcpListeners = (output: string | null) => {
  const byPort = new Map<number, DevServerListener>();

  for (const line of String(output || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    if (parts[3] !== PROC_STATE_LISTEN) continue;

    const [address, portHex] = String(parts[1] || '').split(':');
    if (!address || !portHex) continue;

    const normalizedAddress = address.toUpperCase();
    if (!PROC_WILDCARD_ADDRESSES.has(normalizedAddress) && !PROC_LOOPBACK_ADDRESSES.has(normalizedAddress)) {
      continue;
    }

    const port = Number.parseInt(portHex, 16);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    if (byPort.has(port)) continue;
    byPort.set(port, { port, pid: null, command: '' });
  }

  return [...byPort.values()].sort((left, right) => left.port - right.port);
};
