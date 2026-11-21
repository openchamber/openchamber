import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { discover, ensure } from '@opencode/client/service';
import type { Endpoint } from '@opencode/client/service';
import { isEnterpriseMode } from '../enterprise-mode.js';

export interface SharedOpenCodeServiceEndpoint {
  origin: string;
  port: number;
  password: string | null;
}

export interface SharedServiceSettings {
  useGlobalOpenCodeService?: boolean | undefined;
}

export interface ConnectSharedServiceOptions {
  binary?: string | null | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  enterpriseMode?: boolean;
  discoverService?: typeof discover;
  ensureService?: typeof ensure;
}

export interface SharedOpenCodeServiceConnector {
  isEnabled: () => Promise<boolean>;
  connect: () => Promise<SharedOpenCodeServiceEndpoint>;
}

export interface SharedServiceConnectorDependencies {
  readSettings: () => SharedServiceSettings | null | Promise<SharedServiceSettings | null>;
  resolveBinary: () => string | null | undefined | Promise<string | null | undefined>;
  buildEnv: () => NodeJS.ProcessEnv;
  setAuthPassword: (password: string, source: string) => string | null;
  discoverService?: typeof discover;
  ensureService?: typeof ensure;
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

const buildServiceLaunchSpec = (cliBinary: string, env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform) => {
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
    return { command: [cliBinary, 'serve', '--service'], env: clean };
  }
  return {
    command: ['/usr/bin/env', ...PROTECTED_SERVICE_ENV_KEYS.flatMap((key) => ['-u', key]), cliBinary, 'serve', '--service'],
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

export const connectSharedOpenCodeService = async ({
  binary = null,
  env = process.env,
  platform = process.platform,
  enterpriseMode = isEnterpriseMode(),
  discoverService = discover,
  ensureService = ensure,
}: ConnectSharedServiceOptions = {}): Promise<SharedOpenCodeServiceEndpoint> => {
  const existing = await discoverService().catch(() => undefined);
  if (existing) {
    return parseSharedServiceEndpoint(existing);
  }
  if (enterpriseMode) {
    throw new Error('No running shared OpenCode service was found. Enterprise mode does not start a user-configured OpenCode daemon.');
  }
  const cliBinary = resolveServiceCliBinary(binary, env, platform);
  if (!cliBinary) {
    throw new Error('No running shared OpenCode service was found, and no OpenCode CLI binary is configured to start one. Install the OpenCode CLI or set the OpenCode binary path.');
  }
  const started = await ensureService(buildServiceLaunchSpec(cliBinary, env, platform));
  return parseSharedServiceEndpoint(started);
};

export const createSharedOpenCodeServiceConnector = ({
  readSettings,
  resolveBinary,
  buildEnv,
  setAuthPassword,
  discoverService = discover,
  ensureService = ensure,
}: SharedServiceConnectorDependencies): SharedOpenCodeServiceConnector => ({
  isEnabled: async () => isSharedOpenCodeServiceEnabled(await Promise.resolve(readSettings()).catch(() => null)),
  connect: async () => {
    const endpoint = await connectSharedOpenCodeService({
      binary: await Promise.resolve(resolveBinary()).catch(() => null),
      env: buildEnv(),
      discoverService,
      ensureService,
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
  killProcessOnPort: (port: number | null) => void;
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
    target.killProcessOnPort(portToKill);
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
  if (stopManaged) {
    target.onOpenCodeRestarted?.();
  }
};

export const restoreSharedServiceState = async (
  connector: SharedOpenCodeServiceConnector | null,
  prev: { origin: string | null; port: number | null },
  target: Pick<SharedServiceLifecycleTarget, 'state' | 'setOpenCodePort' | 'syncToHmrState'>,
) => {
  await connector?.connect().catch(() => {});
  target.state.isExternalOpenCode = true;
  target.state.openCodeBaseUrl = prev.origin;
  if (prev.port) target.setOpenCodePort(prev.port);
  target.state.isOpenCodeReady = true;
  target.syncToHmrState();
};
