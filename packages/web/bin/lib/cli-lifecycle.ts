import fs from 'fs';
import path from 'path';
import { DEFAULT_PORT } from './cli-args.js';
import type { CliOptions } from './cli-args.js';
import type { ProcessStateOptions } from './cli-process.js';
import type { JsonValue } from '../../server/lib/shared/json-values.js';
import { isString } from '../../server/lib/shared/object-guards.js';
import { getRunDir, readDesktopLocalPortFromSettings } from './cli-paths.js';
import { resolveApiHost } from './cli-network.js';
import { fetchTunnelProvidersFromPort, fetchSystemInfoFromPort, isServerHealthReady } from './cli-http.js';
import { isPortAvailable } from './cli-ports.js';
import {
  getPidFilePath,
  getInstanceFilePath,
  readPidFile,
  removePidFile,
  readInstanceOptions,
  hasInstanceFields,
  removeInstanceFile,
  getOpenchamberProcessState,
  hasOpenchamberRuntimeInfo,
} from './cli-process.js';
import { DEFAULT_TUNNEL_PROVIDER_CAPABILITIES } from './cli-tunnel-capabilities.js';

type SystemInfo = NonNullable<Awaited<ReturnType<typeof fetchSystemInfoFromPort>>>;
type LifecycleOptions = Pick<Partial<CliOptions>, 'port' | 'explicitPort'> & { host?: JsonValue | undefined };
type DiscoveryOptions = ProcessStateOptions & Pick<LifecycleOptions, 'host'> & {
  fetchImpl?: typeof fetch;
  getOpenchamberProcessState?: (pid: number) => ReturnType<typeof getOpenchamberProcessState>;
};
type PortDiscoveryOptions = DiscoveryOptions & { runningInstances?: LifecycleInstance[] };
type ProbeHost = { host: string | undefined; requiresPidMatch: boolean };
type InstanceSource = 'probe' | 'registry+probe' | 'registry-unconfirmed';
export type LifecycleInstance = {
  port: number;
  pid: number | null;
  pidFilePath: string;
  instanceFilePath: string;
  mtime: number;
  startedAt: number;
  launchMode: 'foreground' | 'daemon';
  runtime: string;
  source: InstanceSource;
  host: string | undefined;
};

function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

function createLivePortInstance(port: number, info: SystemInfo | null, host: JsonValue | undefined): LifecycleInstance | null {
  if (!hasOpenchamberRuntimeInfo(info)) return null;
  return {
    port,
    pid: isFiniteNumber(info.pid) ? info.pid : null,
    pidFilePath: path.join(getRunDir(), `openchamber-${port}.pid`),
    instanceFilePath: path.join(getRunDir(), `openchamber-${port}.json`),
    mtime: 0,
    startedAt: 0,
    launchMode: 'daemon',
    runtime: info.runtime,
    source: 'probe',
    host: isString(host) && host.length > 0 ? host : undefined,
  };
}

function normalizeProbeHost(host: JsonValue | undefined) {
  return isString(host) && host.trim().length > 0 ? host.trim() : undefined;
}

function isWildcardProbeHost(host: JsonValue | undefined) {
  const normalized = normalizeProbeHost(host);
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]';
}

function isLoopbackProbeHost(host: JsonValue | undefined) {
  const normalized = normalizeProbeHost(host);
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]';
}

function isConcreteProbeHost(host: JsonValue | undefined) {
  const normalized = normalizeProbeHost(host);
  return Boolean(normalized && !isWildcardProbeHost(normalized) && !isLoopbackProbeHost(normalized));
}

function getSystemInfoProbeHosts(...hosts: (JsonValue | undefined)[]) {
  const out: ProbeHost[] = [];
  const hasConcreteAuthoritativeHost = hosts.some(isConcreteProbeHost);
  const pushHost = (host: JsonValue | undefined, requiresPidMatch = false) => {
    const normalized = normalizeProbeHost(host);
    const key = resolveApiHost(normalized);
    if (!out.some((entry) => resolveApiHost(entry.host) === key)) {
      out.push({ host: normalized, requiresPidMatch });
    }
  };

  for (const host of hosts) {
    if (normalizeProbeHost(host)) {
      pushHost(host, false);
    }
  }

  pushHost(undefined, hasConcreteAuthoritativeHost);
  pushHost('127.0.0.1', hasConcreteAuthoritativeHost);
  return out;
}

async function fetchSystemInfoFromPortCandidates(port: number, fetchImpl: typeof fetch, hosts: ProbeHost[], expectedPid: number) {
  for (const { host, requiresPidMatch } of hosts) {
    const info = await fetchSystemInfoFromPort(port, fetchImpl, host);
    if (hasOpenchamberRuntimeInfo(info)) {
      if (requiresPidMatch && info.pid !== expectedPid) {
        continue;
      }
      return { info, host };
    }
  }
  return { info: null, host: null };
}

async function resolveDoctorPortStatuses(options: LifecycleOptions = {}) {
  const runningEntries = await discoverRunningInstances();
  const desktopEntry = await discoverDesktopInstance();
  const statuses = [];

  if (options.explicitPort) {
    const requestedPort = options.port;
    const runningMatch = runningEntries.find((entry) => entry.port === requestedPort);
    if (runningMatch) {
      statuses.push({
        port: requestedPort,
        available: true,
        status: 'success',
        line: `port ${requestedPort} available for tunneling`,
        detail: 'Double-check this same port is configured in your provider dashboard/config.',
      });
      return { statuses, availableEntries: [runningMatch] };
    }

    if (desktopEntry && desktopEntry.port === requestedPort) {
      statuses.push({
        port: requestedPort,
        available: false,
        status: 'warning',
        line: `port ${requestedPort} not available (desktop runtime)`,
        detail: 'Use a CLI instance port from `openchamber serve` for tunneling.',
      });
      return { statuses, availableEntries: [] };
    }

    statuses.push({
      port: requestedPort,
      available: false,
      status: 'error',
      line: `port ${requestedPort} not available (no running instance)`,
      detail: `Start one with \`openchamber serve --port ${requestedPort}\`.`,
    });
    return { statuses, availableEntries: [] };
  }

  for (const entry of runningEntries) {
    statuses.push({
      port: entry.port,
      available: true,
      status: 'success',
      line: `port ${entry.port} available for tunneling`,
      detail: 'Double-check this same port is configured in your provider dashboard/config.',
    });
  }

  if (desktopEntry && !runningEntries.some((entry) => entry.port === desktopEntry.port)) {
    statuses.push({
      port: desktopEntry.port,
      available: false,
      status: 'warning',
      line: `port ${desktopEntry.port} not available (desktop runtime)`,
      detail: 'Use a CLI instance port from `openchamber serve` for tunneling.',
    });
  }

  if (runningEntries.length === 0) {
    statuses.push({
      port: null,
      available: false,
      status: 'warning',
      line: 'no CLI ports available for tunneling',
      detail: 'Start one with `openchamber serve`.',
    });
  }

  return { statuses, availableEntries: runningEntries };
}

async function discoverRunningInstances(options: DiscoveryOptions = {}): Promise<LifecycleInstance[]> {
  const instances: LifecycleInstance[] = [];
  const runDir = getRunDir();
  const fetchImpl = isDiscoveryCallback(options.fetchImpl) ? options.fetchImpl : globalThis.fetch;
  const getProcessState = isDiscoveryCallback(options.getOpenchamberProcessState)
    ? options.getOpenchamberProcessState
    : (pid: number) => getOpenchamberProcessState(pid, options);
  try {
    const files = fs.readdirSync(runDir);
    const pidFiles = files.filter((file) => file.startsWith('openchamber-') && file.endsWith('.pid'));
    for (const file of pidFiles) {
      const port = parseInt(file.replace('openchamber-', '').replace('.pid', ''), 10);
      if (!Number.isFinite(port) || port <= 0) continue;
      const pidFilePath = path.join(runDir, file);
      const pid = readPidFile(pidFilePath);
      if (!pid) {
        removePidFile(pidFilePath);
        removeInstanceFile(path.join(runDir, `openchamber-${port}.json`));
        continue;
      }

      const instanceFilePath = path.join(runDir, `openchamber-${port}.json`);
      const storedInput = readInstanceOptions(instanceFilePath);
      const storedOptions = hasInstanceFields(storedInput) ? storedInput : null;
      const processState = getProcessState(pid);
      if (processState === 'dead') {
        removePidFile(pidFilePath);
        removeInstanceFile(instanceFilePath);
        continue;
      }

      const { info: liveInfo, host: confirmedHost } = await fetchSystemInfoFromPortCandidates(
        port,
        fetchImpl,
        getSystemInfoProbeHosts(storedOptions?.host, options.host),
        pid,
      );
      const reportedPid = liveInfo?.pid;
      const livePid = isFiniteNumber(reportedPid) ? reportedPid : null;
      if (!hasOpenchamberRuntimeInfo(liveInfo)) {
        if (processState === 'mismatched') {
          removePidFile(pidFilePath);
          removeInstanceFile(instanceFilePath);
        }
        continue;
      }

      if (liveInfo.runtime === 'desktop') {
        removePidFile(pidFilePath);
        removeInstanceFile(instanceFilePath);
        continue;
      }

      let startedAt = 0;
      let mtime;
      try {
        mtime = fs.statSync(pidFilePath).mtimeMs;
      } catch {
        mtime = 0;
      }
      const storedStartedAt = storedOptions?.startedAt;
      if (isFiniteNumber(storedStartedAt)) {
        startedAt = storedStartedAt;
      }
      const launchMode = storedOptions?.launchMode === 'foreground' ? 'foreground' : 'daemon';
      instances.push({
        port,
        pid: livePid || (processState === 'matched' ? pid : null),
        pidFilePath,
        instanceFilePath,
        mtime,
        startedAt,
        launchMode,
        runtime: liveInfo.runtime,
        source: 'registry+probe',
        host: isString(confirmedHost) && confirmedHost.length > 0
          ? confirmedHost
          : (isString(storedOptions?.host) && storedOptions.host.length > 0 ? storedOptions.host : undefined),
      });
    }
  } catch {
    return instances.sort((a, b) => a.port - b.port);
  }
  instances.sort((a, b) => a.port - b.port);
  return instances;
}

async function discoverOpenChamberInstanceOnPort(port: number | undefined, options: PortDiscoveryOptions = {}) {
  if (!isFiniteNumber(port) || port <= 0) return null;
  const runningInstances = Array.isArray(options.runningInstances)
    ? options.runningInstances
    : await discoverRunningInstances(options);
  const registryMatch = runningInstances.find((entry) => entry.port === port);
  if (registryMatch) return registryMatch;

  const info = await fetchSystemInfoFromPort(
    port,
    isDiscoveryCallback(options.fetchImpl) ? options.fetchImpl : globalThis.fetch,
    options.host,
  );
  if (info?.runtime === 'desktop' && !isDesktopRuntimeForPort(info, port)) {
    return null;
  }
  return createLivePortInstance(port, info, options.host);
}

async function discoverLifecycleInstances(options: LifecycleOptions = {}, deps: DiscoveryOptions = {}) {
  const runningInstances = await discoverRunningInstances({ ...deps, host: options.host });
  if (!options.explicitPort) {
    return runningInstances;
  }
  const found = runningInstances.find((entry) => entry.port === options.port);
  if (found) return [found];
  const liveInstance = await discoverOpenChamberInstanceOnPort(options.port, {
    ...deps,
    host: options.host,
    runningInstances,
  });
  return liveInstance ? [liveInstance] : [];
}

async function discoverUnconfirmedRegistryInstanceOnPort(port: number | undefined, options: Pick<LifecycleOptions, 'host'> = {}): Promise<LifecycleInstance | null> {
  if (!isFiniteNumber(port) || port <= 0) return null;

  const pidFilePath = await getPidFilePath(port);
  const pid = readPidFile(pidFilePath);
  if (!pid) return null;

  const instanceFilePath = await getInstanceFilePath(port);
  const storedInput = readInstanceOptions(instanceFilePath);
  const storedOptions = hasInstanceFields(storedInput) ? storedInput : null;
  const processState = getOpenchamberProcessState(pid);
  if (processState === 'dead') {
    removePidFile(pidFilePath);
    removeInstanceFile(instanceFilePath);
    return null;
  }

  if (processState !== 'matched') {
    return null;
  }

  const host = storedOptions?.host || options.host;
  if (await isPortAvailable(port, host)) {
    removePidFile(pidFilePath);
    removeInstanceFile(instanceFilePath);
    return null;
  }

  return {
    port,
    pid,
    pidFilePath,
    instanceFilePath,
    mtime: 0,
    startedAt: isFiniteNumber(storedOptions?.startedAt) ? storedOptions.startedAt : 0,
    launchMode: storedOptions?.launchMode === 'foreground' ? 'foreground' : 'daemon',
    runtime: 'cli',
    source: 'registry-unconfirmed',
    host: isString(host) && host.length > 0 ? host : undefined,
  };
}

function getLatestInstance<Instance extends Pick<LifecycleInstance, 'startedAt' | 'mtime' | 'port'>>(instances: Instance[]) {
  if (!instances.length) return null;
  return [...instances].sort((a, b) => {
    const startedDelta = (b.startedAt || 0) - (a.startedAt || 0);
    if (startedDelta !== 0) return startedDelta;
    const mtimeDelta = (b.mtime || 0) - (a.mtime || 0);
    if (mtimeDelta !== 0) return mtimeDelta;
    return b.port - a.port;
  })[0];
}

function isDesktopRuntimeForPort(info: Pick<SystemInfo, 'runtime'> | null, port: number) {
  if (info?.runtime !== 'desktop') {
    return false;
  }
  const desktopPort = readDesktopLocalPortFromSettings();
  return !desktopPort || desktopPort === port;
}

async function inspectTunnelAttachability(port: number, { requireHealthy = true } = {}) {
  const info = await fetchSystemInfoFromPort(port);
  if (!info) {
    return { attachable: false, reason: 'unreachable' };
  }
  if (isDesktopRuntimeForPort(info, port)) {
    return { attachable: false, reason: 'desktop', info };
  }
  if (requireHealthy) {
    const healthy = await isServerHealthReady(port, 1200);
    if (!healthy) {
      return { attachable: false, reason: 'unhealthy', info };
    }
  }
  return { attachable: true, reason: 'ok', info };
}

async function discoverDesktopInstance(fetchImpl = globalThis.fetch) {
  const port = readDesktopLocalPortFromSettings();
  if (!port) {
    return null;
  }

  const info = await fetchSystemInfoFromPort(port, fetchImpl);
  if (!info || info.runtime !== 'desktop') {
    return null;
  }

  return {
    port,
    pid: info.pid,
    runtime: info.runtime,
  };
}

function isDiscoveryCallback<Callback>(value: Callback | undefined): value is Callback {
  return typeof value === 'function';
}

async function resolveTunnelProviders(options: Pick<Partial<CliOptions>, 'port'> = {}, deps: {
  readPorts?: () => number[] | Promise<number[]>;
  fetchImpl?: typeof fetch;
} = {}) {
  const readPorts = isDiscoveryCallback(deps.readPorts)
    ? deps.readPorts
    : async () => (await discoverRunningInstances()).map((entry) => entry.port);
  const fetchImpl = isDiscoveryCallback(deps.fetchImpl) ? deps.fetchImpl : globalThis.fetch;

  const candidatePorts = [];
  if (isFiniteNumber(options.port) && options.port > 0) {
    candidatePorts.push(options.port);
  }

  const discoveredPorts = await Promise.resolve(readPorts());
  if (Array.isArray(discoveredPorts)) {
    candidatePorts.push(...discoveredPorts);
  }

  if (!candidatePorts.includes(DEFAULT_PORT)) {
    candidatePorts.push(DEFAULT_PORT);
  }

  for (const port of candidatePorts) {
    const providers = await fetchTunnelProvidersFromPort(port, fetchImpl);
    if (providers) {
      return { providers, source: `api:${port}` };
    }
  }

  return { providers: DEFAULT_TUNNEL_PROVIDER_CAPABILITIES, source: 'fallback' };
}


export {
  resolveDoctorPortStatuses,
  discoverRunningInstances,
  discoverOpenChamberInstanceOnPort,
  discoverLifecycleInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
  getLatestInstance,
  isDesktopRuntimeForPort,
  inspectTunnelAttachability,
  discoverDesktopInstance,
  resolveTunnelProviders,
};
