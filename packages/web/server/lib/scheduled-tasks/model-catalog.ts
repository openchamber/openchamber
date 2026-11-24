import { OpenCode } from '@opencode/client';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { waitForLocationPlugins } from '../opencode/location-plugins.js';

export interface ModelCatalogDependencies {
  buildOpenCodeUrl: (route: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  isOpenCodeDirectoryTrusted?: ((directory: string) => boolean | Promise<boolean>) | null;
  createClient?: typeof OpenCode.make;
}

export const createModelCatalogReader = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  isOpenCodeDirectoryTrusted = null,
  createClient = OpenCode.make,
}: ModelCatalogDependencies) => async (directory = '') => {
  if (directory && isOpenCodeDirectoryTrusted && !(await isOpenCodeDirectoryTrusted(directory))) {
    throw new OpenChamberControlError(
      `OpenCode is paused for ${directory}: its configuration runs plugins or commands the user has not trusted. Ask the user to open the folder in OpenChamber and trust it.`,
      403,
    );
  }
  try {
    const baseUrl = new URL(buildOpenCodeUrl('/api/info', '')).origin;
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    const client = createClient({
      baseUrl,
      headers,
      fetch,
    });
    await waitForLocationPlugins(client);
    const catalog = await client.model.list();
    return Array.isArray(catalog?.data) ? catalog.data : [];
  } catch {
    return [];
  }
};
