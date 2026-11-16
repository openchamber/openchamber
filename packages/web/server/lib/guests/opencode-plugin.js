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

const ENTRY_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'];
const EXPORT_CONDITIONS = new Set(['bun', 'node', 'import', 'default']);

/** The file an `exports` value leads to: conditions apply in the order they are written and may nest. */
const exportedFile = (value) => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  for (const [condition, target] of Object.entries(value)) {
    const file = EXPORT_CONDITIONS.has(condition) ? exportedFile(target) : null;
    if (file) return file;
  }
  return null;
};

/** What `exports` maps a subpath to: a string, `{ ".": ... }`, or the condition object written without a subpath key. */
const exportTarget = (exported, subpath) => {
  const bare = typeof exported === 'string' || !Object.keys(exported ?? {}).some((key) => key.startsWith('.'));
  return exportedFile(bare ? (subpath === '.' ? exported : undefined) : exported[subpath]);
};

/**
 * The files OpenCode tries in a local plugin folder, in its order (`Host.resolve`
 * in `packages/plugin/src/host.ts`): `exports` when `package.json` also has a
 * `name`, otherwise `server` or `index` at the root. It never reads `main`, and
 * a broken `package.json` counts as none.
 */
const entryCandidates = (manifest) => {
  if (typeof manifest?.name === 'string' && manifest.exports !== undefined) {
    return ['./server', '.'].map((subpath) => exportTarget(manifest.exports, subpath)).filter(Boolean);
  }
  return ['server', 'index'].flatMap((base) => ENTRY_EXTENSIONS.map((extension) => base + extension));
};

const readManifest = async (fsPromises, directory) => {
  try {
    return JSON.parse(await fsPromises.readFile(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
};

const isFileInside = async (fsPromises, directory, target) => {
  try {
    const file = await fsPromises.realpath(path.resolve(directory, target));
    return file.startsWith(directory + path.sep) && (await fsPromises.stat(file)).isFile();
  } catch {
    return false;
  }
};

/**
 * The plugin folder as OpenCode will load it: a directory inside the package
 * holding an entry file OpenCode finds, as a real path. `null` when any of that
 * fails, so the install refuses and the managed config never names a folder
 * OpenCode would skip without a word.
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
    for (const entry of entryCandidates(await readManifest(fsPromises, directory))) {
      if (await isFileInside(fsPromises, directory, entry)) return directory;
    }
    return null;
  } catch {
    return null;
  }
};
