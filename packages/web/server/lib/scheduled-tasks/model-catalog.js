import { OpenCode } from '@opencode/client';
import { OpenChamberControlError } from '../openchamber-control/error.js';

export const createModelCatalogReader = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  isOpenCodeDirectoryTrusted = null,
  createClient = OpenCode.make,
}) => async (directory = '') => {
  if (directory && isOpenCodeDirectoryTrusted && !(await isOpenCodeDirectoryTrusted(directory))) {
    throw new OpenChamberControlError(
      `OpenCode is paused for ${directory}: its configuration runs plugins or commands the user has not trusted. Ask the user to open the folder in OpenChamber and trust it.`,
      403,
    );
  }
  try {
    const client = createClient({
      baseUrl: new URL(buildOpenCodeUrl('/api/info', '')).origin,
      headers: {
        ...getOpenCodeAuthHeaders(),
        ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}),
      },
      fetch,
    });
    const catalog = await client.model.list();
    return Array.isArray(catalog?.data) ? catalog.data : [];
  } catch {
    return [];
  }
};
