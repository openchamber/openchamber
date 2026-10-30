import { appendManagedPermissions, appendManagedPlugin } from './managed-plugin-config.js';
import { managedPermissionRules } from '../agent-tool/runtime.js';
import { isLimitFailoverConfigured } from '../limit-failover/policy.js';
import { materializeSessionTitlePlugin } from './session-title-plugin.js';

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
 * OpenCode's own `image_generate` tool (2.2.1+, opt-in through
 * `experimental.image_generate`), switched off while `openchamber_image` is
 * on, so the agent sees one image tool, the one using the model the user chose.
 */
const BUILTIN_IMAGE_PLUGIN = '-opencode.tool.image-generate';

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
 * The file is OpenChamber-owned and holds `plugins`: the built-in plugins
 * OpenChamber disables, then its own plugin directories; and `permissions`
 * its tools need, such as the workflow answer tool denied everywhere but in
 * the sessions that allow it. OpenCode appends every layer's permissions to
 * each agent, so ours add to the user's rules and replace none. It sits above
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
 * @param {string} dependencies.instanceDir this server's own directory (`instance-dir.js`)
 * @param {NodeJS.ProcessEnv} [dependencies.env] environment the managed child inherits
 * @param {object|null} [dependencies.agentToolRuntime]
 * @param {object|null} [dependencies.limitFailoverRuntime] `../limit-failover/runtime.js`; its plugin calls back through the agent tool's address
 * @param {() => Promise<object|null>} dependencies.readSettings
 * @param {() => boolean} dependencies.isAgentMemoryAvailable
 * @param {() => boolean} [dependencies.isWorkflowAvailable] whether workflows ship in this build (`../workflows/feature-flag.js`)
 */
export const createManagedConfigRuntime = ({
  fsPromises,
  path,
  instanceDir,
  env = process.env,
  agentToolRuntime = null,
  limitFailoverRuntime = null,
  readSettings,
  isAgentMemoryAvailable,
  isWorkflowAvailable = () => false,
}) => {
  const filePath = path.join(instanceDir, MANAGED_CONFIG_FILE_NAME);

  /** The user owns `OPENCODE_CONFIG` when their environment already set it. */
  const ownsConfigFile = () => (env.OPENCODE_CONFIG ?? '').trim().length === 0;

  const writeConfigFile = async ({ disabled, directories, permissions }) => {
    await fsPromises.mkdir(instanceDir, { recursive: true });
    const config = { plugins: [...disabled, ...directories] };
    if (permissions.length > 0) config.permissions = permissions;
    const text = `${JSON.stringify(config, null, 2)}\n`;
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
   * directories in load order, with the permission rules their tools need.
   * Directories exist on disk before the config file names them.
   */
  const materializeEnabledPlugins = async () => {
    const settings = await Promise.resolve(readSettings()).catch(() => null);
    const includeControl = settings?.agentControlToolEnabled !== false;
    const includeSchedule = settings?.agentScheduleToolEnabled !== false;
    const includeWeb = settings?.agentWebToolEnabled !== false;
    const includeMemory = isAgentMemoryAvailable() && settings?.agentMemoryToolEnabled === true;
    const includeKnowledge = settings?.agentKnowledgeToolEnabled !== false;
    const includeNotify = settings?.agentNotifyToolEnabled === true;
    const includeRender = settings?.agentRenderToolEnabled !== false;
    const includeImage = settings?.agentImageToolEnabled === true;
    const includeSecret = settings?.agentSecretToolEnabled !== false;
    // On by default wherever the build has workflows: the build flag is the opt-in.
    const includeWorkflow = isWorkflowAvailable() && settings?.agentWorkflowToolEnabled !== false;
    const codeMode = settings?.agentToolsCodeMode === true;

    const directories = [];
    let permissions = [];
    if (agentToolRuntime && (includeControl || includeSchedule || includeWeb || includeMemory || includeKnowledge || includeNotify || includeRender || includeImage || includeSecret || includeWorkflow)) {
      directories.push(await agentToolRuntime.materializePlugin({ includeControl, includeSchedule, includeWeb, includeMemory, includeKnowledge, includeNotify, includeRender, includeImage, includeSecret, includeWorkflow, codeMode }));
      permissions = managedPermissionRules({ includeWorkflow });
    }
    // Only while an option is on: otherwise every limit error would cost the
    // plugin a round trip to hear "do nothing".
    if (agentToolRuntime && limitFailoverRuntime && isLimitFailoverConfigured(settings)) {
      directories.push(await limitFailoverRuntime.materializePlugin());
    }
    directories.push(await materializeSessionTitlePlugin({ fsPromises, path, instanceDir }));
    const disabled = includeImage ? [...DISABLED_BUILTIN_PLUGINS, BUILTIN_IMAGE_PLUGIN] : DISABLED_BUILTIN_PLUGINS;
    return { disabled, directories, permissions };
  };

  /**
   * Environment for a managed OpenCode child: the callback URL and per-child
   * token are always present, so a tool enabled later in the session can still
   * call back without a restart.
   */
  const buildManagedChildEnv = async () => {
    const enabled = await materializeEnabledPlugins();
    const childEnv = agentToolRuntime ? agentToolRuntime.createChildEnv() : {};
    if (ownsConfigFile()) {
      await writeConfigFile(enabled);
      return { ...childEnv, OPENCODE_CONFIG: filePath };
    }
    let content = env.OPENCODE_CONFIG_CONTENT;
    for (const directory of [...enabled.disabled, ...enabled.directories]) {
      content = appendManagedPlugin(content, directory, 'managed plugin');
    }
    if (enabled.permissions.length > 0) content = appendManagedPermissions(content, enabled.permissions);
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
