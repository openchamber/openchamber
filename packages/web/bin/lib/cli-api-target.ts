import { DEFAULT_PORT } from './cli-args.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { discoverDesktopInstance, discoverLifecycleInstances } from './cli-lifecycle.js';
import { isServerHealthReady } from './cli-http.js';
import type { CliOptions } from './cli-args.js';

type TargetOptions = Pick<Partial<CliOptions>, 'explicitPort' | 'port' | 'host'>;
type TargetEntry = { port?: number; runtime?: string };
export interface TargetDependencies {
  discoverDesktopInstance?: () => Promise<{ port?: number } | null>;
  discoverLifecycleInstances?: (options: TargetOptions) => Promise<(TargetEntry | null)[]>;
  isServerHealthReady?: typeof isServerHealthReady;
}

function isTargetPort(value: unknown): value is number {
  return Number.isFinite(value);
}

function isNumericEntry(value: unknown): value is number {
  return typeof value === 'number';
}

function isTargetCallback<Callback>(value: Callback | undefined): value is Callback {
  return typeof value === 'function';
}

const uniquePorts = (entries: (number | TargetEntry | null)[]) => {
  const seen = new Set<number>();
  const ports: number[] = [];
  for (const entry of entries) {
    const port = isNumericEntry(entry) ? entry : entry?.port;
    if (!isTargetPort(port) || port <= 0 || seen.has(port)) continue;
    seen.add(port);
    ports.push(port);
  }
  return ports;
};

async function resolveTargetPort(options: TargetOptions = {}, deps: TargetDependencies = {}): Promise<number> {
  if (options.explicitPort && isTargetPort(options.port) && options.port > 0) {
    return options.port;
  }

  const discoverDesktop = isTargetCallback(deps.discoverDesktopInstance)
    ? deps.discoverDesktopInstance
    : discoverDesktopInstance;
  const discoverLifecycle = isTargetCallback(deps.discoverLifecycleInstances)
    ? deps.discoverLifecycleInstances
    : discoverLifecycleInstances;
  const isHealthy = isTargetCallback(deps.isServerHealthReady)
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
    ? lifecycleInstances.find((entry) => entry?.runtime === 'desktop' && isTargetPort(entry.port) && entry.port > 0)
    : null;
  if (lifecycleDesktop?.port) {
    return lifecycleDesktop.port;
  }

  const ports = uniquePorts(Array.isArray(lifecycleInstances) ? lifecycleInstances : []);
  if (ports.length === 1) {
    const [port] = ports;
    if (port !== undefined) return port;
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
