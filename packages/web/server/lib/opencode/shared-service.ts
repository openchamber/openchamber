import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { discover, ensure } from '@opencode/client/service';
import type { Endpoint } from '@opencode/client/service';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { compareVersions } from '../version-order.js';
import { readOpenCodeCliVersion } from './compatibility.js';

export interface SharedOpenCodeServiceEndpoint {
  origin: string;
  port: number;
  password: string | null;
  replaced?: boolean;
}

export interface SharedServiceSettings {
  useGlobalOpenCodeService?: boolean | undefined;
}

export interface ServiceCliLaunch {
  binary: string;
  args: string[];
}

export interface ConnectSharedServiceOptions {
  binary?: string | null | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  enterpriseMode?: boolean;
  discoverService?: typeof discover;
  ensureService?: typeof ensure;
  resolveLaunch?: ((binary: string) => ServiceCliLaunch) | undefined;
  readCliVersion?: ((launch: ServiceCliLaunch, env: NodeJS.ProcessEnv) => Promise<string>) | undefined;
  replaceOutdated?: boolean;
}

export interface SharedOpenCodeServiceConnector {
  isEnabled: () => Promise<boolean>;
  connect: (options?: { replaceOutdated?: boolean }) => Promise<SharedOpenCodeServiceEndpoint>;
}

export interface SharedServiceConnectorDependencies {
  readSettings: () => SharedServiceSettings | null | Promise<SharedServiceSettings | null>;
  resolveBinary: () => string | null | undefined | Promise<string | null | undefined>;
  buildEnv: () => NodeJS.ProcessEnv;
  setAuthPassword: (password: string, source: string) => string | null;
  discoverService?: typeof discover;
  ensureService?: typeof ensure;
  resolveLaunch?: ConnectSharedServiceOptions['resolveLaunch'];
  readCliVersion?: ConnectSharedServiceOptions['readCliVersion'];
}

const PROTECTED_SERVICE_ENV_KEYS = [
  'OPENCODE_PASSWORD',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCHAMBER_AGENT_TOOL_URL',
  'OPENCHAMBER_AGENT_TOOL_TOKEN',
] as const;

const PROTECTED_SERVICE_ENV_SET = new Set<string>(PROTECTED_SERVICE_ENV_KEYS);

const isBundledServerLauncher = (binary: string) => binary.endsWith('.mjs') || binary.endsWith('.cjs') || binary.endsWith('.js');

const findCliOnPath = (env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform): string | null => {
  const pathValue = env?.PATH ?? env?.Path ?? '';
  if (!pathValue) return null;
  const names = platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode.bat'] : ['opencode'];
  const accessMode = platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  for (const dir of pathValue.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = path.join(trimmed, name);
      try {
        accessSync(candidate, accessMode);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
};

export const resolveServiceCliBinary = (
  configuredBinary: string | null | undefined,
  env: NodeJS.ProcessEnv | undefined = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const trimmed = configuredBinary?.trim() ?? '';
  if (trimmed && !isBundledServerLauncher(trimmed)) return trimmed;
  return findCliOnPath(env, platform);
};

const buildServiceLaunchSpec = (launch: ServiceCliLaunch, env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform) => {
  const cli = [launch.binary, ...launch.args];
  const clean: Record<string, string> = {};
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;
      if (PROTECTED_SERVICE_ENV_SET.has(key)) continue;
      clean[key] = value;
    }
  }
  if (platform === 'win32') {
    for (const key of PROTECTED_SERVICE_ENV_KEYS) clean[key] = '';
    return { command: [...cli, 'serve', '--service'], env: clean };
  }
  return {
    command: ['/usr/bin/env', ...PROTECTED_SERVICE_ENV_KEYS.flatMap((key) => ['-u', key]), ...cli, 'serve', '--service'],
    env: clean,
  };
};

export const parseSharedServiceEndpoint = (endpoint: { readonly url: string; readonly auth?: Endpoint['auth'] | undefined }): SharedOpenCodeServiceEndpoint => {
  const parsed = new URL(endpoint.url);
  const explicitPort = parsed.port ? Number.parseInt(parsed.port, 10) : NaN;
  const port = Number.isInteger(explicitPort) && explicitPort > 0
    ? explicitPort
    : (parsed.protocol === 'https:' ? 443 : 80);
  const password = endpoint.auth?.type === 'basic' && endpoint.auth.password.length > 0
    ? endpoint.auth.password
    : null;
  return {
    origin: parsed.origin,
    port,
    password,
  };
};

export const isSharedOpenCodeServiceEnabled = (settings: SharedServiceSettings | null | undefined): boolean => (
  settings?.useGlobalOpenCodeService === true
);

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

const notOlderThan = (installed: string) => (running: string) => !RELEASE_VERSION.test(running)
  || compareVersions(running, installed) >= 0;

export const connectSharedOpenCodeService = async ({
  binary = null,
  env = process.env,
  platform = process.platform,
  enterpriseMode = isEnterpriseMode(),
  discoverService = discover,
  ensureService = ensure,
  resolveLaunch = (cliBinary) => ({ binary: cliBinary, args: [] }),
  readCliVersion = (launch, cliEnv) => readOpenCodeCliVersion(launch, { env: cliEnv }),
  replaceOutdated = true,
}: ConnectSharedServiceOptions = {}): Promise<SharedOpenCodeServiceEndpoint> => {
  const cliBinary = enterpriseMode ? null : resolveServiceCliBinary(binary, env, platform);
  const launch = cliBinary ? resolveLaunch(cliBinary) : null;
  const installedVersion = launch && replaceOutdated ? await readCliVersion(launch, env).catch(() => null) : null;
  if (launch && installedVersion && RELEASE_VERSION.test(installedVersion)) {
    let replaced = false;
    const endpoint = await ensureService({
      ...buildServiceLaunchSpec(launch, env, platform),
      version: notOlderThan(installedVersion),
      onStart: (reason, previousVersion) => {
        if (reason !== 'version-mismatch') return;
        replaced = true;
        console.log(`Restarting shared OpenCode service ${previousVersion ?? 'unknown'} with installed ${installedVersion}`);
      },
    });
    return { ...parseSharedServiceEndpoint(endpoint), replaced };
  }
  const existing = await discoverService().catch(() => undefined);
  if (existing) {
    return parseSharedServiceEndpoint(existing);
  }
  if (enterpriseMode) {
    throw new Error('No running shared OpenCode service was found. Enterprise mode does not start a user-configured OpenCode daemon.');
  }
  if (!launch) {
    throw new Error('No running shared OpenCode service was found, and no OpenCode CLI binary is configured to start one. Install the OpenCode CLI or set the OpenCode binary path.');
  }
  const started = await ensureService(buildServiceLaunchSpec(launch, env, platform));
  return parseSharedServiceEndpoint(started);
};

export const createSharedOpenCodeServiceConnector = ({
  readSettings,
  resolveBinary,
  buildEnv,
  setAuthPassword,
  discoverService = discover,
  ensureService = ensure,
  resolveLaunch,
  readCliVersion,
}: SharedServiceConnectorDependencies): SharedOpenCodeServiceConnector => ({
  isEnabled: async () => isSharedOpenCodeServiceEnabled(await Promise.resolve(readSettings()).catch(() => null)),
  connect: async ({ replaceOutdated = true } = {}) => {
    const endpoint = await connectSharedOpenCodeService({
      replaceOutdated,
      binary: await Promise.resolve(resolveBinary()).catch(() => null),
      env: buildEnv(),
      discoverService,
      ensureService,
      resolveLaunch,
      readCliVersion,
    });
    setAuthPassword(endpoint.password ?? '', 'shared-service');
    return endpoint;
  },
});

export interface SharedServiceLifecycleTarget {
  state: {
    openCodeBaseUrl: string | null;
    openCodePort: number | null;
    isOpenCodeReady: boolean;
    isExternalOpenCode: boolean;
    lastOpenCodeError: unknown;
    openCodeNotReadySince: number;
    openCodeProcess: { close: () => Promise<void> } | null;
    expressApp: unknown;
  };
  setOpenCodePort: (port: number) => void;
  recordDiagnostic: (event: string) => void;
  syncToHmrState: () => void;
  killProcessOnPort: (port: number | null) => Promise<void>;
  waitForPortRelease: (port: number | null, timeoutMs: number) => Promise<boolean>;
  setupProxy: () => void;
  ensureOpenCodeApiPrefix: () => void;
  onOpenCodeRestarted?: (() => void) | null;
}

export const attachSharedService = async (
  connector: SharedOpenCodeServiceConnector,
  target: SharedServiceLifecycleTarget,
  { stopManaged = false }: { stopManaged?: boolean } = {},
) => {
  const endpoint = await connector.connect();
  if (stopManaged && target.state.openCodeProcess) {
    const portToKill = target.state.openCodePort;
    await target.state.openCodeProcess.close().catch(() => {});
    target.state.openCodeProcess = null;
    target.syncToHmrState();
    await target.killProcessOnPort(portToKill);
    await target.waitForPortRelease(portToKill, 5000);
  }
  console.log(`Connected to shared OpenCode service at ${endpoint.origin}`);
  target.state.openCodeBaseUrl = endpoint.origin;
  target.setOpenCodePort(endpoint.port);
  target.state.isOpenCodeReady = true;
  target.state.isExternalOpenCode = true;
  target.recordDiagnostic('external connected');
  target.state.lastOpenCodeError = null;
  target.state.openCodeNotReadySince = 0;
  target.syncToHmrState();
  if (target.state.expressApp) {
    target.setupProxy();
    target.ensureOpenCodeApiPrefix();
  }
  if (stopManaged || endpoint.replaced) {
    target.onOpenCodeRestarted?.();
  }
  return endpoint.replaced === true;
};

export const restoreSharedServiceState = async (
  connector: SharedOpenCodeServiceConnector | null,
  prev: { origin: string | null; port: number | null },
  target: Pick<SharedServiceLifecycleTarget, 'state' | 'setOpenCodePort' | 'syncToHmrState'>,
) => {
  const endpoint = await connector?.connect({ replaceOutdated: false }).catch(() => null);
  const port = endpoint?.port ?? prev.port;
  target.state.isExternalOpenCode = true;
  target.state.openCodeBaseUrl = endpoint?.origin ?? prev.origin;
  if (port) target.setOpenCodePort(port);
  target.state.isOpenCodeReady = true;
  target.syncToHmrState();
};
