import { OpenCode } from '@opencode/client';

/**
 * Reads the model catalog a task's `execution.providerID`/`modelID` is
 * resolved against at fire time.
 *
 * The pair is stored, never resolved, until the run starts; a model that is not
 * served in the directory the run happens in therefore fails hours later, in a
 * session nobody is watching. Every writer that stores a pair reads through
 * this so "the model exists" means one thing: it is in the catalog the fire
 * path will dispatch against.
 */
export const createModelCatalogReader = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady = null,
  createClient = OpenCode.make,
}) => async (directory = '') => {
  if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);
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
};
