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
  probeStateless?: (signal: AbortSignal) => Promise<boolean>,
): Promise<boolean> => {
  const limit = new AbortController();
  const timer = setTimeout(() => limit.abort(), LIMIT_MS);
  const bounded = signal ? AbortSignal.any([signal, limit.signal]) : limit.signal;
  let probe: Promise<boolean> | undefined;
  let probed = false;
  try {
    while (!bounded.aborted) {
      const read = Promise.resolve().then(() => listPlugins(bounded)).catch(() => null);
      const plugins = probe
        ? await Promise.race([read, probe.then<true | Awaited<typeof read>>((ready) => ready ? true : read)])
        : await read;
      if (bounded.aborted) return false;
      if (plugins === true || (plugins && plugins.length > 0)) return true;
      if (!plugins && !probed) return false;
      if (plugins && probeStateless && !probed) {
        probed = true;
        probe = probeStateless(bounded).catch(() => false).then((ready) => {
          if (!ready) probe = undefined;
          return ready;
        });
      }
      const pause = sleep(POLL_MS, bounded);
      if (probe) {
        if (await Promise.race([probe, pause.then(() => false)])) return !bounded.aborted;
      } else {
        await pause;
      }
    }
    return false;
  } finally {
    clearTimeout(timer);
    limit.abort();
  }
};

export const waitForLocationPlugins = (client: Pick<OpenCodeClient, 'plugin'>, signal?: AbortSignal) => (
  waitForPluginList((bounded) => client.plugin.list(undefined, { signal: bounded }).then((response) => response.data), signal)
);

export const waitForCatalogLocation = (client: Pick<OpenCodeClient, 'plugin' | 'debug'>, signal?: AbortSignal) => (
  waitForPluginList(
    async (bounded) => (await client.plugin.list(undefined, { signal: bounded })).data,
    signal,
    async (bounded) => {
      const locations = await client.debug.location.list({ signal: bounded });
      return Array.isArray(locations) && locations.length === 0;
    },
  )
);

export const readLocationCatalog = async (client: Pick<OpenCodeClient, 'plugin' | 'debug' | 'model' | 'provider'>) => {
  if (!(await waitForCatalogLocation(client))) throw new Error(LOCATION_PLUGINS_NOT_READY);
  return Promise.all([client.model.list(), client.provider.list()]);
};
