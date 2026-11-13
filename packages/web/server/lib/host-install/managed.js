// What the running OpenChamber needs to know about a host install: whether it is
// one, and where it asks the root updater for an update. Read by the server and
// the CLI as the owner account; the root side lives in host.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_INSTALL_DIR = '/usr/lib/openchamber';
export const HOST_CONFIG_FILE = '/etc/openchamber/host.json';
export const HOST_REQUEST_DIR = '/var/lib/openchamber-host/requests';
const HOST_UPDATE_REQUEST = path.join(HOST_REQUEST_DIR, 'update');

const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * True when this copy of OpenChamber is the one the host installer put under
 * /usr/lib/openchamber and the host configuration names it. A user's own npm
 * copy on the same machine is not host-managed, even with host.json present.
 */
export function isHostManagedInstall({ packageRoot = PACKAGE_ROOT, installDir = HOST_INSTALL_DIR, configFile = HOST_CONFIG_FILE } = {}) {
  let resolved;
  try {
    resolved = fs.realpathSync(packageRoot);
  } catch {
    return false;
  }
  return resolved.startsWith(`${installDir}/`) && fs.existsSync(configFile);
}

/**
 * Asks the root updater for an update check. The request carries no content:
 * the updater reads the repository from the host configuration, so the owner
 * account can trigger a check but never choose what is installed.
 */
export function requestHostUpdate({ requestFile = HOST_UPDATE_REQUEST } = {}) {
  fs.writeFileSync(requestFile, '', { mode: 0o600 });
}
