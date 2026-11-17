import * as nodeModule from 'node:module';

nodeModule.setSourceMapsSupport?.(true, { nodeModules: true });

const runtime = await import('./runtime.js');

export const {
  gracefulShutdown,
  setupProxy,
  restartOpenCode,
  startWebUiServer,
  parseArgs,
} = runtime;
