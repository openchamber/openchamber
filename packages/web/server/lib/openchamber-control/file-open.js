/**
 * The agent asking the user to look at a file.
 *
 * The viewer lives in a renderer, so the server cannot open anything itself;
 * it checks that the file is really there and tells every connected client to
 * show it. No answer comes back: opening a tab is not something that fails
 * quietly on the client, and the agent only needs to know whether anyone was
 * there to see it.
 */
import path from 'node:path';
import fsPromises from 'node:fs/promises';

import { OpenChamberControlError } from './error.js';

/**
 * @param {{
 *   emit: (request: { path: string, directory: string | null, sessionId: string | null }) => number,
 *   stat?: (target: string) => Promise<{ isFile(): boolean, size: number }>,
 * }} dependencies
 */
export const createFileOpenRequester = ({ emit, stat = (target) => fsPromises.stat(target) }) => {
  /** `path` arrives already reduced to a trimmed string or null by the service. */
  const request = async ({ path: raw, directory, sessionId }) => {
    if (!raw) throw new OpenChamberControlError('path is required for file.open', 400);

    // A relative path means "in the project I am working in"; without a
    // project there is nothing to resolve it against.
    let absolute;
    if (path.isAbsolute(raw)) {
      absolute = path.normalize(raw);
    } else if (directory) {
      absolute = path.resolve(directory, raw);
    } else {
      throw new OpenChamberControlError('path must be absolute when no session directory is known', 400);
    }

    let stats;
    try {
      stats = await stat(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new OpenChamberControlError(`File not found: ${absolute}`, 404);
      }
      throw new OpenChamberControlError(`Cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
    if (!stats.isFile()) {
      throw new OpenChamberControlError(`Not a file: ${absolute}`, 400);
    }

    const delivered = emit({ path: absolute, directory: directory ?? null, sessionId: sessionId ?? null });
    if (delivered === 0) {
      throw new OpenChamberControlError('No OpenChamber window is connected to show the file', 503);
    }

    return { path: absolute, size: stats.size, opened: true };
  };

  return { request };
};
