import * as nodeModule from 'node:module';
import { existsSync } from 'node:fs';

nodeModule.setSourceMapsSupport?.(true, { nodeModules: true });

const sourceLoader = new URL('../scripts/register-server-sources.mjs', import.meta.url);
if (!process.versions.bun && existsSync(sourceLoader)) await import(sourceLoader.href);

const { widenThreadPool } = await import('./lib/directory-reachability/thread-pool.js');
widenThreadPool();

const runtime = await import('./runtime.js');

export const {
  gracefulShutdown,
  setupProxy,
  restartOpenCode,
  startWebUiServer,
  parseArgs,
} = runtime;
