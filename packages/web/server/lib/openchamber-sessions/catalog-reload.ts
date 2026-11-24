import type { ModelInfo, OpenCodeClient } from '@opencode/client';

const RELOAD_LIMIT_MS = 3_000;
const RELOAD_WAIT_MS = 250;

export const readCatalogListing = async (client: OpenCodeClient, models: readonly ModelInfo[], lists: (models: readonly ModelInfo[]) => boolean): Promise<readonly ModelInfo[]> => {
  let latest = models;
  const signal = AbortSignal.timeout(RELOAD_LIMIT_MS);
  while (latest.length > 0 && !signal.aborted && !lists(latest)) {
    await new Promise((resolve) => setTimeout(resolve, RELOAD_WAIT_MS));
    const reread = await client.model.list(undefined, { signal }).then((response) => response?.data, () => null);
    if (Array.isArray(reread) && reread.length > 0) latest = reread;
  }
  return latest;
};
