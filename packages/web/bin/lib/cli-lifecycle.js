import fs from 'fs';
import path from 'path';
import { DEFAULT_PORT } from './cli-args.js';
import { getRunDir, readDesktopLocalPortFromSettings } from './cli-paths.js';
import { resolveApiHost, buildLocalUrl } from './cli-network.js';
import { fetchTunnelProvidersFromPort, fetchSystemInfoFromPort, isServerHealthReady } from './cli-http.js';
import { isPortAvailable } from './cli-ports.js';
import {
  getPidFilePath,
  getInstanceFilePath,
  readPidFile,
  removePidFile,
  readInstanceOptions,
  removeInstanceFile,
  getOpenchamberProcessState,
  hasOpenchamberRuntimeInfo,
} from './cli-process.js';
import { DEFAULT_TUNNEL_PROVIDER_CAPABILITIES } from './cli-tunnel-capabilities.js';

function createLivePortInstance(port, info, host) {
  if (!hasOpenchamberRuntimeInfo(info)) return null;
  return {
    port,
    pid: Number.isFinite(info.pid) ? info.pid : null,
    pidFilePath: path.join(getRunDir(), `openchamber-${port}.pid`),
    instanceFilePath: path.join(getRunDir(), `openchamber-${port}.json`),
    mtime: 0,
    startedAt: 0,
    launchMode: 'daemon',
    runtime: info.runtime,
    source: 'probe',
    host: typeof host === 'string' && host.length > 0 ? host : undefined,
  };
}

function normalizeProbeHost(host) {
  return typeof host === 'string' && host.trim().length > 0 ? host.trim() : undefined;
}

function isWildcardProbeHost(host) {
  const normalized = normalizeProbeHost(host);
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]';
}

function isLoopbackProbeHost(host) {
  const normalized = normalizeProbeHost(host);
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]';
}

function isConcreteProbeHost(host) {
  const normalized = normalizeProbeHost(host);
  return Boolean(normalized && !isWildcardProbeHost(normalized) && !isLoopbackProbeHost(normalized));
}

function getSystemInfoProbeHosts(...hosts) {
  const out = [];
  const hasConcreteAuthoritativeHost = hosts.some(isConcreteProbeHost);
  const pushHost = (host, requiresPidMatch = false) => {
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

async function fetchSystemInfoFromPortCandidates(port, fetchImpl, hosts, expectedPid) {
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

async function resolveDoctorPortStatuses(options = {}) {
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

async function discoverRunningInstances(options = {}) {
  const instances = [];
  const runDir = getRunDir();
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const getProcessState = typeof options.getOpenchamberProcessState === 'function'
    ? options.getOpenchamberProcessState
    : (pid) => getOpenchamberProcessState(pid, options);
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
      const storedOptions = readInstanceOptions(instanceFilePath);
      const processState = getProcessState(pid);
      if (processState === 'dead') {
        removePidFile(pidFilePath);
        removeInstanceFile(instanceFilePath);
        continue;
      }

      // A live PID-file is only the right instance if the recorded port also
      // confirms OpenChamber. Cmdline identity alone can match a recycled PID
      // from another OpenChamber process on a different port. Try all plausible
      // hosts first; if matched/unknown identity still can't be confirmed, keep
      // the registry files but don't claim the instance is running.
      const { info: liveInfo, host: confirmedHost } = await fetchSystemInfoFromPortCandidates(
        port,
        fetchImpl,
        getSystemInfoProbeHosts(storedOptions?.host, options.host),
        pid,
      );
      const livePid = Number.isFinite(liveInfo?.pid) ? liveInfo.pid : null;
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

      let mtime = 0;
      let startedAt = 0;
      try {
        mtime = fs.statSync(pidFilePath).mtimeMs;
      } catch {
      }
      if (Number.isFinite(storedOptions?.startedAt)) {
        startedAt = storedOptions.startedAt;
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
        host: typeof confirmedHost === 'string' && confirmedHost.length > 0
          ? confirmedHost
          : (typeof storedOptions?.host === 'string' && storedOptions.host.length > 0 ? storedOptions.host : undefined),
      });
    }
  } catch {
  }
  instances.sort((a, b) => a.port - b.port);
  return instances;
}

async function discoverOpenChamberInstanceOnPort(port, options = {}) {
  if (!Number.isFinite(port) || port <= 0) return null;
  const runningInstances = Array.isArray(options.runningInstances)
    ? options.runningInstances
    : await discoverRunningInstances(options);
  const registryMatch = runningInstances.find((entry) => entry.port === port);
  if (registryMatch) return registryMatch;

  const info = await fetchSystemInfoFromPort(
    port,
    typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch,
    options.host,
  );
  if (info?.runtime === 'desktop' && !isDesktopRuntimeForPort(info, port)) {
    return null;
  }
  return createLivePortInstance(port, info, options.host);
}

async function discoverLifecycleInstances(options = {}, deps = {}) {
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

async function discoverUnconfirmedRegistryInstanceOnPort(port, options = {}) {
  if (!Number.isFinite(port) || port <= 0) return null;

  const pidFilePath = await getPidFilePath(port);
  const pid = readPidFile(pidFilePath);
  if (!pid) return null;

  const instanceFilePath = await getInstanceFilePath(port);
  const storedOptions = readInstanceOptions(instanceFilePath);
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
    startedAt: Number.isFinite(storedOptions?.startedAt) ? storedOptions.startedAt : 0,
    launchMode: storedOptions?.launchMode === 'foreground' ? 'foreground' : 'daemon',
    runtime: 'cli',
    source: 'registry-unconfirmed',
    host: typeof host === 'string' && host.length > 0 ? host : undefined,
  };
}

function getLatestInstance(instances) {
  if (!instances.length) return null;
  return [...instances].sort((a, b) => {
    const startedDelta = (b.startedAt || 0) - (a.startedAt || 0);
    if (startedDelta !== 0) return startedDelta;
    const mtimeDelta = (b.mtime || 0) - (a.mtime || 0);
    if (mtimeDelta !== 0) return mtimeDelta;
    return b.port - a.port;
  })[0];
}

function isDesktopRuntimeForPort(info, port) {
  if (info?.runtime !== 'desktop') {
    return false;
  }
  const desktopPort = readDesktopLocalPortFromSettings();
  return !desktopPort || desktopPort === port;
}

async function inspectTunnelAttachability(port, { requireHealthy = true } = {}) {
  const info = await fetchSystemInfoFromPort(port);
  if (!info || typeof info.runtime !== 'string') {
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

async function resolveTunnelProviders(options = {}, deps = {}) {
  const readPorts = typeof deps.readPorts === 'function'
    ? deps.readPorts
    : async () => (await discoverRunningInstances()).map((entry) => entry.port);
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;

  const candidatePorts = [];
  if (Number.isFinite(options.port) && options.port > 0) {
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
