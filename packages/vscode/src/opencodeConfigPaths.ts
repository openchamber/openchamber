import os from 'node:os';
import path from 'node:path';

// Resolve once at extension startup, matching the web backend: OpenCode 2
// takes `OPENCODE_CONFIG_DIR` when set, else `$XDG_CONFIG_HOME/opencode`,
// else `~/.config/opencode`.
export const OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR?.trim()
  ? path.resolve(process.env.OPENCODE_CONFIG_DIR.trim())
  : path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'opencode');
