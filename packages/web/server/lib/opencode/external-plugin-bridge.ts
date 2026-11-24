import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OpenCodeClient } from '@opencode/client';
import { createDynamicAgentToolPluginFragment } from '../agent-tool/external-plugin-fragment.js';
import { isLimitFailoverConfigured } from '../limit-failover/policy.js';
import { LIMIT_FAILOVER_PLUGIN_HELPERS, createLimitFailoverSetupCode } from '../limit-failover/runtime.js';
import { isSharingAvailable } from '../share-pages/relay-client.js';
import { isRecord } from '../shared/guards.js';
import { isString } from '../shared/object-guards.js';
import type { Application } from '../shared/http-contracts.js';
import type { OpenCodePluginDelivery } from '../guests/opencode-plugin.js';
import { waitForWorktreeRemoval } from '../git/service.js';
import { waitForLocationPlugins } from './location-plugins.js';
import { canonicalPluginPath } from './plugin-paths.js';
import { addGlobalPluginEntry, readGlobalPluginEntries, removeGlobalPluginEntry } from './plugins.js';
import { SESSION_TITLE_PLUGIN_HELPERS, createSessionTitleSetupCode } from './session-title-plugin.js';
import type { ManagedConfigSettings } from './managed-config-file.js';

export const EXTERNAL_PLUGIN_ID = 'openchamber';
export const EXTERNAL_BRIDGE_FILE_NAME = 'runtime-bridge.json';
export const EXTERNAL_PLUGIN_RPC = { rpcID: EXTERNAL_PLUGIN_ID, method: 'prove' } as const;
const PROOF_TIMEOUT_MS = 2_000;

const bridgeProof = (token: string, nonce: string) => createHmac('sha256', token).update(nonce).digest('base64url');

const MISSING_RPC_ERRORS = new Set(['rpc.unavailable', 'rpc.method_not_found']);

const isBridgePluginListed = (client: Pick<OpenCodeClient, 'plugin'>) => client.plugin
  .list(undefined, { signal: AbortSignal.timeout(PROOF_TIMEOUT_MS) })
  .then((response) => response.data.some((plugin) => plugin.id === EXTERNAL_PLUGIN_ID), () => null);

export const isBridgePluginLoaded = async (
  client: Pick<OpenCodeClient, 'plugin' | 'rpc'>,
  token: string,
): Promise<boolean | null> => {
  if (!(await waitForLocationPlugins(client))) return null;
  const nonce = randomBytes(18).toString('base64url');
  let output: unknown;
  try {
    ({ output } = await client.rpc.call(
      { rpcID: EXTERNAL_PLUGIN_RPC.rpcID, method: EXTERNAL_PLUGIN_RPC.method, input: { nonce } },
      { signal: AbortSignal.timeout(PROOF_TIMEOUT_MS) },
    ));
  } catch (error) {
    const rpcMissing = isRecord(error) && isString(error.type) && MISSING_RPC_ERRORS.has(error.type);
    if (!rpcMissing) return null;
    const reloading = await isBridgePluginListed(client);
    return reloading === false ? false : null;
  }
  if (!isRecord(output) || !isString(output.proof) || !output.proof) return false;
  const expected = Buffer.from(bridgeProof(token, nonce));
  const provided = Buffer.from(output.proof);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
};

export interface ExternalBridgeToolFlags {
  control: boolean;
  schedule: boolean;
  web: boolean;
  memory: boolean;
  knowledge: boolean;
  notify: boolean;
  render: boolean;
  share: boolean;
  image: boolean;
  secret: boolean;
  usage: boolean;
  terminal: boolean;
  actions: boolean;
  workflow: boolean;
}

export interface ExternalBridgeSkillEntry {
  id: string;
  name: string;
  description?: string;
  path: string;
  content: string;
}

export interface ExternalBridgeCommandEntry {
  name: string;
  description: string;
  template: string;
}

export interface ExternalBridgePayload {
  version: 1;
  pid: number;
  url: string;
  token: string;
  failoverEnabled: boolean;
  tools: ExternalBridgeToolFlags;
  skills: ExternalBridgeSkillEntry[];
  commands: ExternalBridgeCommandEntry[];
}

export interface ExternalPluginBridgeDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'mkdir' | 'writeFile' | 'rename' | 'rm' | 'readFile'> & Partial<Pick<typeof import('node:fs/promises'), 'readdir'>>;
  path: Pick<typeof import('node:path'), 'join' | 'basename'>;
  dataDir: string;
  pid?: number;
  readSettings: () => ManagedConfigSettings | null | Promise<ManagedConfigSettings | null>;
  ensureCredentials: () => { url: string; token: string } | null;
  isExternalLocal: () => boolean;
  collectSkillsAndCommands?: () => Promise<{ skills: ExternalBridgeSkillEntry[]; commands: ExternalBridgeCommandEntry[] }>;
}

const PLUGIN_PACKAGE_JSON = `${JSON.stringify({
  name: EXTERNAL_PLUGIN_ID,
  version: '0.0.0',
  private: true,
  type: 'module',
  exports: { '.': './index.js' },
}, null, 2)}\n`;

const resolveToolFlags = (settings: ManagedConfigSettings | null): ExternalBridgeToolFlags => {
  const render = settings?.agentRenderToolEnabled !== false;
  return {
    control: settings?.agentControlToolEnabled !== false,
    schedule: settings?.agentScheduleToolEnabled !== false,
    web: settings?.agentWebToolEnabled !== false,
    memory: settings?.agentMemoryToolEnabled === true,
    knowledge: settings?.agentKnowledgeToolEnabled !== false,
    notify: settings?.agentNotifyToolEnabled === true,
    render,
    share: render && isSharingAvailable(),
    image: settings?.agentImageToolEnabled === true,
    secret: settings?.agentSecretToolEnabled !== false,
    usage: settings?.agentUsageToolEnabled === true,
    terminal: settings?.agentTerminalToolEnabled === true,
    actions: settings?.agentActionsToolEnabled === true,
    workflow: settings?.agentWorkflowToolEnabled === true,
  };
};

export const createExternalBridgePluginSource = (bridgeFilePath: string) => {
  const agentTool = createDynamicAgentToolPluginFragment();

  return `import { createHmac } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const BRIDGE_FILE_PATH = ${JSON.stringify(bridgeFilePath)}
const BRIDGE_FILE_NAME = path.basename(BRIDGE_FILE_PATH)
const BRIDGE_DIR = path.dirname(BRIDGE_FILE_PATH)

const isPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

const exemptCallbackFromProxy = (endpoint) => {
  if (!endpoint || !URL.canParse(endpoint)) return
  const host = new URL(endpoint).hostname.replace(/^\\[|\\]$/g, "")
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const entries = (process.env[key] || "").split(",").map((entry) => entry.trim()).filter(Boolean)
    if (!entries.includes(host)) process.env[key] = [...entries, host].join(",")
  }
}

const resolveConnection = () => {
  // Managed OpenCode instances started by OpenChamber already receive dedicated
  // managed plugins and OPENCHAMBER_AGENT_TOOL_URL; stay dormant there so both
  // never register duplicate tools or hooks.
  if (process.env.OPENCHAMBER_AGENT_TOOL_URL) return null
  try {
    const raw = fs.readFileSync(BRIDGE_FILE_PATH, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    if (typeof parsed.url !== "string" || !URL.canParse(parsed.url)) return null
    if (typeof parsed.token !== "string" || !parsed.token) return null
    if (!isPidAlive(parsed.pid)) return null
    if (!parsed.tools || typeof parsed.tools !== "object") return null
    exemptCallbackFromProxy(parsed.url)
    return parsed
  } catch {
    return null
  }
}

const failoverCallback = () => {
  const connection = resolveConnection()
  if (!connection || !connection.failoverEnabled) return null
  return { url: new URL(LIMIT_FAILOVER_ROUTE, connection.url).href, token: connection.token }
}

const toolsFingerprint = (connection) => {
  if (!connection) return "inactive"
  return JSON.stringify(connection.tools)
}

const skillsFingerprint = (connection) => {
  if (!connection || !Array.isArray(connection.skills)) return "inactive"
  return JSON.stringify(connection.skills)
}

const commandsFingerprint = (connection) => {
  if (!connection || !Array.isArray(connection.commands)) return "inactive"
  return JSON.stringify(connection.commands)
}

${agentTool.helpers}
${LIMIT_FAILOVER_PLUGIN_HELPERS}
${SESSION_TITLE_PLUGIN_HELPERS}
export default {
  id: ${JSON.stringify(EXTERNAL_PLUGIN_ID)},
  setup: async (ctx) => {
    const initial = resolveConnection()
    let lastActive = Boolean(initial)
    let lastTools = toolsFingerprint(initial)
    let lastSkills = skillsFingerprint(initial)
    let lastCommands = commandsFingerprint(initial)
    let syncing = false
    let syncAgain = false

    let toolRegistration = null
    const installToolTransform = async () => {
      if (toolRegistration && typeof toolRegistration.dispose === "function") {
        await Promise.resolve(toolRegistration.dispose()).catch(() => {})
      }
      toolRegistration = await ctx.tool.transform((tools) => {
        const connection = resolveConnection()
        if (!connection) return
        const enabled = connection.tools
${agentTool.transformBody}
      })
    }

    const syncState = async () => {
      if (syncing) {
        syncAgain = true
        return
      }
      syncing = true
      try {
        do {
          syncAgain = false
          const current = resolveConnection()
          const nextActive = Boolean(current)
          const nextTools = toolsFingerprint(current)
          const nextSkills = skillsFingerprint(current)
          const nextCommands = commandsFingerprint(current)
          const toolsChanged = nextTools !== lastTools
          const skillsChanged = nextSkills !== lastSkills
          const commandsChanged = nextCommands !== lastCommands
          const activeChanged = nextActive !== lastActive
          lastActive = nextActive
          lastTools = nextTools
          lastSkills = nextSkills
          lastCommands = nextCommands
          if (toolsChanged) {
            if (toolRegistration && typeof toolRegistration.dispose === "function") {
              await installToolTransform().catch(() => {})
            } else {
              await ctx.tool.reload().catch(() => {})
            }
          }
          if (skillsChanged && ctx.skill?.reload) await ctx.skill.reload().catch(() => {})
          if (commandsChanged && ctx.command?.reload) await ctx.command.reload().catch(() => {})
          if (activeChanged) await ctx.agent.reload().catch(() => {})
        } while (syncAgain)
      } finally {
        syncing = false
      }
    }

    await installToolTransform()
    if (ctx.rpc?.register) {
      await ctx.rpc.register({
        id: ${JSON.stringify(EXTERNAL_PLUGIN_RPC.rpcID)},
        methods: {
          ${EXTERNAL_PLUGIN_RPC.method}: {
            input: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"] },
            output: { type: "object", properties: { proof: { type: "string" } }, required: ["proof"] },
          },
        },
        events: {},
      }, {
        ${EXTERNAL_PLUGIN_RPC.method}: async ({ nonce }) => {
          const connection = resolveConnection()
          if (!connection || typeof nonce !== "string" || !nonce) return { proof: "" }
          return { proof: createHmac("sha256", connection.token).update(nonce).digest("base64url") }
        },
      }).catch(() => {})
    }
    if (ctx.skill?.transform) {
      await ctx.skill.transform((editor) => {
        const connection = resolveConnection()
        if (!connection || !Array.isArray(connection.skills)) return
        for (const skill of connection.skills) editor.add(skill)
      })
    }
    if (ctx.command?.transform) {
      await ctx.command.transform((editor) => {
        const connection = resolveConnection()
        if (!connection || !Array.isArray(connection.commands)) return
        for (const cmd of connection.commands) {
          editor.add({
            name: cmd.name,
            description: cmd.description,
            execute: (input) => ctx.session.prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text: cmd.template.replaceAll("$ARGUMENTS", () => (input.prompt?.text ?? "").trim()),
              delivery: input.delivery,
            }),
          })
        }
      })
    }
${agentTool.hooksSetup}
${createLimitFailoverSetupCode({ callbackExpr: 'failoverCallback()' })}
${createSessionTitleSetupCode({ isActiveExpr: 'Boolean(resolveConnection())' })}

    let startupReorderTimer = null
    if (lastActive && toolRegistration && typeof toolRegistration.dispose === "function") {
      startupReorderTimer = setTimeout(() => {
        startupReorderTimer = null
        if (lastActive) void installToolTransform().catch(() => {})
      }, 150)
      if (typeof startupReorderTimer.unref === "function") startupReorderTimer.unref()
    }

    let debounceTimer = null
    const scheduleSync = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void syncState()
      }, 80)
      if (typeof debounceTimer.unref === "function") debounceTimer.unref()
    }

    let watcher = null
    try {
      watcher = fs.watch(BRIDGE_DIR, (_eventType, filename) => {
        if (!filename || String(filename).startsWith(BRIDGE_FILE_NAME)) scheduleSync()
      })
      watcher.on("error", () => {})
      if (typeof watcher.unref === "function") watcher.unref()
    } catch {}

    // Catch hard-killed OpenChamber processes that could not unlink the bridge file.
    const livenessTimer = setInterval(() => {
      if (lastActive) void syncState()
    }, 5000)
    if (typeof livenessTimer.unref === "function") livenessTimer.unref()

    return () => {
      if (startupReorderTimer) clearTimeout(startupReorderTimer)
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(livenessTimer)
      if (watcher) {
        try { watcher.close() } catch {}
      }
    }
  },
}
`;
};

const writeFileAtomic = async (
  fsPromises: ExternalPluginBridgeDependencies['fsPromises'],
  filePath: string,
  content: string,
) => {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    await fsPromises.writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
    await fsPromises.rename(tmp, filePath);
  } catch (error) {
    await fsPromises.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

const isLocalPidAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
};

const parseSkillMarkdown = (raw: string, fallbackId: string, filePath: string): ExternalBridgeSkillEntry => {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  let name = fallbackId;
  let description: string | undefined;
  let content = raw;
  if (match && match[1] !== undefined && match[2] !== undefined) {
    content = match[2];
    for (const line of match[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key === 'name' && value) name = value;
      if (key === 'description' && value) description = value;
    }
  }
  return description
    ? { id: fallbackId, name, description, path: filePath, content }
    : { id: fallbackId, name, path: filePath, content };
};

export const collectSkillEntriesFromRoots = async (
  fsPromises: Pick<typeof import('node:fs/promises'), 'readFile' | 'readdir'>,
  pathMod: Pick<typeof import('node:path'), 'join' | 'basename'>,
  roots: string[],
): Promise<ExternalBridgeSkillEntry[]> => {
  const entries: ExternalBridgeSkillEntry[] = [];
  const seen = new Set<string>();
  const tryReadSkill = async (dir: string) => {
    const filePath = pathMod.join(dir, 'SKILL.md');
    try {
      const raw = await fsPromises.readFile(filePath, 'utf8');
      const id = pathMod.basename(dir);
      if (seen.has(id)) return;
      seen.add(id);
      entries.push(parseSkillMarkdown(raw, id, filePath));
    } catch {
      return;
    }
  };
  for (const root of roots) {
    await tryReadSkill(root);
    const children = await fsPromises.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.isDirectory()) await tryReadSkill(pathMod.join(root, child.name));
    }
  }
  return entries;
};

export const createExternalPluginBridgeRuntime = ({
  fsPromises,
  path,
  dataDir,
  pid = process.pid,
  readSettings,
  ensureCredentials,
  isExternalLocal,
  collectSkillsAndCommands,
}: ExternalPluginBridgeDependencies) => {
  const pluginDirectory = path.join(dataDir, 'plugins', EXTERNAL_PLUGIN_ID);
  const bridgeFilePath = path.join(dataDir, EXTERNAL_BRIDGE_FILE_NAME);
  let materialized = false;
  let active = false;
  let activeToken: string | null = null;
  let stopped = false;

  const materializePlugin = async () => {
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await writeFileAtomic(fsPromises, path.join(pluginDirectory, 'package.json'), PLUGIN_PACKAGE_JSON);
    await writeFileAtomic(fsPromises, path.join(pluginDirectory, 'index.js'), createExternalBridgePluginSource(bridgeFilePath));
    materialized = true;
    return pluginDirectory;
  };

  const unlinkOwnBridgeFile = async () => {
    active = false;
    try {
      const raw = await fsPromises.readFile(bridgeFilePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && parsed.pid !== pid) {
        return;
      }
    } catch {
      await fsPromises.rm(bridgeFilePath, { force: true }).catch(() => {});
      return;
    }
    await fsPromises.rm(bridgeFilePath, { force: true }).catch(() => {});
  };

  const isOwnedByAnotherLiveInstance = async () => {
    try {
      const raw = await fsPromises.readFile(bridgeFilePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) && Number.isInteger(parsed.pid) && parsed.pid !== pid && isLocalPidAlive(Number(parsed.pid));
    } catch {
      return false;
    }
  };

  let syncing: Promise<{ active: boolean }> | null = null;
  let syncAgain = false;

  const performSync = async (): Promise<{ active: boolean }> => {
    if (stopped) {
      return { active: false };
    }
    if (!isExternalLocal()) {
      await unlinkOwnBridgeFile();
      return { active: false };
    }
    if (await isOwnedByAnotherLiveInstance()) {
      active = false;
      return { active: false };
    }
    const credentials = ensureCredentials();
    if (!credentials) {
      return { active: false };
    }
    if (!materialized) {
      await materializePlugin();
    }
    const settings = await Promise.resolve(readSettings()).catch(() => null);
    if (stopped) {
      return { active: false };
    }
    const extras = collectSkillsAndCommands
      ? await collectSkillsAndCommands().catch(() => ({ skills: [], commands: [] }))
      : { skills: [], commands: [] };
    if (stopped) {
      return { active: false };
    }
    const payload: ExternalBridgePayload = {
      version: 1,
      pid,
      url: credentials.url,
      token: credentials.token,
      failoverEnabled: isLimitFailoverConfigured(settings),
      tools: resolveToolFlags(settings),
      skills: extras.skills,
      commands: extras.commands,
    };
    await fsPromises.mkdir(dataDir, { recursive: true });
    if (stopped) {
      return { active: false };
    }
    await writeFileAtomic(fsPromises, bridgeFilePath, `${JSON.stringify(payload, null, 2)}\n`);
    active = true;
    activeToken = credentials.token;
    return { active: true };
  };

  const syncBridge = () => {
    if (stopped) {
      return Promise.resolve({ active: false });
    }
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      let result = { active: false };
      do {
        syncAgain = false;
        result = await performSync();
      } while (syncAgain && !stopped);
      return result;
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  };

  const cleanupBridge = async () => {
    stopped = true;
    syncAgain = false;
    if (syncing) {
      await syncing.catch(() => {});
    }
    await unlinkOwnBridgeFile();
  };

  return {
    pluginDirectory,
    bridgeFilePath,
    isActive: () => active,
    readActiveToken: () => (active ? activeToken : null),
    materializePlugin,
    syncBridge,
    cleanupBridge,
  };
};

export interface ExternalPluginBridgeRouteDependencies {
  getBridge: () => ReturnType<typeof createExternalPluginBridgeRuntime> | null;
  getDelivery: () => OpenCodePluginDelivery;
  isLoadedIn?: (directory: string) => Promise<boolean | null>;
  waitForRemoval?: (directory: string) => Promise<void>;
  readGlobalEntries?: typeof readGlobalPluginEntries;
  addGlobalEntry?: typeof addGlobalPluginEntry;
  removeGlobalEntry?: typeof removeGlobalPluginEntry;
}

export const registerExternalPluginBridgeRoutes = (
  app: Application,
  {
    getBridge,
    getDelivery,
    isLoadedIn = async () => null,
    waitForRemoval = waitForWorktreeRemoval,
    readGlobalEntries = readGlobalPluginEntries,
    addGlobalEntry = addGlobalPluginEntry,
    removeGlobalEntry = removeGlobalPluginEntry,
  }: ExternalPluginBridgeRouteDependencies,
) => {
  app.get('/api/config/external-opencode-plugin', async (req, res) => {
    const bridge = getBridge();
    const delivery = getDelivery();
    const pluginPath = bridge?.pluginDirectory ?? null;
    let globalConfigPath: string | null = null;
    let inGlobalConfig = false;
    if (pluginPath) {
      try {
        const entries = readGlobalEntries();
        globalConfigPath = entries.path;
        inGlobalConfig = entries.targets.includes(canonicalPluginPath(pluginPath));
      } catch {
        globalConfigPath = null;
        inGlobalConfig = false;
      }
    }
    const bridgeActive = bridge?.isActive() ?? false;
    const directory = isString(req.query?.directory) ? req.query.directory.trim() : '';
    const loadedInDirectory = delivery === 'none' && inGlobalConfig && bridgeActive && directory
      ? await waitForRemoval(directory).then(() => isLoadedIn(directory)).catch(() => null)
      : null;
    res.json({
      delivery,
      pluginPath,
      globalConfigPath,
      inGlobalConfig,
      bridgeActive,
      loadedInDirectory,
    });
  });

  app.post('/api/config/external-opencode-plugin/global-config', async (_req, res) => {
    try {
      const bridge = getBridge();
      if (!bridge) {
        return res.status(503).json({ error: 'unavailable', message: 'OpenChamber plugin bridge is not ready.' });
      }
      const delivery = getDelivery();
      if (delivery !== 'none' && delivery !== 'restart') {
        return res.status(409).json({ error: 'not-needed', delivery });
      }
      await bridge.materializePlugin();
      let written;
      try {
        written = addGlobalEntry(bridge.pluginDirectory);
      } catch (error) {
        if (isRecord(error) && error.code === 'CONFIG_INVALID') {
          return res.status(409).json({ error: 'config-invalid', message: isString(error.message) ? error.message : undefined });
        }
        throw error;
      }
      await bridge.syncBridge().catch(() => {});
      return res.json({
        path: written.path,
        added: written.added,
        pluginPath: bridge.pluginDirectory,
      });
    } catch (error) {
      console.error('Failed to add OpenChamber plugin to global OpenCode config:', error);
      return res.status(500).json({
        error: 'write-failed',
        message: (isRecord(error) && isString(error.message) ? error.message : undefined) ?? 'Failed to write the OpenCode config.',
      });
    }
  });

  app.delete('/api/config/external-opencode-plugin/global-config', (_req, res) => {
    try {
      const bridge = getBridge();
      if (!bridge) {
        return res.status(503).json({ error: 'unavailable', message: 'OpenChamber plugin bridge is not ready.' });
      }
      let result;
      try {
        result = removeGlobalEntry(bridge.pluginDirectory);
      } catch (error) {
        if (isRecord(error) && error.code === 'CONFIG_INVALID') {
          return res.status(409).json({ error: 'config-invalid', message: isString(error.message) ? error.message : undefined });
        }
        throw error;
      }
      return res.json({
        path: result.path,
        removed: result.removed,
      });
    } catch (error) {
      console.error('Failed to remove OpenChamber plugin from global OpenCode config:', error);
      return res.status(500).json({
        error: 'write-failed',
        message: (isRecord(error) && isString(error.message) ? error.message : undefined) ?? 'Failed to write the OpenCode config.',
      });
    }
  });
};
