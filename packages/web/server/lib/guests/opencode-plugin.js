import path from 'node:path';

/**
 * An extension's OpenCode plugin (`contributes.opencodePlugin`): where its
 * folder is, and how it reaches the OpenCode this server works with.
 *
 * The folder is listed in OpenChamber's managed OpenCode config
 * (`../opencode/managed-config-file.js`) beside the extension's skills while
 * the extension is active and holds the `opencodePlugin` grant. Nothing is
 * written into the user's own `opencode.json` unless they press the card's
 * button: an entry there would outlive disabling the extension and run in
 * every OpenCode on the machine.
 */

/**
 * How the managed config reaches OpenCode, the states the extension card draws:
 * `file` (OpenChamber owns `OPENCODE_CONFIG` of a managed OpenCode: the plugin
 * loads within seconds), `restart` (the user's environment sets
 * `OPENCODE_CONFIG`: merged into `OPENCODE_CONFIG_CONTENT`, applied at the next
 * start), `none` (an external OpenCode on this machine reads neither) and
 * `remote` (an external OpenCode on another machine cannot load a folder from
 * this one).
 * @typedef {'file' | 'restart' | 'none' | 'remote'} OpenCodePluginDelivery
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const isLoopbackOrigin = (origin) => {
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
};

/**
 * @param {{ external: boolean, origin: string | null, ownsConfigFile: boolean }} state
 *   `external`: the server did not spawn OpenCode; `origin`: that server's
 *   address when known; `ownsConfigFile`: the managed config runtime's answer.
 * @returns {OpenCodePluginDelivery}
 */
export const openCodePluginDelivery = ({ external, origin, ownsConfigFile }) => {
  if (external) return isLoopbackOrigin(origin) ? 'none' : 'remote';
  return ownsConfigFile ? 'file' : 'restart';
};

/** The entry file a plugin's `package.json` names, the way OpenCode resolves a directory import. */
const packageEntryOf = (manifest) => {
  const { exports: exported, main } = manifest;
  const target = typeof exported === 'string' ? exported
    : exported && typeof exported === 'object' ? exported['.'] : undefined;
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object') {
    const conditional = target.import ?? target.default ?? target.require;
    if (typeof conditional === 'string') return conditional;
  }
  return typeof main === 'string' ? main : null;
};

/**
 * The plugin folder as OpenCode will load it: a directory inside the package
 * whose `package.json` names an entry file that exists in it, as a real path.
 * `null` when any of that fails, so the install refuses and the managed config
 * never names a folder OpenCode would skip or fail on.
 *
 * @param {Pick<typeof import('node:fs/promises'), 'realpath' | 'stat' | 'readFile'>} fsPromises
 * @param {string} packageRoot
 * @param {string} relativePath already checked by the manifest parse
 * @returns {Promise<string | null>}
 */
export const resolveOpenCodePluginFolder = async (fsPromises, packageRoot, relativePath) => {
  try {
    const rootReal = await fsPromises.realpath(packageRoot);
    const directory = await fsPromises.realpath(path.resolve(rootReal, relativePath));
    if (!directory.startsWith(rootReal + path.sep) || !(await fsPromises.stat(directory)).isDirectory()) return null;
    const manifest = JSON.parse(await fsPromises.readFile(path.join(directory, 'package.json'), 'utf8'));
    const entry = manifest && typeof manifest === 'object' ? packageEntryOf(manifest) : null;
    if (!entry) return null;
    const entryPath = await fsPromises.realpath(path.resolve(directory, entry));
    if (!entryPath.startsWith(directory + path.sep) || !(await fsPromises.stat(entryPath)).isFile()) return null;
    return directory;
  } catch {
    return null;
  }
};
