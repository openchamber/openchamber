import type { OpenCodeClient } from '@opencode/client';

// external: https://github.com/anomalyco/opencode/blob/v2.4.1/packages/cli/src/services/plugin-startup.ts Since 2.4.0 catalog reads on a cold location answer before its plugins load; plugin.list stays empty until the first activation ends.
const POLL_MS = 25;
const LIMIT_MS = 5_000;

export const LOCATION_PLUGINS_NOT_READY = 'Location plugins did not finish activating';

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

export const waitForPluginList = async (
  listPlugins: (signal: AbortSignal) => Promise<readonly unknown[]>,
  signal?: AbortSignal,
): Promise<boolean> => {
  const limit = new AbortController();
  const timer = setTimeout(() => limit.abort(), LIMIT_MS);
  const bounded = signal ? AbortSignal.any([signal, limit.signal]) : limit.signal;
  try {
    while (!bounded.aborted) {
      let plugins;
      try {
        plugins = await listPlugins(bounded);
      } catch {
        return false;
      }
      if (plugins.length > 0) return true;
      await sleep(POLL_MS, bounded);
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
};

export const waitForLocationPlugins = (client: Pick<OpenCodeClient, 'plugin'>, signal?: AbortSignal) => (
  waitForPluginList((bounded) => client.plugin.list(undefined, { signal: bounded }).then((response) => response.data), signal)
);

export const readLocationCatalog = async (client: Pick<OpenCodeClient, 'plugin' | 'model' | 'provider'>) => {
  if (!(await waitForLocationPlugins(client))) throw new Error(LOCATION_PLUGINS_NOT_READY);
  return Promise.all([client.model.list(), client.provider.list()]);
};
