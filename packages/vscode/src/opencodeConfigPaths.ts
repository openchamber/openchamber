import os from 'node:os';
import path from 'node:path';

// Resolve once at extension startup, matching the web backend.
export const OPENCODE_CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'),
  'opencode',
);
