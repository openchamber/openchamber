import { OpenCode } from '@opencode/client';
import { OpenChamberControlError } from '../openchamber-control/error.js';

/**
 * Reads the model catalog a task's `execution.providerID`/`modelID` is
 * resolved against at fire time.
 *
 * The pair is stored, never resolved, until the run starts; a model that is not
 * served in the directory the run happens in therefore fails hours later, in a
 * session nobody is watching. Every writer that stores a pair reads through
 * this so "the model exists" means one thing: it is in the catalog the fire
 * path will dispatch against.
 *
 * A read that cannot happen stands down and answers empty: a save is not the
 * place to wait for a runtime that is not up, and the caller treats an empty
 * catalog as "nothing to say about this model" rather than "the model is gone".
 * A folder the user has not trusted is the exception — that is a refusal the
 * user can act on, so it is reported in the words the control layer uses.
 */
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
    // No port yet, or the runtime is down: there is no catalog to judge a
    // model by, which is not the same as the catalog not listing it.
    return [];
  }
};
