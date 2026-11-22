import os from 'node:os';
import path from 'node:path';
import { assignInjectedEnv } from '@openchamber/web/server/lib/injected-env.js';

export function configureDevDataDir(env, packaged, home = os.homedir()) {
  if (packaged || env.OPENCHAMBER_DATA_DIR?.trim()) return;
  assignInjectedEnv(env, {
    OPENCHAMBER_DATA_DIR: path.join(home, '.config', 'openchamber-dev'),
  });
}
