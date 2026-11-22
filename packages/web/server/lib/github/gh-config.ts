import { homedir } from 'node:os';
import { join } from 'node:path';

export function ghConfigDir() {
  return process.env.GH_CONFIG_DIR
    || (process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, 'gh'))
    || (process.platform === 'win32' && process.env.APPDATA && join(process.env.APPDATA, 'GitHub CLI'))
    || join(homedir(), '.config', 'gh');
}
