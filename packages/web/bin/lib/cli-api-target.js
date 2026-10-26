import { DEFAULT_PORT } from './cli-args.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { discoverDesktopInstance, discoverLifecycleInstances } from './cli-lifecycle.js';
import { isServerHealthReady } from './cli-http.js';

const uniquePorts = (entries) => {
  const seen = new Set();
  const ports = [];
  for (const entry of entries) {
    const port = typeof entry === 'number' ? entry : entry?.port;
    if (!Number.isFinite(port) || port <= 0 || seen.has(port)) continue;
    seen.add(port);
    ports.push(port);
  }
  return ports;
};

async function resolveTargetPort(options = {}, deps = {}) {
  if (options.explicitPort && Number.isFinite(options.port) && options.port > 0) {
    return options.port;
  }

  const discoverDesktop = typeof deps.discoverDesktopInstance === 'function'
    ? deps.discoverDesktopInstance
    : discoverDesktopInstance;
  const discoverLifecycle = typeof deps.discoverLifecycleInstances === 'function'
    ? deps.discoverLifecycleInstances
    : discoverLifecycleInstances;
  const isHealthy = typeof deps.isServerHealthReady === 'function'
    ? deps.isServerHealthReady
    : isServerHealthReady;

  const [desktopInstance, lifecycleInstances] = await Promise.all([
    discoverDesktop(),
    discoverLifecycle(options),
  ]);

  if (desktopInstance?.port) {
    return desktopInstance.port;
  }

  const lifecycleDesktop = Array.isArray(lifecycleInstances)
    ? lifecycleInstances.find((entry) => entry?.runtime === 'desktop' && Number.isFinite(entry.port) && entry.port > 0)
    : null;
  if (lifecycleDesktop?.port) {
    return lifecycleDesktop.port;
  }

  const ports = uniquePorts(Array.isArray(lifecycleInstances) ? lifecycleInstances : []);
  if (ports.length === 1) {
    return ports[0];
  }

  if (ports.length > 1) {
    if (ports.includes(DEFAULT_PORT) && await isHealthy(DEFAULT_PORT, 1200)) {
      return DEFAULT_PORT;
    }
    throw new TunnelCliError(
      `Multiple OpenChamber instances are running (ports: ${ports.join(', ')}). Choose one with --port <port>.`,
      EXIT_CODE.USAGE_ERROR,
    );
  }

  if (await isHealthy(DEFAULT_PORT, 1200)) {
    return DEFAULT_PORT;
  }

  throw new TunnelCliError(
    'No running OpenChamber server found. Start one with `openchamber serve`, or pass --port <port>.',
    EXIT_CODE.GENERAL_ERROR,
  );
}

export { resolveTargetPort };
