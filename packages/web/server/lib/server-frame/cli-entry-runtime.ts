import type { parseServeCliOptions, ServeCliOptions } from './cli-options.js';

interface CliEntryDependencies {
  process: Pick<NodeJS.Process, 'argv' | 'env' | 'exit'>;
  currentFilename: string;
  parseServeCliOptions: typeof parseServeCliOptions;
  defaultPort: number;
  cloudflareProvider: string;
  managedLocalMode: string;
  setExitOnShutdown: (enabled: boolean) => void;
  startServer: (options: ServeCliOptions & { attachSignals: boolean; exitOnShutdown: boolean }) => Promise<object>;
}

export const runCliEntryIfMain = (dependencies: CliEntryDependencies) => {
  const {
    process,
    currentFilename,
    parseServeCliOptions,
    defaultPort,
    cloudflareProvider,
    managedLocalMode,
    setExitOnShutdown,
    startServer,
  } = dependencies;

  const isCliExecution = process.argv[1] === currentFilename;
  if (!isCliExecution) {
    return;
  }

  const cliOptions = parseServeCliOptions({
    argv: process.argv.slice(2),
    env: process.env,
    defaultPort,
    cloudflareProvider,
    managedLocalMode,
  });

  setExitOnShutdown(true);
  startServer({
    port: cliOptions.port,
    host: cliOptions.host,
    tryCfTunnel: cliOptions.tryCfTunnel,
    tunnelProvider: cliOptions.tunnelProvider,
    tunnelMode: cliOptions.tunnelMode,
    tunnelConfigPath: cliOptions.tunnelConfigPath,
    tunnelToken: cliOptions.tunnelToken,
    tunnelHostname: cliOptions.tunnelHostname,
    attachSignals: true,
    exitOnShutdown: true,
    uiPassword: cliOptions.uiPassword,
    apiOnly: cliOptions.apiOnly,
  }).catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
};
