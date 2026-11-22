// A setting of the user's that the host writes into a space's HOME and the server inside reads,
// see `space-server.js`. The agent owns these files and can make them anything, a FIFO among them,
// which a plain read would wait on forever, with the server's event loop stuck behind it.

import { readBoundedFile } from '../shared/bounded-file-read.js';

// A real setting file is a few dozen bytes.
const MAX_SETTING_BYTES = 1024;

/**
 * The file parsed with `schema`, or null when it is missing, not a plain file of at most 1 KiB,
 * not JSON, or not what the schema takes. The caller decides what null means, and it must be the
 * cautious answer: whatever the agent wrote there gives it nothing the user did not choose.
 *
 * The read goes through the shared bounded reader with noFollow (#1659):
 * regularity and size are judged from the opened handle and the cap is
 * enforced in flight, so a file swapped or grown between a by-path lstat and
 * a by-path read can no longer defeat either half of the gate (the race this
 * replaces), and a symlink is judged at open (ELOOP) rather than followed or
 * pre-screened by path. Every non-ok outcome — missing, non-regular
 * (including a FIFO), over-cap, symlink — and every thrown error answers
 * null, exactly as the lstat gate answered for the file it saw.
 */
export const readSpaceSettingFile = async (filePath, schema) => {
  try {
    const result = await readBoundedFile(filePath, MAX_SETTING_BYTES, { noFollow: true });
    if (!result.ok) return null;
    const parsed = schema.safeParse(JSON.parse(result.buffer.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
