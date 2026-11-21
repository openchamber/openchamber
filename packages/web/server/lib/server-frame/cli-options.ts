export const parseServeCliOptions = ({
  argv = [],
  env = {},
  defaultPort,
  cloudflareProvider,
  managedLocalMode,
}: ServeCliInput): ServeCliOptions => {
  const args = Array.isArray(argv) ? [...argv] : [];
  const envPassword =
    env.OPENCHAMBER_UI_PASSWORD ||
    env.OPENCODE_UI_PASSWORD ||
    null;
  const envCfTunnel = env.OPENCHAMBER_TRY_CF_TUNNEL === 'true';
  const envTunnelProvider = env.OPENCHAMBER_TUNNEL_PROVIDER || undefined;
  const envTunnelMode = env.OPENCHAMBER_TUNNEL_MODE || undefined;
  const envTunnelConfigRaw = env.OPENCHAMBER_TUNNEL_CONFIG;
  const envTunnelConfig = isString(envTunnelConfigRaw)
    ? (envTunnelConfigRaw.trim().length > 0 ? envTunnelConfigRaw.trim() : null)
    : undefined;
  const envTunnelToken = env.OPENCHAMBER_TUNNEL_TOKEN || undefined;
  const envTunnelHostname = env.OPENCHAMBER_TUNNEL_HOSTNAME || undefined;
  const envApiOnly = env.OPENCHAMBER_API_ONLY === '1' || env.OPENCHAMBER_API_ONLY === 'true';

  const options: ServeCliOptions = {
    port: defaultPort,
    host: undefined,
    uiPassword: envPassword,
    tryCfTunnel: envCfTunnel,
    tunnelProvider: envTunnelProvider,
    tunnelMode: envTunnelMode,
    tunnelConfigPath: envTunnelConfig,
    tunnelToken: envTunnelToken,
    tunnelHostname: envTunnelHostname,
    apiOnly: envApiOnly,
  };

  const consumeValue = (currentIndex: number, inlineValue: string | undefined) => {
    if (inlineValue !== undefined) {
      return { value: inlineValue, nextIndex: currentIndex };
    }
    const nextArg = args[currentIndex + 1];
    if (isString(nextArg) && !nextArg.startsWith('--')) {
      return { value: nextArg, nextIndex: currentIndex + 1 };
    }
    return { value: undefined, nextIndex: currentIndex };
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      throw new TypeError("Cannot read properties of undefined (reading 'startsWith')");
    }
    if (!arg.startsWith('--')) {
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const optionName = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);
    const inlineValue = eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined;

    if (optionName === 'port' || optionName === 'p') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      const parsedPort = parseInt(value ?? '', 10);
      options.port = Number.isFinite(parsedPort) ? parsedPort : defaultPort;
      continue;
    }

    if (optionName === 'host') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.host = value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
      continue;
    }

    if (optionName === 'ui-password') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.uiPassword = value ?? '';
      continue;
    }

    if (optionName === 'api-only') {
      options.apiOnly = true;
      continue;
    }

    if (optionName === 'try-cf-tunnel') {
      options.tryCfTunnel = true;
      continue;
    }

    if (optionName === 'tunnel-provider') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelProvider = value ?? options.tunnelProvider;
      continue;
    }

    if (optionName === 'tunnel-mode') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelMode = value ?? options.tunnelMode;
      continue;
    }

    if (optionName === 'tunnel-config') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelConfigPath = value ?? null;
      continue;
    }

    if (optionName === 'tunnel-token') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelToken = value ?? options.tunnelToken;
      continue;
    }

    if (optionName === 'tunnel-hostname') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelHostname = value ?? options.tunnelHostname;
      continue;
    }

    if (optionName === 'tunnel') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelProvider = cloudflareProvider;
      options.tunnelMode = managedLocalMode;
      options.tunnelConfigPath = value ?? null;
    }
  }

  return options;
};
import { isString } from '../shared/object-guards.js';

interface ServeCliInput {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  defaultPort: number;
  cloudflareProvider: string;
  managedLocalMode: string;
}

export interface ServeCliOptions {
  port: number;
  host: string | undefined;
  uiPassword: string | null;
  tryCfTunnel: boolean;
  tunnelProvider: string | undefined;
  tunnelMode: string | undefined;
  tunnelConfigPath: string | null | undefined;
  tunnelToken: string | undefined;
  tunnelHostname: string | undefined;
  apiOnly: boolean;
}
