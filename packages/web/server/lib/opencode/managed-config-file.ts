import { appendManagedCommand, appendManagedPermissions, appendManagedPolicies, appendManagedPlugin, appendManagedSkills } from './managed-plugin-config.js';
import { managedPermissionRules } from '../agent-tool/runtime.js';
import { isLimitFailoverConfigured } from '../limit-failover/policy.js';
import { isSharingAvailable } from '../share-pages/relay-client.js';
import { materializeSessionTitlePlugin } from './session-title-plugin.js';
export { retireClaudePlugin } from './retired-plugins.js';
import { collectSkillEntriesFromRoots, createExternalPluginBridgeRuntime, registerExternalPluginBridgeRoutes } from './external-plugin-bridge.js';
import { EXTENSION_AUTHORING_COMMAND, materializeAuthoringSkill } from '../guests/agent-context.js';
import type { OpenCodePluginDelivery } from '../guests/opencode-plugin.js';
import type { Application } from '../shared/http-contracts.js';
import type { createAgentToolRuntime } from '../agent-tool/runtime.js';
import type { LimitFailoverConfigurationInput } from '../limit-failover/policy.js';

export interface ManagedConfigSettings extends LimitFailoverConfigurationInput {
  agentControlToolEnabled?: unknown;
  agentScheduleToolEnabled?: unknown;
  agentWebToolEnabled?: unknown;
  agentMemoryToolEnabled?: unknown;
  agentKnowledgeToolEnabled?: unknown;
  agentNotifyToolEnabled?: unknown;
  agentRenderToolEnabled?: unknown;
  agentImageToolEnabled?: unknown;
  agentSecretToolEnabled?: unknown;
  agentUsageToolEnabled?: unknown;
  agentTerminalToolEnabled?: unknown;
  agentActionsToolEnabled?: unknown;
  agentWorkflowToolEnabled?: unknown;
}

export interface ManagedConfigDependencies {
  fsPromises: typeof import('node:fs/promises');
  path: typeof import('node:path');
  instanceDir: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  agentToolRuntime?: Pick<ReturnType<typeof createAgentToolRuntime>, 'materializePlugin' | 'createChildEnv'> & Partial<Pick<ReturnType<typeof createAgentToolRuntime>, 'ensureBridgeCredentials'>> | null;
  limitFailoverRuntime?: { materializePlugin: () => Promise<string> } | null;
  readSettings: () => ManagedConfigSettings | null | Promise<ManagedConfigSettings | null>;
  listExtensionSkillDirectories?: () => Promise<string[]>;
  listExtensionPluginDirectories?: () => Promise<string[]>;
  openchamberVersion?: string;
  readPluginDenials?: () => Array<{ action: string; resource: string; effect: string }>;
  getOpenCodePluginDelivery?: () => OpenCodePluginDelivery;
}

interface ManagedConfigFile {
  plugins: string[];
  skills: string[];
  commands: Record<string, Awaited<ReturnType<typeof materializeAuthoringSkill>>['command']>;
  permissions?: ReturnType<typeof managedPermissionRules>;
  policies?: Parameters<typeof appendManagedPolicies>[1];
}

export const MANAGED_CONFIG_FILE_NAME = 'opencode.managed.json';

const DISABLED_BUILTIN_PLUGINS = ['-opencode.browser'];

const BUILTIN_IMAGE_PLUGIN = '-opencode.tool.image-generate';

const BUILTIN_AUTOMATION_PLUGIN = '-opencode.tool.automation';

export const createManagedConfigRuntime = ({
  fsPromises,
  path,
  instanceDir,
  dataDir,
  env = process.env,
  agentToolRuntime = null,
  limitFailoverRuntime = null,
  readSettings,
  listExtensionSkillDirectories = async () => [],
  listExtensionPluginDirectories = async () => [],
  openchamberVersion,
  readPluginDenials = () => [],
  getOpenCodePluginDelivery,
}: ManagedConfigDependencies) => {
  const filePath = path.join(instanceDir, MANAGED_CONFIG_FILE_NAME);
  const externalBridge = dataDir && getOpenCodePluginDelivery && agentToolRuntime?.ensureBridgeCredentials
    ? createExternalPluginBridgeRuntime({
      fsPromises,
      path,
      dataDir,
      readSettings,
      ensureCredentials: () => agentToolRuntime.ensureBridgeCredentials?.() ?? null,
      isExternalLocal: () => getOpenCodePluginDelivery() === 'none',
      collectSkillsAndCommands: async () => {
        const authoring = await materializeAuthoringSkill({ fsPromises, instanceDir, openchamberVersion });
        const skillRoots = [authoring.skillsRoot, ...await listExtensionSkillDirectories()];
        const skills = await collectSkillEntriesFromRoots(fsPromises, path, skillRoots);
        const commands = [{ name: EXTENSION_AUTHORING_COMMAND, description: authoring.command.description, template: authoring.command.template }];
        return { skills, commands };
      },
    })
    : null;

  const ownsConfigFile = () => (env.OPENCODE_CONFIG ?? '').trim().length === 0;

  const writeConfigFile = async ({ disabled, directories, extensionPlugins, permissions, policies, skills, commands }: Awaited<ReturnType<typeof materializeEnabledPlugins>>) => {
    await fsPromises.mkdir(instanceDir, { recursive: true });
    const config: ManagedConfigFile = { plugins: [...disabled, ...directories, ...extensionPlugins], skills, commands };
    if (policies.length > 0) config.policies = policies;
    if (permissions.length > 0) config.permissions = permissions;
    const text = `${JSON.stringify(config, null, 2)}\n`;
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fsPromises.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };

  const materializeEnabledPlugins = async () => {
    const settings = await Promise.resolve(readSettings()).catch(() => null);
    const includeControl = settings?.agentControlToolEnabled !== false;
    const includeSchedule = settings?.agentScheduleToolEnabled !== false;
    const includeWeb = settings?.agentWebToolEnabled !== false;
    const includeMemory = settings?.agentMemoryToolEnabled === true;
    const includeKnowledge = settings?.agentKnowledgeToolEnabled !== false;
    const includeNotify = settings?.agentNotifyToolEnabled === true;
    const includeRender = settings?.agentRenderToolEnabled !== false;
    const includeShare = includeRender && isSharingAvailable();
    const includeImage = settings?.agentImageToolEnabled === true;
    const includeSecret = settings?.agentSecretToolEnabled !== false;
    const includeUsage = settings?.agentUsageToolEnabled === true;
    const includeTerminal = settings?.agentTerminalToolEnabled === true;
    const includeActions = settings?.agentActionsToolEnabled === true;
    const includeWorkflow = settings?.agentWorkflowToolEnabled === true;

    const directories = [];
    let permissions: ReturnType<typeof managedPermissionRules> = [];
    if (agentToolRuntime && (includeControl || includeSchedule || includeWeb || includeMemory || includeKnowledge || includeNotify || includeRender || includeImage || includeSecret || includeUsage || includeTerminal || includeActions || includeWorkflow)) {
      directories.push(await agentToolRuntime.materializePlugin({ includeControl, includeSchedule, includeWeb, includeMemory, includeKnowledge, includeNotify, includeRender, includeShare, includeImage, includeSecret, includeUsage, includeTerminal, includeActions, includeWorkflow }));
      permissions = managedPermissionRules({ includeWorkflow });
    }
    if (agentToolRuntime && limitFailoverRuntime && isLimitFailoverConfigured(settings)) {
      directories.push(await limitFailoverRuntime.materializePlugin());
    }
    directories.push(await materializeSessionTitlePlugin({ fsPromises, path, instanceDir }));
    const disabled = [
      ...DISABLED_BUILTIN_PLUGINS,
      ...(includeImage ? [BUILTIN_IMAGE_PLUGIN] : []),
      ...(agentToolRuntime && includeSchedule ? [BUILTIN_AUTOMATION_PLUGIN] : []),
    ];
    const authoring = await materializeAuthoringSkill({ fsPromises, instanceDir, openchamberVersion });
    const skills = [authoring.skillsRoot, ...await listExtensionSkillDirectories()];
    const extensionPlugins = await listExtensionPluginDirectories();
    return { disabled, directories, extensionPlugins, permissions, policies: readPluginDenials(), skills, commands: { [EXTENSION_AUTHORING_COMMAND]: authoring.command } };
  };

  let writing: Promise<void> | null = null;
  let writeAgain = false;
  const writeLatestConfigFile = () => {
    if (writing) {
      writeAgain = true;
      return writing;
    }
    writing = (async () => {
      do {
        writeAgain = false;
        await writeConfigFile(await materializeEnabledPlugins());
      } while (writeAgain);
    })().finally(() => {
      writing = null;
    });
    return writing;
  };

  const buildManagedChildEnv = async () => {
    const childEnv = agentToolRuntime ? agentToolRuntime.createChildEnv() : {};
    if (ownsConfigFile()) {
      await writeLatestConfigFile();
      return { ...childEnv, OPENCODE_CONFIG: filePath };
    }
    const enabled = await materializeEnabledPlugins();
    let content = env.OPENCODE_CONFIG_CONTENT;
    for (const directory of [...enabled.disabled, ...enabled.directories, ...enabled.extensionPlugins]) {
      content = appendManagedPlugin(content, directory, 'managed plugin');
    }
    if (enabled.policies.length > 0) content = appendManagedPolicies(content, enabled.policies);
    if (enabled.permissions.length > 0) content = appendManagedPermissions(content, enabled.permissions);
    content = appendManagedSkills(content, enabled.skills);
    for (const [name, command] of Object.entries(enabled.commands)) content = appendManagedCommand(content, name, command);
    return { ...childEnv, OPENCODE_CONFIG_CONTENT: content };
  };

  const syncExternalBridge = async () => (externalBridge ? externalBridge.syncBridge() : { active: false });
  const cleanupExternalBridge = async () => { await externalBridge?.cleanupBridge(); };
  const readExternalBridgeToken = () => externalBridge?.readActiveToken() ?? null;
  const registerExternalBridgeRoutes = (app: Application, isLoadedIn: (directory: string) => Promise<boolean | null>) => {
    if (!getOpenCodePluginDelivery) return;
    registerExternalPluginBridgeRoutes(app, {
      getBridge: () => externalBridge,
      getDelivery: getOpenCodePluginDelivery,
      isLoadedIn,
    });
  };

  const refreshManagedConfigFile = async () => {
    await externalBridge?.syncBridge().catch(() => {});
    if (!ownsConfigFile()) return { updated: false, reason: 'external-config' };
    await writeLatestConfigFile();
    return { updated: true };
  };

  return {
    filePath,
    ownsConfigFile,
    buildManagedChildEnv,
    refreshManagedConfigFile,
    syncExternalBridge,
    cleanupExternalBridge,
    readExternalBridgeToken,
    registerExternalBridgeRoutes,
  };
};
