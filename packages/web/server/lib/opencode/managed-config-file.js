import { appendManagedPlugin } from './managed-plugin-config.js';

export const MANAGED_CONFIG_FILE_NAME = 'opencode.managed.json';

/**
 * Built-in OpenCode plugins OpenChamber switches off for its managed child.
 *
 * `opencode.browser` only works when OpenCode's own desktop app attaches a
 * browser to the session; OpenChamber does not implement that protocol, so its
 * tools always fail with `browser.disconnected` and agents conclude browsing is
 * unavailable instead of using `openchamber_web`. A project config that lists
 * `opencode.browser` still re-enables it, because that layer sits above ours.
 */
const DISABLED_BUILTIN_PLUGINS = ['-opencode.browser'];

/**
 * The managed OpenCode config layer.
 *
 * OpenCode 2 watches every config source it reads, including the file named by
 * the `OPENCODE_CONFIG` environment variable, and reloads its plugin list when
 * that file changes. Writing OpenChamber's own plugin entries into a file we
 * own therefore makes toggling a managed tool take effect in the running
 * process — where `OPENCODE_CONFIG_CONTENT` (an environment variable) could
 * only ever change across a restart.
 *
 * The file is OpenChamber-owned and holds nothing but `plugins`: the built-in
 * plugins OpenChamber disables, then its own plugin directories. It sits above
 * the user's global `opencode.json` and below their project config, so it never
 * shadows a project-level choice.
 *
 * When the user's own environment already sets `OPENCODE_CONFIG`, that file is
 * theirs: OpenChamber does not hijack it and falls back to merging its plugins
 * into `OPENCODE_CONFIG_CONTENT`, which keeps the old restart requirement for
 * managed-tool toggles.
 *
 * @param {object} dependencies
 * @param {typeof import('node:fs/promises')} dependencies.fsPromises
 * @param {typeof import('node:path')} dependencies.path
 * @param {string} dependencies.dataDir OpenChamber data directory
 * @param {NodeJS.ProcessEnv} [dependencies.env] environment the managed child inherits
 * @param {object|null} [dependencies.agentToolRuntime]
 * @param {() => Promise<object|null>} dependencies.readSettings
 * @param {() => boolean} dependencies.isAgentMemoryAvailable
 */
export const createManagedConfigRuntime = ({
  fsPromises,
  path,
  dataDir,
  env = process.env,
  agentToolRuntime = null,
  readSettings,
  isAgentMemoryAvailable,
}) => {
  const filePath = path.join(dataDir, MANAGED_CONFIG_FILE_NAME);

  /** The user owns `OPENCODE_CONFIG` when their environment already set it. */
  const ownsConfigFile = () => (env.OPENCODE_CONFIG ?? '').trim().length === 0;

  const writeConfigFile = async (pluginDirectories) => {
    await fsPromises.mkdir(dataDir, { recursive: true });
    const text = `${JSON.stringify({ plugins: [...DISABLED_BUILTIN_PLUGINS, ...pluginDirectories] }, null, 2)}\n`;
    // Temp + rename: OpenCode reacts to the write immediately, and a partial
    // read would make it drop every managed plugin until the next change.
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fsPromises.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };

  /**
   * Materialize the plugins the current settings ask for and return their
   * directories in load order. Directories exist on disk before the config
   * file names them.
   */
  const materializeEnabledPlugins = async () => {
    const settings = await Promise.resolve(readSettings()).catch(() => null);
    const includeControl = settings?.agentControlToolEnabled !== false;
    const includeWeb = settings?.agentWebToolEnabled !== false;
    const includeMemory = isAgentMemoryAvailable() && settings?.agentMemoryToolEnabled === true;
    const includeNotify = settings?.agentNotifyToolEnabled === true;

    const directories = [];
    if (agentToolRuntime && (includeControl || includeWeb || includeMemory || includeNotify)) {
      directories.push(await agentToolRuntime.materializePlugin({ includeControl, includeWeb, includeMemory, includeNotify }));
    }
    return directories;
  };

  /**
   * Environment for a managed OpenCode child: the callback URL and per-child
   * token are always present, so a tool enabled later in the session can still
   * call back without a restart.
   */
  const buildManagedChildEnv = async () => {
    const directories = await materializeEnabledPlugins();
    const childEnv = agentToolRuntime ? agentToolRuntime.createChildEnv() : {};
    if (ownsConfigFile()) {
      await writeConfigFile(directories);
      return { ...childEnv, OPENCODE_CONFIG: filePath };
    }
    let content = env.OPENCODE_CONFIG_CONTENT;
    for (const directory of [...DISABLED_BUILTIN_PLUGINS, ...directories]) {
      content = appendManagedPlugin(content, directory, 'managed plugin');
    }
    return { ...childEnv, OPENCODE_CONFIG_CONTENT: content };
  };

  /**
   * Rewrite the managed config file after a managed-plugin setting changed, so
   * the running OpenCode picks the new plugin list up. A no-op when the user
   * owns `OPENCODE_CONFIG`; those installs still need a restart.
   *
   * @returns {Promise<{updated: boolean, reason?: string}>}
   */
  const refreshManagedConfigFile = async () => {
    if (!ownsConfigFile()) return { updated: false, reason: 'external-config' };
    await writeConfigFile(await materializeEnabledPlugins());
    return { updated: true };
  };

  return {
    filePath,
    ownsConfigFile,
    buildManagedChildEnv,
    refreshManagedConfigFile,
  };
};
