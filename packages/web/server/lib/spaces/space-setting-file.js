// A setting of the user's that the host writes into a space's HOME and the server inside reads,
// see `space-server.js`. The agent owns these files and can make them anything, a FIFO among them,
// which a plain read would wait on forever, with the server's event loop stuck behind it.

import fs from 'node:fs';

// A real setting file is a few dozen bytes.
const MAX_SETTING_BYTES = 1024;

/**
 * The file parsed with `schema`, or null when it is missing, not a plain file of at most 1 KiB,
 * not JSON, or not what the schema takes. The caller decides what null means, and it must be the
 * cautious answer: whatever the agent wrote there gives it nothing the user did not choose.
 */
export const readSpaceSettingFile = async (filePath, schema) => {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_SETTING_BYTES) return null;
    const parsed = schema.safeParse(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
