import os from 'node:os';
import path from 'node:path';

// Resolve once at extension startup, matching the web backend: OpenCode 2
// takes `OPENCODE_CONFIG_DIR` when set, else `$XDG_CONFIG_HOME/opencode`,
// else `~/.config/opencode`.
export const OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR?.trim()
  ? path.resolve(process.env.OPENCODE_CONFIG_DIR.trim())
  : path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'opencode');

// The data-dir counterpart, resolved the same way: `$XDG_DATA_HOME/opencode`,
// else `~/.local/share/opencode`. Reading the XDG variable at load (instead
// of only os.homedir(), which Bun freezes at process start) is what lets
// tests isolate the data-dir files the providers read.
export const OPENCODE_DATA_DIR = path.join(process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share'), 'opencode');
