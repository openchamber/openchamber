import path from 'node:path';
import fsPromises from 'node:fs/promises';

import { OpenChamberControlError, controlErrorFields } from './error.js';

export interface FileOpenRequest {
  path: string | null;
  directory?: string | null;
  sessionId?: string | null;
}

export interface FileOpenDependencies {
  emit: (request: { path: string; directory: string | null; sessionId: string | null }) => number;
  stat?: (target: string) => Promise<{ isFile(): boolean; size: number }>;
}

export const createFileOpenRequester = ({ emit, stat = (target) => fsPromises.stat(target) }: FileOpenDependencies) => {
  const request = async ({ path: raw, directory, sessionId }: FileOpenRequest) => {
    if (!raw) throw new OpenChamberControlError('path is required for file.open', 400);

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
      if (controlErrorFields(error)?.code === 'ENOENT') {
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
