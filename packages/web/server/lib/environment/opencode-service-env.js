import path from 'node:path';
import { z } from 'zod';

import { readBoundedFileSync } from '../shared/bounded-file-read.js';
import { isVariableName } from './variables.js';

// Service environment maps are normally small; 1 MiB leaves generous headroom.
const MAX_SERVICE_FILE_BYTES = 1024 * 1024;
/**
 * Variables stored with `opencode service set env NAME VALUE`. OpenCode keeps
 * them in `service.json` in its global config directory and gives them to the
 * service it starts itself; a managed OpenCode started by OpenChamber would
 * not see them otherwise. The file belongs to the OpenCode CLI and is not a
 * published contract, so anything unexpected reads as no variables. Other
 * release channels name the file differently (`service-<channel>.json`);
 * only the stable channel's file is read.
 */
const serviceFileSchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
});

export const readOpenCodeServiceEnv = (configDir) => {
  let raw;
  try {
    const result = readBoundedFileSync(path.join(configDir, 'service.json'), MAX_SERVICE_FILE_BYTES);
    if (!result.ok) return {};
    raw = result.buffer.toString('utf8');
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = serviceFileSchema.safeParse(JSON.parse(raw));
  } catch {
    return {};
  }
  if (!parsed.success) return {};
  return Object.fromEntries(Object.entries(parsed.data.env ?? {}).filter(([name]) => isVariableName(name)));
};
